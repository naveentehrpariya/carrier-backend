/**
 * End-to-end test for MIXED orders — one load run partly on our own truck and partly by an outside
 * carrier. Drives the real splitOrder / payment controllers against a throwaway local database.
 *
 *   mongod --dbpath /tmp/mixed --port 27099 --fork --logpath /tmp/mixed/log
 *   node scripts/test-mixed-order.js
 *
 * Uses TEST_DB_URL, default mongodb://127.0.0.1:27099/carrier_mixed_test. It REFUSES to run against
 * anything that is not localhost, because it drops the database when it finishes.
 *
 * What is being proven:
 *   - a split across our truck + a carrier produces a mixed order, with both cost sides correct
 *   - a pure outsourcing split and a pure fleet split behave EXACTLY as before
 *   - the cost columns add up and do not drift when the order is re-split
 *   - carrier payment is per leg, and the order's status is rolled up from the legs
 *   - a leg with neither a truck nor a carrier is refused
 *   - a carrier leg with no money anywhere is refused
 */
const assert = require('assert');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_mixed_test';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

// The audit trail writes a hash-chained row per change and is not what is under test here.
// Stub it before anything requires the controllers.
const path = require('path');
const loggerPath = require.resolve('../utils/activityLogger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true, exports: {
    logActivity: () => {},
    // The controllers destructure this at require time, so the stub itself has to stay constant;
    // a test observes what was logged through the mutable sink instead of swapping the function.
    logChange: (req, payload) => { if (global.__auditSink) global.__auditSink.push(payload); },
    CreatePaymentLog: async () => {},
    AUDIT_FIELDS: {},
  },
};

const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
// Registered so `.populate()` inside the listing controllers can resolve them. Mongoose looks a
// model up by name at populate time, and a name that was never required throws
// "Schema hasn't been registered" — which surfaces as an empty response, not as an obvious error.
require('../db/Trailer');
require('../db/Carrier');
require('../db/Customer');
require('../db/Users');
require('../db/OwnerOperator');
const { hasMultipleCarriers } = require('../utils/orderParty');
const tripController = require('../controllers/tripController');
const orderController = require('../controllers/orderController');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};
const near = (a, b, eps = 0.02) => assert.ok(Math.abs(Number(a) - Number(b)) < eps, `${a} != ${b}`);

const TENANT = 'test-tenant';
const oid = () => new mongoose.Types.ObjectId();

const USER = { _id: oid(), tenantId: TENANT, company: { _id: oid() }, is_admin: 1, permissions: [] };

/* Minimal req/res doubles. `res.done` resolves when the controller answers.
   This matters: utils/catchAsync does NOT return the promise it creates, so `await`ing a
   controller wrapped in it returns immediately and the assertions would run before the handler
   had touched the database. Wait on the response, not on the call. */
const mkRes = () => {
  const r = { statusCode: 200, body: null, err: null };
  let settle;
  r.done = new Promise((res) => { settle = res; });
  const answer = (b) => { r.body = b; settle(b); return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = answer;
  r.send = answer;
  r.fail = (e) => { r.err = e; settle(null); };
  return r;
};

// Give a handler a moment to answer, so a hang is reported as a hang rather than as a null body.
const answered = (res, ms = 8000) => Promise.race([
  res.done,
  new Promise((_, rej) => setTimeout(() => rej(new Error('controller never answered')), ms)),
]);

let COMPANY_TRUCK, OWNER_TRUCK, OWNER_ID, CARRIER_A, CARRIER_B, CUSTOMER;

async function seed() {
  const Carrier = require('../db/Carrier');
  OWNER_ID = oid();
  const ca = await Carrier.create({ tenantId: TENANT, name: 'Carrier A', mc_code: 'A1', phone: '1', email: 'a@t.test', address: 'a', city: 'a', state: 'a', country: 'a', zipcode: '1', location: 'A City, ST' });
  const cb = await Carrier.create({ tenantId: TENANT, name: 'Carrier B', mc_code: 'B1', phone: '2', email: 'b@t.test', address: 'b', city: 'b', state: 'b', country: 'b', zipcode: '2', location: 'B City, ST' });
  CARRIER_A = ca._id;
  CARRIER_B = cb._id;
  CUSTOMER = oid();
  COMPANY_TRUCK = await Truck.create({ tenantId: TENANT, plateNumber: 'CO-1', ownerOperated: false });
  OWNER_TRUCK = await Truck.create({ tenantId: TENANT, plateNumber: 'OO-1', ownerOperated: true, ownerOperator: OWNER_ID });
}

// 321.8688 km = 200 miles, so each of two equal legs is 100 miles.
const ORDER_KM = 321.8688;

async function makeOrder(over = {}) {
  return Order.create({
    tenantId: TENANT,
    customer: CUSTOMER,
    serial_no: Math.floor(Math.random() * 1e6),
    company_name: 'Test Co',
    total_amount: 3000,
    input_total_amount: 3000,
    input_currency: 'usd',
    revenue_currency: 'usd',
    fx_to_usd: 1,
    totalDistance: ORDER_KM,
    created_by: USER._id,
    ...over,
  });
}

const seg = (over = {}) => ({
  start_stop_index: 0, end_stop_index: 1,
  miles: 100, totalDistance: 100,
  ...over,
});

const split = async (order, segments) => {
  const res = mkRes();
  tripController.splitOrder({ user: USER, body: { orderId: String(order._id), segments } }, res);
  await answered(res);
  return res;
};

async function run() {
  await mongoose.connect(URI, { autoIndex: true });
  await mongoose.connection.dropDatabase();
  await seed();

  console.log('\nmixed orders — end to end\n');

  await t('our truck + a carrier makes a MIXED order with both cost sides', async () => {
    const order = await makeOrder({
      order_type: 'regular',
      settle_amount: 0, input_settle_amount: 0,
      carrier_amount: 1200, input_carrier_amount: 1200,
    });
    const res = await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, truck: COMPANY_TRUCK._id }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_A }),
    ]);
    assert.ok(res.body?.status, `split refused: ${res.body?.message}`);

    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.isMixedType, true, 'order must be flagged mixed');
    assert.deepStrictEqual(after.order_parties, ['company', 'carrier']);
    assert.strictEqual(after.order_type, 'regular', 'a mixed order is stamped regular');
    near(after.carrier_amount, 1200);
    near(after.settle_amount, 0, 0.001);
    near(after.cost_amount, 1200);
    assert.strictEqual(String(after.carrier), String(CARRIER_A));
  });

  await t('owner truck + carrier: each side is paid its own pot, no cross-contamination', async () => {
    const order = await makeOrder({
      order_type: 'regular',
      settle_amount: 800, input_settle_amount: 800,
      carrier_amount: 1000, input_carrier_amount: 1000,
    });
    const res = await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, truck: OWNER_TRUCK._id }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_A }),
    ]);
    assert.ok(res.body?.status, `split refused: ${res.body?.message}`);

    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.isMixedType, true);
    assert.deepStrictEqual(after.order_parties, ['owner', 'carrier']);
    // The owner keeps the settle pot; the carrier keeps the carrier pot. The settlement must NOT
    // have been mirrored into carrier_amount — that mirror is what would have paid the carrier the
    // owner's money on the next read.
    near(after.settle_amount, 800);
    near(after.carrier_amount, 1000);
    near(after.cost_amount, 1800);
    assert.strictEqual(String(after.ownerOperator), String(OWNER_ID));
  });

  await t('two carriers split the pot by miles and the order carries both', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 1000, input_carrier_amount: 1000,
    });
    const res = await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B }),
    ]);
    assert.ok(res.body?.status, `split refused: ${res.body?.message}`);

    const after = await Order.findById(order._id).lean();
    assert.strictEqual(hasMultipleCarriers(after), true, 'two carriers must be readable from `carriers`');
    assert.strictEqual(after.isMixedType, false, 'all legs are carrier legs — not mixed TYPE');
    assert.strictEqual(after.order_type, 'outsourcing');
    assert.strictEqual(after.carrier, null, 'no single carrier owns the order');
    assert.strictEqual(after.carriers.length, 2);
    near(after.carrier_amount, 1000);

    const legs = await Trip.find({ order: order._id }).sort({ trip_no: 1 }).lean();
    near(legs[0].carrier_amount, 500);
    near(legs[1].carrier_amount, 500);
  });

  await t('re-splitting the same order does not move the money (frozen legs)', async () => {
    const order = await makeOrder({
      order_type: 'regular',
      settle_amount: 900, input_settle_amount: 900,
      carrier_amount: 1100, input_carrier_amount: 1100,
    });
    const segs = [
      seg({ start_stop_index: 0, end_stop_index: 1, truck: OWNER_TRUCK._id }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_A }),
    ];
    await split(order, segs);
    const first = await Order.findById(order._id).lean();

    const reload = await Order.findById(order._id).lean();
    await split(reload, segs);
    const second = await Order.findById(order._id).lean();

    near(second.carrier_amount, first.carrier_amount, 0.01);
    near(second.settle_amount, first.settle_amount, 0.01);
    near(second.cost_amount, first.cost_amount, 0.01);
  });

  await t('a pure outsourcing split behaves exactly as before', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 1500, input_carrier_amount: 1500,
    });
    const res = await split(order, [seg({ carrier: CARRIER_A })]);
    assert.ok(res.body?.status, `split refused: ${res.body?.message}`);
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.order_type, 'outsourcing');
    assert.strictEqual(after.isMixedType, false);
    near(after.carrier_amount, 1500, 0.001);
    near(after.settle_amount, 0, 0.001);
  });

  await t('a pure fleet split behaves exactly as before', async () => {
    const order = await makeOrder({
      order_type: 'regular',
      settle_amount: 700, input_settle_amount: 700,
    });
    const res = await split(order, [seg({ truck: OWNER_TRUCK._id })]);
    assert.ok(res.body?.status, `split refused: ${res.body?.message}`);
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.order_type, 'regular');
    assert.strictEqual(after.isMixedType, false);
    assert.strictEqual(after.isOwnerOperatedTruck, true);
    near(after.settle_amount, 700, 0.001);
    // The legacy mirror still applies on a fleet-only order — reports read it as the cost.
    near(after.carrier_amount, 700, 0.001);
    near(after.cost_amount, 700, 0.001);
  });

  console.log('\nguards\n');

  await t('a leg with neither truck nor carrier is refused', async () => {
    const order = await makeOrder({ order_type: 'regular', settle_amount: 500, input_settle_amount: 500 });
    const res = await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, truck: COMPANY_TRUCK._id }),
      seg({ start_stop_index: 1, end_stop_index: 2 }),
    ]);
    assert.strictEqual(res.body?.status, false);
    assert.strictEqual(res.body?.code, 'leg_has_no_party');
  });

  await t('a carrier leg with no money anywhere is refused', async () => {
    const order = await makeOrder({
      order_type: 'regular', settle_amount: 500, input_settle_amount: 500,
      carrier_amount: 0, input_carrier_amount: 0,
    });
    const res = await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, truck: COMPANY_TRUCK._id }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_A }),
    ]);
    assert.strictEqual(res.body?.status, false);
    assert.strictEqual(res.body?.code, 'carrier_leg_unpaid');
  });

  await t('leg carrier amounts above the order amount are refused', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 500, input_carrier_amount: 500,
    });
    const res = await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A, carrier_amount: 400 }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B, carrier_amount: 400 }),
    ]);
    assert.strictEqual(res.body?.status, false);
    assert.strictEqual(res.body?.code, 'carrier_over_allocated');
  });

  console.log('\ncarrier payment per leg\n');

  const payReq = (orderId, body) => ({
    user: USER, params: { id: String(orderId), type: 'carrier' }, body,
    tenantId: TENANT, allowedOrderTypes: [],
  });

  await t('paying ONE leg leaves the order partial, not paid', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 1000, input_carrier_amount: 1000,
    });
    await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B }),
    ]);
    const legs = await Trip.find({ order: order._id }).sort({ trip_no: 1 }).lean();

    const res = mkRes();
    orderController.updateOrderPaymentStatus(
      payReq(order._id, { status: 'paid', method: 'wire', tripId: String(legs[0]._id) }), res, (e) => res.fail(e));
    await answered(res);
    assert.ok(res.body?.status, `payment refused: ${res.body?.message || res.err?.message || res.err}`);

    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.carrier_payment_status, 'partial', 'one of two carriers paid = partial');
    const legsAfter = await Trip.find({ order: order._id }).sort({ trip_no: 1 }).lean();
    assert.strictEqual(legsAfter[0].carrier_payment_status, 'paid');
    assert.strictEqual(legsAfter[1].carrier_payment_status, 'pending');
  });

  await t('paying the second leg rolls the order up to paid', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 1000, input_carrier_amount: 1000,
    });
    await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B }),
    ]);
    const legs = await Trip.find({ order: order._id }).sort({ trip_no: 1 }).lean();
    for (const l of legs) {
      const res = mkRes();
      orderController.updateOrderPaymentStatus(
        payReq(order._id, { status: 'paid', method: 'wire', tripId: String(l._id) }), res, (e) => res.fail(e));
      await answered(res);
      assert.ok(res.body?.status, `payment refused: ${res.body?.message || res.err?.message}`);
    }
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.carrier_payment_status, 'paid');
  });

  await t('paying with no tripId pays every carrier leg (the old single-carrier flow)', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    const res = mkRes();
    orderController.updateOrderPaymentStatus(
      payReq(order._id, { status: 'paid', method: 'cheque' }), res, (e) => res.fail(e));
    await answered(res);
    assert.ok(res.body?.status, `payment refused: ${res.body?.message || res.err?.message}`);
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.carrier_payment_status, 'paid');
    const legs = await Trip.find({ order: order._id }).lean();
    assert.ok(legs.every((l) => l.carrier_payment_status === 'paid'), 'every carrier leg must be paid');
  });

  await t('paying a leg that is not on the order is refused', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    const res = mkRes();
    orderController.updateOrderPaymentStatus(
      payReq(order._id, { status: 'paid', method: 'wire', tripId: String(oid()) }), res, (e) => res.fail(e));
    await answered(res);
    assert.strictEqual(res.body?.status, false);
    assert.strictEqual(res.body?.code, 'carrier_leg_not_found');
  });



  await t('an order with NO legs keeps its carrier columns and gets a matching cost', async () => {
    // 374 of 776 production orders carry no leg at all. "No carrier leg" and "no legs to read" are
    // indistinguishable to the carrier state, but they mean opposite things — so clearing the
    // carrier here fired on half the book: `carrier: null` on an order still stamped `outsourcing`
    // fails the schema's conditional `required`, the non-fatal stamp swallowed it, and the order
    // was left with cost_amount 0 beside carrier_amount 900 while the user was told it saved.
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await Trip.deleteMany({ order: order._id });

    const res = mkRes();
    orderController.update_order(
      { user: USER, params: { id: String(order._id) }, body: { notes: 'a note' },
        tenantId: TENANT, allowedOrderTypes: [] }, res, (e) => res.fail(e));
    await answered(res);
    assert.ok(res.body?.status, `update refused: ${res.body?.message || res.err?.message}`);

    const after = await Order.findById(order._id).lean();
    assert.strictEqual(String(after.carrier), String(CARRIER_A), 'the carrier must not be cleared');
    near(after.carrier_amount, 900, 0.001);
    near(after.cost_amount, 900, 0.001, 'cost must agree with the carrier column, not be zeroed');
  });

  await t('a fleet-only re-split DOES clear the stale carrier', async () => {
    // The other side of the same rule: once there ARE legs and none of them is a carrier's, the
    // carrier really is gone and the stale id and cost must not linger on the order.
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    // A COMPANY truck deliberately: an owner leg would need a settle amount, and that guard is a
    // different rule being tested elsewhere.
    const res = await split(await Order.findById(order._id), [seg({ truck: COMPANY_TRUCK._id, driver: oid() })]);
    assert.ok(res.body?.status, `re-split refused: ${res.body?.message}`);

    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.order_type, 'regular', 'the type follows the legs');
    assert.strictEqual(after.carrier, null, 'the stale carrier is cleared');
    near(after.input_carrier_amount, 0, 0.001);
  });


  await t('a re-split never leaves the order claiming a payment its legs deny', async () => {
    // Only the payment endpoint used to roll this up, so re-splitting an order left it saying
    // `paid` while every one of its new legs said `pending` — and the carrier payment reports read
    // the order, not the legs.
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 1000, input_carrier_amount: 1000,
    });
    await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B }),
    ]);
    let legs = await Trip.find({ order: order._id }).sort({ trip_no: 1 }).lean();

    // Pay BOTH so the order rolls up to paid.
    for (const l of legs) {
      const res = mkRes();
      orderController.updateOrderPaymentStatus(
        payReq(order._id, { status: 'paid', method: 'wire', tripId: String(l._id) }), res, (e) => res.fail(e));
      await answered(res);
    }
    assert.strictEqual((await Order.findById(order._id).lean()).carrier_payment_status, 'paid');

    // Re-split with the SAME carriers — allowed, and the paid state must survive.
    const again = await split(await Order.findById(order._id), [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B }),
    ]);
    assert.ok(again.body?.status, `re-split refused: ${again.body?.message}`);

    legs = await Trip.find({ order: order._id, deletedAt: null }).lean();
    assert.ok(legs.every((l) => l.carrier_payment_status === 'paid'),
      'a carrier already paid must not come back as unpaid');
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.carrier_payment_status, 'paid', 'and the order must agree with them');
  });

  await t('legs that come back unpaid drag the order back to pending', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 1000, input_carrier_amount: 1000,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    // Mark the ORDER paid without touching the legs — the state a re-split used to leave behind.
    await Order.updateOne({ _id: order._id }, { $set: { carrier_payment_status: 'paid' } });

    const again = await split(await Order.findById(order._id), [seg({ carrier: CARRIER_A })]);
    assert.ok(again.body?.status, `re-split refused: ${again.body?.message}`);
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.carrier_payment_status, 'pending',
      'the order follows its legs, and these legs have not been paid');
  });

  console.log('\nleg party lock\n');

  const DriverSalary = require('../db/DriverSalary');

  await t('changing who runs a leg is refused once a driver payslip exists', async () => {
    const order = await makeOrder({
      order_type: 'regular', settle_amount: 600, input_settle_amount: 600,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [seg({ truck: OWNER_TRUCK._id })]);

    // A payslip built from this order's legs.
    await DriverSalary.create({
      tenantId: TENANT, driver: oid(), month: 9, year: 2026,
      orderBreakdown: [{ order: order._id }],
    });

    const res = await split(await Order.findById(order._id), [seg({ carrier: CARRIER_A })]);
    assert.strictEqual(res.body?.status, false);
    assert.strictEqual(res.body?.code, 'leg_party_locked');
    assert.ok(res.body.blockers.some((b) => /payslip/i.test(b)), 'must name the payslip');
  });

  await t('changing who runs a leg is refused once a carrier leg is paid', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    await Trip.updateMany({ order: order._id }, { $set: { carrier_payment_status: 'paid' } });

    const res = await split(await Order.findById(order._id), [seg({ carrier: CARRIER_B })]);
    assert.strictEqual(res.body?.status, false);
    assert.strictEqual(res.body?.code, 'leg_party_locked');
  });

  await t('re-saving the SAME parties is never blocked, even when paid', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    await Trip.updateMany({ order: order._id }, { $set: { carrier_payment_status: 'paid' } });

    // Same party, different notes — an edit that changes nothing about who is paid must go through.
    const res = await split(await Order.findById(order._id), [seg({ carrier: CARRIER_A, notes: 'call ahead' })]);
    assert.ok(res.body?.status, `refused a harmless re-save: ${res.body?.message}`);
  });

  await t('nothing paid yet: the party can still be changed freely', async () => {
    const order = await makeOrder({
      order_type: 'regular', settle_amount: 600, input_settle_amount: 600,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [seg({ truck: OWNER_TRUCK._id })]);
    const res = await split(await Order.findById(order._id), [seg({ carrier: CARRIER_A })]);
    assert.ok(res.body?.status, `refused an unpaid change: ${res.body?.message}`);
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.order_type, 'outsourcing');
  });

  console.log('\nper-leg rate confirmation\n');

  const { buildRateConHtml, buildRateConNo, legStops, legAmount, legLineItems } = require('../utils/rateConHtml');

  await t('the document shows only THIS leg\'s stops', async () => {
    const order = {
      serial_no: 42,
      shipping_details: [{ locations: [
        { location: 'A', city: 'Toronto', type: 'pickup' },
        { location: 'B', city: 'Windsor', type: 'relay' },
        { location: 'C', city: 'Detroit', type: 'delivery' },
      ] }],
    };
    const stops = legStops(order, { start_stop_index: 1, end_stop_index: 2 });
    assert.deepStrictEqual(stops.map((s) => s.city), ['Windsor', 'Detroit']);
  });

  await t('out-of-range leg indexes are clamped, never left empty', async () => {
    const order = { shipping_details: [{ locations: [{ city: 'A' }, { city: 'B' }] }] };
    assert.strictEqual(legStops(order, { start_stop_index: 5, end_stop_index: 9 }).length, 1);
    assert.strictEqual(legStops(order, { start_stop_index: 3, end_stop_index: 0 }).length, 2, 'reversed indexes are ordered');
  });

  await t('the rate is the LEG amount in the currency it was agreed in', async () => {
    const order = { input_currency: 'cad', input_carrier_amount: 2000, carrier_amount: 1422.35 };
    const a = legAmount(order, { carrier_amount: 900 });
    assert.strictEqual(a.currency, 'CAD');
    near(a.amount, 900, 0.001);
    assert.strictEqual(a.fromLeg, true);
    // A leg with no typed amount falls back to the order's — the single-carrier case.
    const b = legAmount(order, {});
    near(b.amount, 2000, 0.001);
    assert.strictEqual(b.fromLeg, false);
  });

  await t('a zero leg amount is honoured, not treated as absent', async () => {
    const order = { input_currency: 'usd', input_carrier_amount: 1000, carrier_amount: 1000 };
    const a = legAmount(order, { carrier_amount: 0 });
    near(a.amount, 0, 0.001);
    assert.strictEqual(a.fromLeg, true);
  });


  await t('a single-carrier rate confirmation prints the LINE ITEMS, not one lump sum', async () => {
    // `Number(null) === 0` and `Number.isFinite(0)` is true, so a null leg amount read as "this leg
    // carries its own price" — and every rate confirmation printed one "Agreed rate for this leg"
    // line instead of the breakdown the carrier was actually quoted.
    const order = {
      order_type: 'outsourcing', carrier_amount: 1000, input_carrier_amount: 1000, input_currency: 'usd',
      carrier_revenue_items: [
        { revenue_item: 'Line Haul', rate: 900, quantity: 1 },
        { revenue_item: 'Fuel Surcharge', rate: 100, quantity: 1 },
      ],
    };
    const rows = legLineItems(order, { carrier_amount: null }, 1000);
    assert.strictEqual(rows.length, 2, 'both quoted lines must reach the document');
    assert.deepStrictEqual(rows.map((r) => r.label), ['Line Haul', 'Fuel Surcharge']);
    near(rows.reduce((a, r) => a + r.value, 0), 1000, 0.01);
  });

  await t('a leg with its own frozen share does NOT print another carrier\'s lines', async () => {
    const order = {
      order_type: 'outsourcing', carrier_amount: 1000, input_carrier_amount: 1000, input_currency: 'usd',
      carrier_revenue_items: [{ revenue_item: 'Line Haul', rate: 1000, quantity: 1 }],
    };
    const rows = legLineItems(order, { carrier_amount: 500 }, 500);
    assert.strictEqual(rows.length, 1);
    near(rows[0].value, 500, 0.01, 'the leg\'s own share, not the order total');
    assert.ok(!/Line Haul/.test(rows[0].label), 'the order-level line belongs to the whole cost');
  });

  await t('the number is deterministic and names the leg', async () => {
    const order = { serial_no: 1013 };
    const company = { order_prefix: 'CMC' };
    const a = buildRateConNo({ order, trip: { trip_no: 2 }, company, tenantId: 't' });
    const b = buildRateConNo({ order, trip: { trip_no: 2 }, company, tenantId: 't' });
    assert.strictEqual(a, b, 'the same leg must always carry the same number');
    assert.strictEqual(a, 'CMC-1013-L2');
  });

  await t('the order number uses the tenant\'s own prefix, never a hardcoded one', async () => {
    const html = buildRateConHtml({
      order: { serial_no: 7, shipping_details: [] },
      trip: { trip_no: 1, carrier: { name: 'Acme' }, carrier_amount: 100 },
      company: { order_prefix: 'XYZ', name: 'Other Co' },
      rateConNo: 'XYZ-7-L1', tenantId: 't',
    });
    assert.ok(html.includes('XYZ-7'), 'must print the configured prefix');
    assert.ok(!html.includes('CMC'), 'must not leak another tenant\'s prefix');
  });

  await t('a partial order tells the carrier it is one leg of several', async () => {
    const base = {
      order: { serial_no: 7, shipping_details: [] },
      trip: { trip_no: 2, carrier: { name: 'Acme' }, carrier_amount: 100 },
      company: { name: 'Co' }, rateConNo: 'X', tenantId: 't',
    };
    assert.ok(buildRateConHtml({ ...base, isPartial: true }).includes('Part of a larger order'));
    assert.ok(!buildRateConHtml({ ...base, isPartial: false }).includes('Part of a larger order'));
  });

  await t('stops are labelled from the CARRIER\'s point of view, never "relay"', async () => {
    // A leg often starts at a relay — our word for handing a load between our own legs. The carrier
    // is not part of that; the first stop on their leg is simply where they collect.
    const html = buildRateConHtml({
      order: { serial_no: 1, shipping_details: [{ locations: [
        { city: 'Windsor', type: 'relay' },
        { city: 'Detroit', type: 'delivery' },
      ] }] },
      trip: { trip_no: 2, start_stop_index: 0, end_stop_index: 1, carrier: { name: 'A' }, carrier_amount: 1 },
      company: {}, rateConNo: 'X', tenantId: 't',
    });
    assert.ok(!/RELAY/.test(html), 'internal vocabulary must not reach a carrier document');
    assert.ok(/PICKUP/.test(html) && /DELIVERY/.test(html));
  });

  await t('the document renders with no stops and no line items without throwing', async () => {
    const html = buildRateConHtml({
      order: { serial_no: 1, shipping_details: [] },
      trip: { trip_no: 1, carrier: {} },
      company: {}, rateConNo: 'X', tenantId: 't',
    });
    assert.ok(html.includes('Rate Confirmation'));
    assert.ok(html.includes('No stops recorded for this leg.'));
  });


  console.log('\ncarrier visibility\n');

  const listOrders = async (query) => {
    const res = mkRes();
    orderController.order_listing(
      { user: USER, query, tenantId: TENANT, allowedOrderTypes: [] }, res, (e) => res.fail(e));
    await answered(res);
    return res;
  };

  await t('BOTH carriers of a split order find it in their own order list', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 1000, input_carrier_amount: 1000,
    });
    await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B }),
    ]);
    // The order now has `carrier: null` and both ids in `carriers` — matching the single column
    // alone would drop it out of BOTH carriers' lists, so each carrier loses sight of their own work.
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.carrier, null, 'precondition: no single carrier column');

    for (const [label, id] of [['A', CARRIER_A], ['B', CARRIER_B]]) {
      const res = await listOrders({ carrier_id: String(id) });
      const ids = (res.body?.orders || []).map((o) => String(o._id));
      assert.ok(ids.includes(String(order._id)), `carrier ${label} cannot see their own order`);
    }
  });

  await t('a single-carrier order is still found by that carrier', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 800, input_carrier_amount: 800,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    const res = await listOrders({ carrier_id: String(CARRIER_A) });
    const ids = (res.body?.orders || []).map((o) => String(o._id));
    assert.ok(ids.includes(String(order._id)));
  });

  await t('filtering by a carrier never returns another carrier\'s order', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 800, input_carrier_amount: 800,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    const res = await listOrders({ carrier_id: String(CARRIER_B) });
    const ids = (res.body?.orders || []).map((o) => String(o._id));
    assert.ok(!ids.includes(String(order._id)), 'carrier B must not see carrier A\'s order');
  });

  await t('the carrier filter does not resurrect deleted orders', async () => {
    // The filter is an $or. Assigning it to queryObj.$or would overwrite the soft-delete $or and
    // start returning deleted orders — the exact bug CLAUDE.md documents for order search.
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 800, input_carrier_amount: 800,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    await Order.updateOne({ _id: order._id }, { $set: { deletedAt: new Date() } });
    const res = await listOrders({ carrier_id: String(CARRIER_A) });
    const ids = (res.body?.orders || []).map((o) => String(o._id));
    assert.ok(!ids.includes(String(order._id)), 'a deleted order must stay deleted');
  });




  await t('a fleet order gaining its first carrier leg does NOT pay the owner\'s settlement to the carrier', async () => {
    /* Found in the browser, not by these tests. On a fleet-only order the owner's settlement is
       MIRRORED into `carrier_amount`. Guarding the write side was not enough: the value written
       before the carrier leg existed was still there to be read, and `resolveCarrierPot` fell back
       to it — so a 1,200 settlement plus a carrier leg came out as a 1,200 carrier cost and a
       2,400 order cost, with the carrier paid the owner's money. */
    const order = await makeOrder({
      order_type: 'regular',
      settle_amount: 1200, input_settle_amount: 1200,
      // The mirror, exactly as create_order writes it on a fleet-only order.
      carrier_amount: 1200, input_carrier_amount: 0,
    });
    await split(order, [seg({ start_stop_index: 0, end_stop_index: 1, truck: OWNER_TRUCK._id })]);

    // Now hand the second leg to a carrier, with NO carrier amount anywhere.
    const res = await split(await Order.findById(order._id), [
      seg({ start_stop_index: 0, end_stop_index: 1, truck: OWNER_TRUCK._id }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_A }),
    ]);
    assert.strictEqual(res.body?.status, false, 'the app must ASK, not invent the carrier cost');
    assert.strictEqual(res.body?.code, 'carrier_leg_unpaid');

    const after = await Order.findById(order._id).lean();
    near(after.settle_amount, 1200, 0.01, 'the settlement must be untouched');
  });

  await t('the same split with a typed carrier amount adds both sides into cost_amount', async () => {
    const order = await makeOrder({
      order_type: 'regular',
      settle_amount: 1200, input_settle_amount: 1200,
      carrier_amount: 1200, input_carrier_amount: 0,
    });
    const res = await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, truck: OWNER_TRUCK._id }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_A, carrier_amount: 1000 }),
    ]);
    assert.ok(res.body?.status, `split refused: ${res.body?.message}`);

    const after = await Order.findById(order._id).lean();
    near(after.settle_amount, 1200, 0.01);
    near(after.carrier_amount, 1000, 0.01, 'the carrier is paid what was typed for the carrier');
    near(after.cost_amount, 2200, 0.01, 'the order cost is both sides, not one column');
    assert.strictEqual(after.isMixedType, true);
  });

  console.log('\nupdateTrip re-reads the order\n');

  const patchLeg = async (tripId, body) => {
    const res = mkRes();
    tripController.updateTrip(
      { user: USER, params: { tripId: String(tripId) }, body, tenantId: TENANT }, res);
    await answered(res);
    return res;
  };

  await t('moving a leg to a carrier re-reads the order, not just the leg', async () => {
    // updateTrip used to write the leg and stop, leaving the order claiming the old type, the old
    // carrier and the old cost — and everything that reads the order then answered from a shape the
    // legs no longer had.
    const order = await makeOrder({
      order_type: 'regular', settle_amount: 0, input_settle_amount: 0,
      carrier_amount: 700, input_carrier_amount: 700,
    });
    await split(order, [seg({ truck: COMPANY_TRUCK._id, driver: oid() })]);
    const before = await Order.findById(order._id).lean();
    assert.strictEqual(before.order_type, 'regular', 'precondition');

    const legs = await Trip.find({ order: order._id }).lean();
    const res = await patchLeg(legs[0]._id, { carrier: String(CARRIER_A), truck: null });
    assert.ok(res.body?.status, `leg update refused: ${res.body?.message}`);

    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.order_type, 'outsourcing', 'the type must follow the leg');
    assert.deepStrictEqual(after.order_parties, ['carrier']);
    assert.strictEqual(String(after.carrier), String(CARRIER_A));
    assert.strictEqual(after.truck, null, 'the order no longer runs on our equipment');
  });

  await t('a note-only leg edit does NOT rewrite the order', async () => {
    // Re-deriving on an edit that cannot change who runs the leg would rewrite the owner ledger for
    // nothing.
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 800, input_carrier_amount: 800,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    const legs = await Trip.find({ order: order._id }).lean();
    const snapshot = await Order.findById(order._id).lean();

    const res = await patchLeg(legs[0]._id, { notes: 'call ahead' });
    assert.ok(res.body?.status, `note update refused: ${res.body?.message}`);

    const after = await Order.findById(order._id).lean();
    near(after.cost_amount, snapshot.cost_amount, 0.001);
    assert.strictEqual(String(after.carrier), String(snapshot.carrier));
  });

  await t('a leg edit cannot set fields it has no business setting', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 800, input_carrier_amount: 800,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    const legs = await Trip.find({ order: order._id }).lean();
    const strayOrder = oid();

    await patchLeg(legs[0]._id, {
      notes: 'x', order: String(strayOrder), tenantId: 'someone-else',
      carrier_payment_status: 'paid',
    });
    const leg = await Trip.findById(legs[0]._id).lean();
    assert.strictEqual(String(leg.order), String(order._id), 'the leg must not be moved to another order');
    assert.strictEqual(leg.tenantId, TENANT, 'the tenant must not be rewritten');
    assert.strictEqual(String(leg.carrier_payment_status || 'pending'), 'pending',
      'a leg edit must not mark a carrier paid');
  });

  await t('moving a leg\'s party is refused once it has been paid against', async () => {
    // The same lock splitOrder enforces. Without it this endpoint was the way around it.
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 800, input_carrier_amount: 800,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    await Trip.updateMany({ order: order._id }, { $set: { carrier_payment_status: 'paid' } });
    const legs = await Trip.find({ order: order._id }).lean();

    const res = await patchLeg(legs[0]._id, { carrier: String(CARRIER_B) });
    assert.strictEqual(res.statusCode, 409, `expected 409, got ${res.statusCode}`);
    assert.strictEqual(res.body?.code, 'leg_party_locked');

    const leg = await Trip.findById(legs[0]._id).lean();
    assert.strictEqual(String(leg.carrier), String(CARRIER_A), 'the leg must not have moved');
  });

  await t('a soft-deleted leg is not editable', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 800, input_carrier_amount: 800,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    const legs = await Trip.find({ order: order._id }).lean();
    await Trip.updateOne({ _id: legs[0]._id }, { $set: { deletedAt: new Date() } });

    const res = await patchLeg(legs[0]._id, { notes: 'edit a removed leg' });
    assert.strictEqual(res.statusCode, 404, `expected 404, got ${res.statusCode}`);
  });

  console.log('\nreview fixes\n');

  await t('a Mongo operator sent as tripId is refused, not executed', async () => {
    // req.body is JSON, so `tripId` can be an OBJECT. Passed into a filter unvalidated it becomes a
    // query operator chosen by the caller.
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B }),
    ]);
    const res = mkRes();
    orderController.updateOrderPaymentStatus(
      payReq(order._id, { status: 'paid', method: 'wire', tripId: { $ne: null } }), res, (e) => res.fail(e));
    await answered(res);
    assert.strictEqual(res.body?.status, false);
    assert.strictEqual(res.body?.code, 'invalid_leg_id');

    const legs = await Trip.find({ order: order._id }).lean();
    assert.ok(legs.every((l) => String(l.carrier_payment_status || 'pending') !== 'paid'),
      'nothing may have been paid by the injected filter');
  });

  await t('a malformed leg id is a 400, not a generic failure', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [seg({ carrier: CARRIER_A })]);
    const res = mkRes();
    orderController.updateOrderPaymentStatus(
      payReq(order._id, { status: 'paid', method: 'wire', tripId: 'not-an-id' }), res, (e) => res.fail(e));
    await answered(res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body?.code, 'invalid_leg_id');
  });

  await t('moving a load between two COMPANY trucks is not a party change', async () => {
    // Both legs are company legs — the party never changed, so a paid order must still be editable.
    // The lock used to compare an unresolved `truck:<id>` key against `company` and refuse.
    const otherCompanyTruck = await Truck.create({ tenantId: TENANT, plateNumber: 'CO-2', ownerOperated: false });
    const order = await makeOrder({
      order_type: 'regular', settle_amount: 0, input_settle_amount: 0,
      carrier_amount: 500, input_carrier_amount: 500,
    });
    await split(order, [seg({ truck: COMPANY_TRUCK._id })]);
    await DriverSalary.create({
      tenantId: TENANT, driver: oid(), month: 9, year: 2026,
      orderBreakdown: [{ order: order._id }],
    });

    const res = await split(await Order.findById(order._id), [seg({ truck: otherCompanyTruck._id })]);
    assert.ok(res.body?.status, `a same-party truck swap was refused: ${res.body?.message}`);
  });

  await t('the audit detail names which leg and carrier was paid', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 900, input_carrier_amount: 900,
    });
    await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, carrier: CARRIER_A }),
      seg({ start_stop_index: 1, end_stop_index: 2, carrier: CARRIER_B }),
    ]);
    const legs = await Trip.find({ order: order._id }).sort({ trip_no: 1 }).lean();

    const captured = [];
    global.__auditSink = captured;

    const res = mkRes();
    orderController.updateOrderPaymentStatus(
      payReq(order._id, { status: 'paid', method: 'wire', tripId: String(legs[1]._id) }), res, (e) => res.fail(e));
    await answered(res);
    assert.ok(res.body?.status, `payment refused: ${res.body?.message}`);

    const entry = captured.find((c) => c.action === 'PAYMENT');
    assert.ok(entry, 'a payment must be audited');
    assert.strictEqual(String(entry.details.legId), String(legs[1]._id));
    assert.strictEqual(entry.details.legNo, 2);
    assert.strictEqual(entry.details.legsAffected, 1, 'exactly one leg was paid');
    assert.strictEqual(entry.details.carrier, 'Carrier B');
    global.__auditSink = null;
  });

  await t('re-splitting an outsourcing order into pure fleet legs clears carrier fields', async () => {
    const order = await makeOrder({
      order_type: 'outsourcing', carrier: CARRIER_A,
      carrier_amount: 1200, input_carrier_amount: 1200,
    });
    // Re-split into company truck legs only
    const res = await split(order, [
      seg({ start_stop_index: 0, end_stop_index: 1, truck: COMPANY_TRUCK._id }),
      seg({ start_stop_index: 1, end_stop_index: 2, truck: COMPANY_TRUCK._id }),
    ]);
    assert.ok(res.body?.status, `split refused: ${res.body?.message}`);
    const after = await Order.findById(order._id).lean();
    assert.strictEqual(after.order_type, 'regular');
    assert.strictEqual(after.carrier, null, 'carrier must be cleared');
    assert.strictEqual(after.carrier_amount, 0, 'carrier_amount must be zeroed');
    assert.strictEqual(after.input_carrier_amount, 0, 'input_carrier_amount must be zeroed');
    assert.strictEqual(after.cost_amount, 0, 'company fleet cost is 0');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => {
  if (/ECONNREFUSED|failed to connect|ServerSelection/i.test(String(e?.message || e))) {
    console.error(`\nCannot reach ${URI}.\n`);
    console.error('This suite needs a throwaway local mongod. Start one with:');
    console.error('  mkdir -p /tmp/carrier-test-db');
    console.error('  mongod --dbpath /tmp/carrier-test-db --port 27099 --fork --logpath /tmp/carrier-test-db/mongod.log\n');
    console.error('It is deliberately NOT run against the configured database: DB_URL_OFFICE is production.\n');
    process.exit(1);
  }
  console.error('Test run failed:', e);
  try { await mongoose.connection.dropDatabase(); await mongoose.connection.close(); } catch {}
  process.exit(1);
});
