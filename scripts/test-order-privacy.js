/**
 * Order / customer privacy — "everyone's work is private".
 *
 *   mongod --dbpath /tmp/carrier-priv --port 27099 --fork --logpath /tmp/carrier-priv/log
 *   node scripts/test-order-privacy.js
 *
 * Client (2026-10-05): no employee may see a customer assigned to someone else, or another
 * employee's load (customer, carrier, rate) through ANY door. The main list and detail were
 * already scoped; a dozen side doors (trips, rate-con, invoice, search, payments, reports,
 * trip logs, customer documents) only checked the tenant. Each door is asserted here from
 * the outside: employee A must get nothing of employee B's.
 *
 * Throwaway local database only; it refuses anything that is not localhost and drops the DB.
 */
const assert = require('assert');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_privacy_test';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

const lp = require.resolve('../utils/activityLogger');
require.cache[lp] = { id: lp, filename: lp, loaded: true, exports: {
  logActivity() {}, CreatePaymentLog: async () => {}, AUDIT_FIELDS: {}, logChange() {},
} };

const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Customer = require('../db/Customer');
const FleetDoc = require('../db/FleetDoc');
require('../db/Carrier'); require('../db/Truck'); require('../db/Trailer'); require('../db/Users');
require('../db/OwnerOperator'); require('../db/Company'); require('../db/Files');
const orderController = require('../controllers/orderController');
const tripController = require('../controllers/tripController');
const searchController = require('../controllers/searchController');
const customerController = require('../controllers/customerController');
const { canReadEntityDocs } = require('../controllers/docController');
const { requireTenantReportAccess } = require('../middlewares/tenantReportAccess');
const { requireTripWriteAccess } = require('../middlewares/tripAccessMiddleware');

let pass = 0, fail = 0;
const failures = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push([name, e.message]); console.log(`  FAIL ${name}\n         ${e.message}`); }
};

const TENANT = 'privacy-co';
const oid = () => new mongoose.Types.ObjectId();
const COMPANY = oid();

const mkRes = () => {
  const r = { statusCode: 200, body: null, headers: {} };
  let s; r.done = new Promise((x) => { s = x; });
  const a = (b) => { r.body = b; s(b); return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = a; r.send = a; r.end = a;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};
const answered = (res) => Promise.race([res.done,
  new Promise((_, rej) => setTimeout(() => rej(new Error('handler never answered')), 10000))]);

const staffPerms = ['regular', 'outsourcing', 'customers', 'carriers', 'invoices'];
const userOf = (perms, extra = {}) => ({ _id: oid(), tenantId: TENANT, company: { _id: COMPANY }, permissions: perms, ...extra });
const A = userOf(staffPerms);
const B = userOf(staffPerms);
const ACC = userOf(['accounting']);
const ADMIN = userOf([], { is_admin: 1, role: 3 });
const DRV = userOf(['driver'], { role: 0 });

const reqOf = (user, extra = {}) => ({
  user, tenantId: TENANT, tenant: { tenantId: TENANT }, params: {}, query: {}, body: {}, ...extra,
});

// Run a handler (catchAsync-wrapped or plain async) and wait for its answer.
async function call(handler, req) {
  const res = mkRes();
  let nexted = false;
  handler(req, res, (e) => { if (e) throw e; nexted = true; res.json({ __next: true }); });
  await answered(res);
  res.nexted = nexted;
  return res;
}

// Every serial number anywhere in a response body.
function serials(body) {
  const out = new Set();
  const walk = (v, depth = 0) => {
    if (!v || depth > 8) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      if (v instanceof mongoose.Types.ObjectId || v instanceof Date) return;
      if (typeof v.serial_no === 'number') out.add(v.serial_no);
      Object.values(v).forEach((x) => walk(x, depth + 1));
    }
  };
  walk(typeof body?.toObject === 'function' ? body.toObject() : JSON.parse(JSON.stringify(body || {})));
  return out;
}

let CUST_A, CUST_B, CUST_PUB, CARRIER;
const O = {};

async function seed() {
  const cust = (name, assigned) => Customer.collection.insertOne({
    tenantId: TENANT, company: COMPANY, name, phone: '1', email: `${name}@x.test`,
    address: 'a', country: 'CA', state: 'ON', city: 'X', zipcode: '1',
    assigned_to: assigned, deletedAt: null, createdAt: new Date(),
  }).then((r) => r.insertedId);
  CUST_A = await cust('AlphaFoods', [A._id]);
  CUST_B = await cust('BravoSteel', [B._id]);
  CUST_PUB = await cust('PublicCo', []);
  CARRIER = (await mongoose.connection.collection('carriers').insertOne({
    tenantId: TENANT, company: COMPANY, name: 'SharedHaul', mc_code: 'MC9', deletedAt: null,
  })).insertedId;

  const order = async (key, serial, created_by, customer, extra = {}) => {
    const doc = {
      tenantId: TENANT, company: COMPANY, serial_no: serial, company_name: key, customer, created_by,
      order_type: 'outsourcing', order_parties: ['carrier'], carrier: CARRIER, carriers: [CARRIER],
      total_amount: 5000, input_total_amount: 5000, carrier_amount: 4000, input_carrier_amount: 4000,
      input_currency: 'usd', revenue_currency: 'usd', fx_to_usd: 1, totalDistance: 100,
      order_status: 'added', customer_payment_status: 'pending', carrier_payment_status: 'pending',
      shipping_details: [{ reference: `REF${serial}`, locations: [
        { type: 'pickup', location: 'Toronto, ON', date: '2026-10-01' },
        { type: 'delivery', location: 'Ottawa, ON', date: '2026-10-02' },
      ] }],
      deletedAt: null, createdAt: new Date(), ...extra,
    };
    const id = (await Order.collection.insertOne(doc)).insertedId;
    const leg = (await Trip.collection.insertOne({
      tenantId: TENANT, order: id, trip_no: 1, start_stop_index: 0, end_stop_index: 1,
      carrier: CARRIER, carrier_amount: null, miles: 62, totalDistance: 62, deletedAt: null, createdAt: new Date(),
      ...(extra.driver ? { driver: extra.driver, drivers: [extra.driver] } : {}),
    })).insertedId;
    O[key] = { _id: id, serial, leg };
  };
  await order('aOwn', 5001, A._id, CUST_A);          // A's own load
  await order('bOwn', 5002, B._id, CUST_B);          // B's load on B's customer
  await order('bPublic', 5003, B._id, CUST_PUB);     // B's load on a public customer
  await order('bOnA', 5004, B._id, CUST_A);          // B booked it, customer now assigned to A
  await order('drv', 5005, B._id, CUST_B, { driver: DRV._id, drivers: [DRV._id] });
  await order('aOnB', 5006, A._id, CUST_B);          // A booked it, but the customer is B's

  await FleetDoc.collection.insertOne({ tenantId: TENANT, type: 'customer', entityId: CUST_B, name: 'credit.pdf', deletedAt: null });
}

const A_SEES = [5001, 5004];
const A_NEVER = [5002, 5003, 5005, 5006];

function assertScoped(set, label) {
  for (const s of A_NEVER) assert.ok(!set.has(s), `${label}: A saw B's order #${s}`);
}

async function run() {
  await mongoose.connect(URI, { autoIndex: true });
  await mongoose.connection.dropDatabase();
  await seed();

  console.log('\n══ lists ══\n');

  await t('order list: A sees own + assigned-customer orders, never B\'s', async () => {
    const r = await call(orderController.order_listing, reqOf(A));
    const s = serials(r.body);
    for (const x of A_SEES) assert.ok(s.has(x), `A missing #${x}`);
    assertScoped(s, 'order_listing');
  });

  await t('order list filtered by the shared carrier still hides B\'s loads', async () => {
    const r = await call(orderController.order_listing, reqOf(A, { query: { carrier_id: String(CARRIER) } }));
    assertScoped(serials(r.body), 'order_listing?carrier_id');
  });

  await t('all_payments_status (was tenant-only) is scoped', async () => {
    const r = await call(orderController.all_payments_status, reqOf(A));
    assertScoped(serials(r.body), 'all_payments_status');
  });

  await t('payments listing (carrier/customer orders pages) is scoped', async () => {
    const r = await call(orderController.orderPayments, reqOf(A, { query: { carrier_id: String(CARRIER) } }));
    assertScoped(serials(r.body), 'orderPayments');
  });

  await t('accounting list sees ALL orders (it used to see only its own)', async () => {
    const r = await call(orderController.order_listing_account, reqOf(ACC));
    const s = serials(r.body);
    for (const x of [...A_SEES, ...A_NEVER]) assert.ok(s.has(x), `accounting missing #${x}`);
  });

  await t('needs-attention is scoped', async () => {
    const r = await call(orderController.orders_needing_attention, reqOf(A));
    assertScoped(serials(r.body), 'needs-attention');
  });

  await t('overview counts only A\'s orders', async () => {
    const r = await call(orderController.overview, reqOf(A));
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
    // Every order is $5,000 revenue, so the revenue tile states how many orders were counted.
    const tile = (r.body?.lists || []).find((l) => l.title === 'Total Revenue');
    assert.ok(tile, 'no Total Revenue tile');
    assert.strictEqual(tile.rawValue, 5000 * A_SEES.length, `overview revenue ${tile.rawValue} counts other people's orders`);
  });

  console.log('\n══ by id ══\n');

  await t('order detail: B\'s order is 403 for A, A\'s own and assigned-customer order are 200', async () => {
    const bad = await call(orderController.order_detail, reqOf(A, { params: { id: String(O.bOwn._id) } }));
    assert.strictEqual(bad.statusCode, 403);
    const own = await call(orderController.order_detail, reqOf(A, { params: { id: String(O.aOwn._id) } }));
    assert.strictEqual(own.body?.status, true);
    const viaCust = await call(orderController.order_detail, reqOf(A, { params: { id: String(O.bOnA._id) } }));
    assert.strictEqual(viaCust.body?.status, true, 'assigned-customer order hidden from its assignee');
  });

  await t('public customer: B\'s load is NOT visible to A', async () => {
    const r = await call(orderController.order_detail, reqOf(A, { params: { id: String(O.bPublic._id) } }));
    assert.strictEqual(r.statusCode, 403);
  });

  await t('order docs/payment logs of B\'s order: 404 for A', async () => {
    const r = await call(orderController.order_docs, reqOf(A, { params: { id: String(O.bOwn._id) } }));
    assert.strictEqual(r.statusCode, 404);
  });

  await t('order legs (carrier + rate) of B\'s order: 403 for A, 200 for admin', async () => {
    const r = await call(tripController.getOrderTrips, reqOf(A, { params: { orderId: String(O.bOwn._id) } }));
    assert.strictEqual(r.statusCode, 403);
    assert.ok(!r.body?.trips?.length, 'legs leaked in the refusal');
    const ok = await call(tripController.getOrderTrips, reqOf(ADMIN, { params: { orderId: String(O.bOwn._id) } }));
    assert.strictEqual(ok.body?.status, true);
  });

  await t('leg rate confirmation of B\'s order: 403 for A', async () => {
    const r = await call(tripController.legRateConfirmationPdf,
      reqOf(A, { params: { orderId: String(O.bOwn._id), tripId: String(O.bOwn.leg) } }));
    assert.strictEqual(r.statusCode, 403);
  });

  await t('customer invoice of B\'s order: 404 for A (even holding `invoices`)', async () => {
    const r = await call(orderController.customerInvoicePdf, reqOf(A, { params: { id: String(O.bOwn._id) } }));
    assert.strictEqual(r.statusCode, 404);
  });

  console.log('\n══ search ══\n');

  await t('searching the shared CARRIER name lists none of B\'s loads (client\'s complaint)', async () => {
    const r = await call(searchController.globalSearch, reqOf(A, { query: { q: 'SharedHaul' } }));
    assertScoped(serials(r.body?.results?.orders || []), 'search by carrier');
  });

  await t('searching B\'s order reference finds nothing for A', async () => {
    const r = await call(searchController.globalSearch, reqOf(A, { query: { q: 'REF5002' } }));
    assert.strictEqual((r.body?.results?.orders || []).length, 0);
  });

  await t('searching B\'s customer name: no customer, no orders', async () => {
    const r = await call(searchController.globalSearch, reqOf(A, { query: { q: 'BravoSteel' } }));
    assert.strictEqual((r.body?.results?.customers || []).length, 0, 'customer leaked');
    assert.strictEqual((r.body?.results?.orders || []).length, 0, 'orders leaked');
  });

  console.log('\n══ side doors ══\n');

  await t('B\'s customer documents are not listable by A', async () => {
    assert.strictEqual(await canReadEntityDocs({ user: A }, 'customer', String(CUST_B), TENANT), false);
    assert.strictEqual(await canReadEntityDocs({ user: B }, 'customer', String(CUST_B), TENANT), true);
  });

  await t('company reports/analytics/finance: 403 for staff, open to accounting + admin', async () => {
    for (const [u, expect] of [[A, 403], [DRV, 403], [ACC, 200], [ADMIN, 200]]) {
      const r = await call(requireTenantReportAccess, reqOf(u));
      assert.strictEqual(r.nexted ? 200 : r.statusCode, expect);
    }
  });

  await t('truck/driver trip logs: 403 for staff; driver may read own', async () => {
    const truckLogs = await call(tripController.getTruckTripLogs, reqOf(A, { params: { truckId: String(oid()) } }));
    assert.strictEqual(truckLogs.statusCode, 403);
    const other = await call(tripController.getDriverTripLogs, reqOf(A, { params: { driverId: String(DRV._id) } }));
    assert.strictEqual(other.statusCode, 403);
    const own = await call(tripController.getDriverTrips, reqOf(DRV, { params: { driverId: String(DRV._id) } }));
    assert.notStrictEqual(own.statusCode, 403);
  });

  await t('driver sees only the load they drive', async () => {
    const r = await call(orderController.order_listing, reqOf(DRV));
    const s = serials(r.body);
    assert.ok(s.has(5005));
    for (const x of [5001, 5002, 5003, 5004, 5006]) assert.ok(!s.has(x), `driver saw #${x}`);
  });

  console.log('\n══ current assignee only ══\n');

  await t('creator does not keep a load once its customer is someone else\'s', async () => {
    const r = await call(orderController.order_detail, reqOf(A, { params: { id: String(O.aOnB._id) } }));
    assert.strictEqual(r.statusCode, 403, 'A still reads a load on B\'s customer because A booked it');
    const b = await call(orderController.order_detail, reqOf(B, { params: { id: String(O.aOnB._id) } }));
    assert.strictEqual(b.body?.status, true, 'the current assignee cannot read their customer\'s load');
  });

  await t('customer detail: only the current assignee (public stays open to regular)', async () => {
    const det = (u, id) => call(customerController.customerDetails, reqOf(u, { params: { id: String(id) } }));
    assert.strictEqual((await det(A, CUST_B)).body?.status, false, 'A opened B\'s customer');
    assert.strictEqual((await det(B, CUST_B)).body?.status, true);
    assert.strictEqual((await det(A, CUST_PUB)).body?.status, true, 'public customer hidden from regular user');
  });

  await t('reassigning a customer moves its loads AND its detail page to the new assignee', async () => {
    await Customer.collection.updateOne({ _id: CUST_A }, { $set: { assigned_to: [B._id] } });
    try {
      const listA = serials((await call(orderController.order_listing, reqOf(A))).body);
      for (const x of [5001, 5004]) assert.ok(!listA.has(x), `previous assignee A still lists #${x}`);
      const listB = serials((await call(orderController.order_listing, reqOf(B))).body);
      for (const x of [5001, 5004]) assert.ok(listB.has(x), `new assignee B missing #${x}`);
      const det = await call(customerController.customerDetails, reqOf(A, { params: { id: String(CUST_A) } }));
      assert.strictEqual(det.body?.status, false, 'previous assignee still opens the customer');
      const edit = await call(orderController.update_order,
        reqOf(A, { params: { id: String(O.aOwn._id) }, body: { notes: 'x' } }));
      assert.notStrictEqual(edit.body?.status, true, 'A still edits a load whose customer moved to B');
    } finally {
      await Customer.collection.updateOne({ _id: CUST_A }, { $set: { assigned_to: [A._id] } });
    }
  });

  console.log('\n══ writes ══\n');

  await t('trip planning on B\'s order is refused for A (404), allowed for B', async () => {
    const r = await call(requireTripWriteAccess, reqOf(A, { body: { orderId: String(O.bOwn._id) } }));
    assert.strictEqual(r.statusCode, 404);
    const ok = await call(requireTripWriteAccess, reqOf(B, { body: { orderId: String(O.bOwn._id) } }));
    assert.ok(ok.nexted, 'B refused on own order');
  });

  await t('booking an order on B\'s customer is refused for A', async () => {
    const r = await call(orderController.create_order, reqOf(A, { body: { customer: String(CUST_B) } }));
    assert.strictEqual(r.statusCode, 403);
    assert.strictEqual(r.body?.code, 'customer_not_visible');
  });

  await t('editing B\'s order is still refused for A, even on A\'s customer', async () => {
    const r = await call(orderController.update_order, reqOf(A, { params: { id: String(O.bOnA._id) }, body: { notes: 'x' } }));
    assert.notStrictEqual(r.body?.status, true, 'A could edit an order they did not create');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) failures.forEach(([n, m]) => console.log(` - ${n}: ${m}`));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => {
  console.error(e);
  try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
