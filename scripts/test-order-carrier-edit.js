/**
 * Changing the carrier on a load from the EDIT ORDER form.
 *
 *   mongod --dbpath /tmp/carrier-edit --port 27099 --fork --logpath /tmp/carrier-edit/log
 *   node scripts/test-order-carrier-edit.js
 *
 * Client report (2026-09-24): "Facing an issue to change the carrier in any load."
 *
 * An order's carrier is a reading of its legs. `update_order` wrote the new carrier onto the order,
 * then re-read the legs — which still named the old carrier — and wrote that back. The form said
 * "Order updated successfully" and nothing changed. This suite pins the fix (the edit is pushed onto
 * the leg it belongs to) and every neighbouring case: echoes, locks, ambiguity, fleet orders,
 * legacy legless orders, frozen amounts, and Trip Planning still working.
 *
 * Throwaway local database only; it refuses anything that is not localhost and drops the DB.
 */
const assert = require('assert');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_edit_test';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

global.__audit = [];
const lp = require.resolve('../utils/activityLogger');
require.cache[lp] = { id: lp, filename: lp, loaded: true, exports: {
  logActivity() {}, CreatePaymentLog: async () => {}, AUDIT_FIELDS: {},
  logChange: (req, payload) => { global.__audit.push(payload); },
} };

const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const Carrier = require('../db/Carrier');
const Company = require('../db/Company');
require('../db/Customer'); require('../db/Trailer'); require('../db/Users'); require('../db/OwnerOperator');
const orderController = require('../controllers/orderController');
const tripController = require('../controllers/tripController');

let pass = 0, fail = 0;
const failures = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push([name, e.message]); console.log(`  FAIL ${name}\n         ${e.message}`); }
};

const TENANT = 'carrier-edit-co';
const oid = () => new mongoose.Types.ObjectId();
const mkRes = () => {
  const r = { statusCode: 200, body: null };
  let s; r.done = new Promise((x) => { s = x; });
  const a = (b) => { r.body = b; s(b); return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = a; r.send = a;
  return r;
};
const answered = (res) => Promise.race([res.done,
  new Promise((_, rej) => setTimeout(() => rej(new Error('controller never answered')), 10000))]);

let USER, CO, A, B, C, TRUCK;
let serial = 2000;

async function seed() {
  CO = await Company.create({ tenantId: TENANT, name: 'Edit Co', email: 'e@e.test', phone: '1', address: 'a' });
  USER = { _id: oid(), tenantId: TENANT, company: { _id: CO._id }, is_admin: 1, role: 3, permissions: [] };
  const mk = (id, n) => Carrier.create({ tenantId: TENANT, company: CO._id, carrierID: id, name: n, mc_code: `MC${id}`,
    phone: '1', email: `${id}@e.test`, country: 'CA', state: 'ON', city: 'X', zipcode: '1', location: 'X' });
  A = await mk('A', 'Carrier A'); B = await mk('B', 'Carrier B'); C = await mk('C', 'Carrier C');
  TRUCK = await Truck.create({ tenantId: TENANT, company: CO._id, plateNumber: 'T1', unitNumber: 'T-1', ownerOperated: false });
}

const stops = (n) => [{ reference: `R${n}`, locations: [
  { type: 'pickup', location: 'Toronto, ON', date: '2026-09-20' },
  { type: 'delivery', location: 'Montreal, QC', date: '2026-09-21' },
] }];

/* A plain outsourcing load with the default leg every order now carries. */
async function outsourcingOrder({ carrier = A, amount = 2000, frozen = null, legs = 1 } = {}) {
  serial += 1;
  const o = await Order.create({
    tenantId: TENANT, company: CO._id, serial_no: serial, company_name: 'X', customer: oid(),
    order_type: 'outsourcing', order_parties: ['carrier'], carrier: carrier._id, carriers: [carrier._id],
    carrier_amount: amount, input_carrier_amount: amount,
    total_amount: 3000, input_total_amount: 3000, input_currency: 'usd', revenue_currency: 'usd', fx_to_usd: 1,
    totalDistance: 321.8688, created_by: USER._id, shipping_details: stops(serial),
  });
  if (legs > 0) {
    await Trip.create({ tenantId: TENANT, order: o._id, trip_no: 1, start_stop_index: 0, end_stop_index: 1,
      carrier: carrier._id, carrier_amount: frozen, miles: 200, totalDistance: 200 });
  }
  return o;
}

const edit = async (order, body) => {
  const res = mkRes();
  orderController.update_order({ user: USER, tenantId: TENANT, tenant: { tenantId: TENANT },
    params: { id: String(order._id) }, body }, res, (e) => { throw e; });
  await answered(res);
  return res;
};
const legOf = (o) => Trip.findOne({ order: o._id, deletedAt: null }).sort({ trip_no: 1 }).lean();
const is = (id, c) => String(id) === String(c._id);

async function run() {
  await mongoose.connect(URI, { autoIndex: true });
  await mongoose.connection.dropDatabase();
  await seed();

  console.log('\n══ the client\'s bug ══\n');

  await t('changing the carrier on the order form actually changes it', async () => {
    const o = await outsourcingOrder();
    const r = await edit(o, { carrier: String(B._id), carrier_amount: 2000 });
    assert.strictEqual(r.statusCode, 200, r.body?.message);
    const after = await Order.findById(o._id).lean();
    assert.ok(is(after.carrier, B), `order still names ${after.carrier} — the edit was reverted`);
    assert.ok(is((await legOf(o)).carrier, B), 'the leg was not moved, so the next re-read will revert it');
    assert.deepStrictEqual(after.carriers.map(String), [String(B._id)]);
  });

  await t('the change survives the NEXT save (a note, a stop time)', async () => {
    const o = await outsourcingOrder();
    await edit(o, { carrier: String(B._id) });
    await edit(o, { customer_order_no: 'just a note' });
    assert.ok(is((await Order.findById(o._id).lean()).carrier, B), 'a later unrelated save put the old carrier back');
  });

  await t('the change is on the audit trail — both the order and the leg', async () => {
    global.__audit = [];
    const o = await outsourcingOrder();
    await edit(o, { carrier: String(B._id) });
    const orderEntry = global.__audit.find((a) => a.model === 'Order');
    const legEntry = global.__audit.find((a) => a.model === 'Trip');
    assert.ok(orderEntry && is(orderEntry.after.carrier, B), 'the order entry does not record the new carrier');
    assert.ok(legEntry && is(legEntry.after.carrier, B), 'the leg change left no trail');
  });

  console.log('\n══ amounts ══\n');

  await t('a FROZEN leg amount moves with the order, so the rate-con matches', async () => {
    const o = await outsourcingOrder({ frozen: 2000 });
    const r = await edit(o, { carrier: String(B._id), carrier_amount: 2500 });
    assert.strictEqual(r.statusCode, 200, r.body?.message);
    const leg = await legOf(o);
    assert.strictEqual(Number(leg.carrier_amount), 2500, `leg still says ${leg.carrier_amount} — the carrier's paperwork would disagree with the order`);
    assert.strictEqual(Number((await Order.findById(o._id).lean()).input_carrier_amount), 2500);
  });

  await t('an amount-only edit moves a frozen leg too', async () => {
    const o = await outsourcingOrder({ frozen: 2000 });
    await edit(o, { carrier_amount: 1800 });
    assert.strictEqual(Number((await legOf(o)).carrier_amount), 1800);
  });

  await t('a NULL leg amount stays null (it takes the order figure)', async () => {
    const o = await outsourcingOrder({ frozen: null });
    await edit(o, { carrier: String(B._id), carrier_amount: 2500 });
    const leg = await legOf(o);
    assert.ok(leg.carrier_amount === null || leg.carrier_amount === undefined,
      `a null leg amount was frozen to ${leg.carrier_amount}`);
    assert.strictEqual(Number((await Order.findById(o._id).lean()).input_carrier_amount), 2500);
  });

  console.log('\n══ what must NOT happen ══\n');

  await t('re-sending the SAME carrier is not an edit — nothing written, 200', async () => {
    global.__audit = [];
    const o = await outsourcingOrder();
    const r = await edit(o, { carrier: String(A._id), carrier_amount: 2000 });
    assert.strictEqual(r.statusCode, 200, r.body?.message);
    assert.ok(!global.__audit.some((a) => a.model === 'Trip'), 'an unchanged carrier rewrote the leg');
  });

  await t('a carrier already PAID cannot be swapped — 409, nothing moves', async () => {
    const o = await outsourcingOrder();
    await Trip.updateOne({ order: o._id }, { $set: { carrier_payment_status: 'paid' } });
    const r = await edit(o, { carrier: String(B._id), customer_order_no: 'should not save' });
    assert.strictEqual(r.statusCode, 409, `expected a lock, got ${r.statusCode}`);
    assert.strictEqual(r.body.code, 'leg_party_locked');
    const after = await Order.findById(o._id).lean();
    assert.ok(is(after.carrier, A), 'the order moved despite the refusal');
    assert.notStrictEqual(after.customer_order_no, 'should not save', 'the rest of a refused edit was written');
    assert.ok(is((await legOf(o)).carrier, A), 'the leg moved despite the refusal');
  });

  await t('a load split across TWO carriers refuses a third, loudly', async () => {
    const o = await outsourcingOrder();
    await Trip.create({ tenantId: TENANT, order: o._id, trip_no: 2, start_stop_index: 1, end_stop_index: 1,
      carrier: B._id, miles: 100, totalDistance: 100 });
    const r = await edit(o, { carrier: String(C._id) });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'carrier_set_on_legs');
    assert.ok(/Trip Planning/.test(r.body.message), 'the refusal must say where to do it');
  });

  await t('...but echoing one of its carriers back is a normal save', async () => {
    const o = await outsourcingOrder();
    await Trip.create({ tenantId: TENANT, order: o._id, trip_no: 2, start_stop_index: 1, end_stop_index: 1,
      carrier: B._id, miles: 100, totalDistance: 100 });
    const r = await edit(o, { carrier: String(A._id), customer_order_no: 'fine' });
    assert.strictEqual(r.statusCode, 200, r.body?.message);
  });

  await t('a FLEET load refuses a carrier from the order form (use Trip Planning)', async () => {
    serial += 1;
    const o = await Order.create({
      tenantId: TENANT, company: CO._id, serial_no: serial, company_name: 'X', customer: oid(),
      order_type: 'regular', order_parties: ['company'], truck: TRUCK._id,
      total_amount: 3000, input_total_amount: 3000, input_currency: 'usd', revenue_currency: 'usd', fx_to_usd: 1,
      totalDistance: 321.8688, created_by: USER._id, shipping_details: stops(serial),
    });
    await Trip.create({ tenantId: TENANT, order: o._id, trip_no: 1, start_stop_index: 0, end_stop_index: 1,
      truck: TRUCK._id, miles: 200, totalDistance: 200 });
    const r = await edit(o, { carrier: String(B._id) });
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'carrier_set_on_legs');
    const ok = await edit(o, { carrier: null, customer_order_no: 'fleet note' });
    assert.strictEqual(ok.statusCode, 200, `a fleet order's ordinary save broke: ${ok.body?.message}`);
  });

  console.log('\n══ the other doors still work ══\n');

  await t('a LEGACY order with no leg still changes carrier on its own columns', async () => {
    const o = await outsourcingOrder({ legs: 0 });
    const r = await edit(o, { carrier: String(B._id) });
    assert.strictEqual(r.statusCode, 200, r.body?.message);
    assert.ok(is((await Order.findById(o._id).lean()).carrier, B));
  });

  await t('an outsourcing order whose only leg lost its carrier gets it back', async () => {
    const o = await outsourcingOrder();
    await Trip.updateOne({ order: o._id }, { $set: { carrier: null } });
    const r = await edit(o, { carrier: String(B._id) });
    assert.strictEqual(r.statusCode, 200, r.body?.message);
    assert.ok(is((await legOf(o)).carrier, B));
    assert.ok(is((await Order.findById(o._id).lean()).carrier, B));
  });

  await t('Trip Planning still changes the carrier on the leg', async () => {
    const o = await outsourcingOrder();
    const res = mkRes();
    tripController.splitOrder({ user: USER, body: { orderId: String(o._id), segments: [
      { start_stop_index: 0, end_stop_index: 1, miles: 200, totalDistance: 200, carrier: String(B._id) },
    ] } }, res);
    await answered(res);
    assert.strictEqual(res.statusCode, 200, res.body?.message);
    assert.ok(is((await Order.findById(o._id).lean()).carrier, B));
  });

  await t('Trip Planning refuses to swap a PAID carrier (same lock, moved to a shared util)', async () => {
    const o = await outsourcingOrder();
    await Trip.updateOne({ order: o._id }, { $set: { carrier_payment_status: 'paid' } });
    const res = mkRes();
    tripController.splitOrder({ user: USER, body: { orderId: String(o._id), segments: [
      { start_stop_index: 0, end_stop_index: 1, miles: 200, totalDistance: 200, carrier: String(B._id), carrier_amount: 2000 },
    ] } }, res);
    await answered(res);
    assert.strictEqual(res.statusCode, 409, `expected a lock, got ${res.statusCode}`);
    assert.strictEqual(res.body.code, 'leg_party_locked');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) failures.forEach(([n, m]) => console.log(`  - ${n}\n      ${m}`));
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => {
  console.error('\nSUITE CRASHED:', e);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
