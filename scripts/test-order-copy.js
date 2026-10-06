/**
 * Copy a load (POST /order/copy/:id) + the new-load email.
 *
 *   mongod --dbpath /tmp/carrier-copy --port 27099 --fork --logpath /tmp/carrier-copy/log
 *   node scripts/test-order-copy.js
 *
 * Throwaway local database only; refuses anything that is not localhost and drops the DB.
 * SMTP is stubbed — the rendered email is captured (and written to $EMAIL_PREVIEW if set).
 */
const assert = require('assert');
const fs = require('fs');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_copy_test';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

const lp = require.resolve('../utils/activityLogger');
require.cache[lp] = { id: lp, filename: lp, loaded: true, exports: {
  logActivity() {}, CreatePaymentLog: async () => {}, AUDIT_FIELDS: {}, logChange() {},
} };
const sent = [];
const ep = require.resolve('../utils/Email');
const fakeSend = async (o) => { sent.push(o); return { accepted: [o.email] }; };
fakeSend.isEmailConfigured = () => true;
require.cache[ep] = { id: ep, filename: ep, loaded: true, exports: fakeSend };
process.env.DOMAIN_URL = 'https://app.example.test';

const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const Carrier = require('../db/Carrier');
const Company = require('../db/Company');
const Customer = require('../db/Customer');
const ConversionRate = require('../db/ConversionRate');
require('../db/Trailer'); require('../db/Users'); require('../db/OwnerOperator');
const orderController = require('../controllers/orderController');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.stack.split('\n').slice(0, 3).join('\n         ')}`); }
};

const TENANT = 'copy-co';
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

let USER, CO, CUST, CARRIER, TRUCK;

const create = async (body) => {
  const res = mkRes();
  orderController.create_order({ body, user: USER, tenantId: TENANT, tenant: { tenantId: TENANT } }, res, (e) => { throw e; });
  await answered(res);
  return res;
};
const copy = async (id) => {
  const res = mkRes();
  const req = { params: { id: String(id) }, body: {}, user: USER, tenantId: TENANT, tenant: { tenantId: TENANT } };
  orderController.prepareOrderCopy(req, res, () => orderController.create_order(req, res, (e) => { throw e; }));
  await answered(res);
  return res;
};
const waitMail = async (n) => { for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 50)); };

const stops = (extra = []) => [{
  commodity: { value: 'Steel coils' }, equipment: { value: 'Flatbed 53' }, weight: 42000, weight_unit: 'lbs',
  reference: 'PO-7781',
  locations: [
    { type: 'pickup', location: '20151 Fraser Hwy, Langley, BC V3A 4E4, Canada', date: '2026-10-08', appointment: '08:00', referenceNo: 'PU-1' },
    ...extra,
    { type: 'delivery', location: '1485 Chevrier Blvd, Winnipeg, MB R3T 1Y6, Canada', date: '2026-10-11' },
  ],
}];

(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.db.dropDatabase();
  try {
    CO = await Company.create({ tenantId: TENANT, name: 'Copy Freight', email: 'c@copy.test', phone: '1', address: 'a', order_prefix: 'CMC',
      // Stored junk is filtered at send time too, not only at save.
      order_notification_emails: ['ops@copy.test', 'OPS@copy.test', 'not-an-email'] });
    // Another tenant's recipients must never receive this tenant's loads.
    await Company.create({ tenantId: 'other-co', name: 'Other', email: 'o@o.test', phone: '1', address: 'a', order_notification_emails: ['leak@other.test'] });
    USER = { _id: oid(), name: 'Riya Sharma', tenantId: TENANT, company: { _id: CO._id }, is_admin: 1, role: 3, permissions: [], staff_commision: 5 };
    CUST = await Customer.create({ tenantId: TENANT, company: CO._id, name: 'Prairie Steel Ltd', email: 'p@copy.test', phone: '1', address: 'a', country: 'Canada', state: 'MB', city: 'Winnipeg', zipcode: 'R3T', created_by: USER._id });
    CARRIER = await Carrier.create({ tenantId: TENANT, company: CO._id, name: 'Alpha Freight', carrierID: 'CR-A', mc_code: '778812', phone: '1', email: 'a@copy.test', country: 'Canada', state: 'ON', city: 'X', zipcode: '1', location: 'X' });
    TRUCK = await Truck.create({ tenantId: TENANT, company: CO._id, unitNumber: 'T-12', plateNumber: 'BC1234', ownerOperated: false });
    const now = new Date();
    for (const [s, d, r] of [['CAD', 'USD', 0.711173], ['USD', 'CAD', 1.402359]]) {
      await ConversionRate.create({ tenantId: TENANT, month: now.getMonth() + 1, year: now.getFullYear(), sourceCurrency: s, targetCurrency: d, rate: r, createdBy: USER._id });
    }

    // Source: an outsourcing load typed in CAD.
    const srcRes = await create({
      company_name: 'Prairie Steel Ltd', customer: String(CUST._id), carrier: String(CARRIER._id), order_type: 'outsourcing',
      shipping_details: stops(), instructions: 'Call 30 min before pickup.',
      total_amount: 3200, carrier_amount: 2400, revenue_currency: 'cad',
      revenue_items: [{ revenue_item: 'Line Haul', rate: 3200, quantity: 1, note: '' }],
      carrier_revenue_items: [{ revenue_item: 'Line Haul', rate: 2400, quantity: 1, note: '' }],
      totalDistance: 2258.04, route_summary: 'Trans-Canada Hwy/BC-1', distance_source: 'auto_selected',
    });
    const SRC = srcRes.body.order;
    await waitMail(2);

    await t('source order created', async () => assert.strictEqual(srcRes.body.status, true, JSON.stringify(srcRes.body)));
    await t('new-load email sent once per valid, de-duplicated recipient', async () => {
      assert.strictEqual(sent.length, 1, `sent ${sent.length}`);
      assert.strictEqual(sent[0].email, 'ops@copy.test');
      assert.match(sent[0].subject, /^New load CMC-\d+: Langley, BC to Winnipeg, MB$/);
    });
    await t('email carries who, where, when and the money in the typed currency', async () => {
      const h = sent[0].message;
      for (const s of ['Riya Sharma', 'Prairie Steel Ltd', 'Alpha Freight', 'MC 778812', 'Langley, BC', 'Winnipeg, MB',
        'Thu, Oct 8, 2026', 'Sun, Oct 11, 2026', 'CA$3,200.00 CAD', 'CA$2,400.00 CAD', 'Steel coils',
        'Call 30 min before pickup.', `https://app.example.test/view/order/${SRC._id}`, '1,403 mi']) {
        assert.ok(h.includes(s), `missing: ${s}`);
      }
      // Profit after 5% commission on (3200 − 2400) = 800 − 40 = 760.
      assert.ok(h.includes('CA$760.00 CAD'), 'profit after commission');
      assert.ok(h.includes('CA$40.00 CAD commission (5%)'), 'commission line');
    });
    if (process.env.EMAIL_PREVIEW) fs.writeFileSync(process.env.EMAIL_PREVIEW, sent[0].message);

    // Copy it.
    const r1 = await copy(SRC._id);
    const COPY = r1.body.order;
    await waitMail(2);
    await t('copy creates a new order with the next serial', async () => {
      assert.strictEqual(r1.body.status, true, JSON.stringify(r1.body));
      assert.strictEqual(Number(COPY.serial_no), Number(SRC.serial_no) + 1);
      assert.notStrictEqual(String(COPY._id), String(SRC._id));
    });
    await t('copy carries details, typed amounts and currency unchanged', async () => {
      const c = await Order.findById(COPY._id).lean();
      const s = await Order.findById(SRC._id).lean();
      assert.strictEqual(String(c.customer), String(s.customer));
      assert.strictEqual(String(c.carrier), String(s.carrier));
      assert.strictEqual(c.order_type, 'outsourcing');
      assert.strictEqual(c.input_currency, 'cad');
      assert.strictEqual(c.input_total_amount, 3200);
      assert.strictEqual(c.input_carrier_amount, 2400);
      assert.strictEqual(c.total_amount, s.total_amount);
      assert.deepStrictEqual(c.revenue_items.map((x) => x.rate), s.revenue_items.map((x) => x.rate));
      assert.strictEqual(c.shipping_details[0].locations.length, 2);
      assert.strictEqual(c.shipping_details[0].reference, 'PO-7781');
      assert.strictEqual(c.instructions, 'Call 30 min before pickup.');
      assert.strictEqual(c.totalDistance, 2258.04);
      assert.strictEqual(c.route_summary, 'Trans-Canada Hwy/BC-1');
      assert.strictEqual(c.order_status, 'added');
      assert.strictEqual(c.customer_payment_status, s.customer_payment_status === 'paid' ? 'pending' : c.customer_payment_status);
    });
    await t('copy gets its own default leg', async () => {
      const legs = await Trip.find({ order: COPY._id }).lean();
      assert.strictEqual(legs.length, 1);
      assert.strictEqual(String(legs[0].carrier), String(CARRIER._id));
    });
    await t('copy email says where it came from', async () => {
      assert.strictEqual(sent.length, 2);
      assert.match(sent[1].subject, /\(copy of CMC-\d+\)$/);
      assert.ok(sent[1].message.includes(`Copied from CMC-${SRC.serial_no}`));
    });

    // Payment state is never copied.
    await Order.updateOne({ _id: SRC._id }, { $set: { customer_payment_status: 'paid', carrier_payment_status: 'paid', lock: true } });
    const r2 = await copy(SRC._id);
    await t('payment state and lock are not copied; a locked order can still be copied', async () => {
      assert.strictEqual(r2.body.status, true, JSON.stringify(r2.body));
      const c = await Order.findById(r2.body.order._id).lean();
      assert.notStrictEqual(c.customer_payment_status, 'paid');
      assert.notStrictEqual(c.carrier_payment_status, 'paid');
      assert.ok(!c.lock);
    });

    // Fleet order with a relay stop; the truck is later deleted.
    const fleet = await create({
      company_name: 'Prairie Steel Ltd', customer: String(CUST._id), truck: String(TRUCK._id), order_type: 'regular',
      shipping_details: stops([{ type: 'relay', location_type: 'relay', location: 'Calgary, AB, Canada' }]),
      total_amount: 1000, settle_amount: 0, revenue_currency: 'usd',
      revenue_items: [{ revenue_item: 'Line Haul', rate: 1000, quantity: 1, note: '' }], totalDistance: 100, confirm_duplicate: true,
    });
    if (!fleet.body.status) console.log('fleet create:', JSON.stringify(fleet.body));
    const r3 = await copy(fleet.body.order._id);
    await t('relay stops are dropped and reported', async () => {
      assert.strictEqual(r3.body.status, true, JSON.stringify(r3.body));
      const c = await Order.findById(r3.body.order._id).lean();
      assert.deepStrictEqual(c.shipping_details[0].locations.map((l) => l.type), ['pickup', 'delivery']);
      assert.strictEqual(r3.body.copiedFrom.droppedRelayStops, 1);
      assert.strictEqual(String(c.truck), String(TRUCK._id));
    });
    await Truck.updateOne({ _id: TRUCK._id }, { $set: { deletedAt: new Date() } });
    const r4 = await copy(fleet.body.order._id);
    await t('a deleted truck is left blank, not assigned', async () => {
      assert.strictEqual(r4.body.status, true, JSON.stringify(r4.body));
      const c = await Order.findById(r4.body.order._id).lean();
      assert.ok(!c.truck);
    });
    await Carrier.updateOne({ _id: CARRIER._id }, { $set: { deletedAt: new Date() } });
    const r5 = await copy(SRC._id);
    await t('a deleted carrier: the copy is booked unassigned and says so', async () => {
      assert.strictEqual(r5.body.status, true, JSON.stringify(r5.body));
      const c = await Order.findById(r5.body.order._id).lean();
      assert.ok(!c.carrier);
      assert.deepStrictEqual(c.order_parties, []);
      assert.strictEqual(r5.body.copiedFrom.carrierDropped, true);
    });

    await t('unknown / malformed / other-tenant id refused', async () => {
      assert.strictEqual((await copy(oid())).statusCode, 404);
      assert.strictEqual((await copy('nope')).statusCode, 400);
      const other = await Order.create({ ...(await Order.findById(SRC._id).lean()), _id: oid(), tenantId: 'other-co', serial_no: 1 });
      assert.strictEqual((await copy(other._id)).statusCode, 404);
    });
    const { addCompanyInfo } = require('../controllers/authController');
    const saveCompany = async (body) => {
      const res = mkRes();
      addCompanyInfo({ body: { companyID: String(CO._id), ...body }, user: USER, tenantId: TENANT }, res, (e) => { throw e; });
      await answered(res);
      return res;
    };
    await t('company setting: comma list saved normalised; bad address refused by name', async () => {
      let r = await saveCompany({ order_notification_emails: ' Dispatch@Copy.test, acct@copy.test;dispatch@copy.test ' });
      assert.strictEqual(r.body.status, true, JSON.stringify(r.body));
      assert.deepStrictEqual((await Company.findById(CO._id).lean()).order_notification_emails, ['dispatch@copy.test', 'acct@copy.test']);
      r = await saveCompany({ order_notification_emails: ['ok@copy.test', 'broken@'] });
      assert.strictEqual(r.statusCode, 400);
      assert.match(r.body.message, /broken@/);
      assert.deepStrictEqual((await Company.findById(CO._id).lean()).order_notification_emails, ['dispatch@copy.test', 'acct@copy.test']);
      r = await saveCompany({ name: 'Copy Freight' });
      assert.deepStrictEqual((await Company.findById(CO._id).lean()).order_notification_emails, ['dispatch@copy.test', 'acct@copy.test'], 'absent = untouched');
    });
    await t('only an admin may change the recipients; other fields still save for staff', async () => {
      const staff = { _id: oid(), tenantId: TENANT, company: { _id: CO._id }, permissions: ['regular'] };
      const call = async (body) => {
        const res = mkRes();
        addCompanyInfo({ body: { companyID: String(CO._id), ...body }, user: staff, tenantId: TENANT }, res, (e) => { throw e; });
        await answered(res);
        return res;
      };
      const r = await call({ order_notification_emails: ['me@driver.test'] });
      assert.strictEqual(r.statusCode, 403);
      assert.deepStrictEqual((await Company.findById(CO._id).lean()).order_notification_emails, ['dispatch@copy.test', 'acct@copy.test']);
      assert.strictEqual((await call({ phone: '999' })).body.status, true);
    });
    await t('new loads mail the company list; cleared list sends nothing', async () => {
      sent.length = 0;
      await copy(fleet.body.order._id);
      await waitMail(2);
      assert.deepStrictEqual(sent.map((m) => m.email).sort(), ['acct@copy.test', 'dispatch@copy.test']);
      await saveCompany({ order_notification_emails: [] });
      sent.length = 0;
      await copy(fleet.body.order._id);
      await new Promise((r) => setTimeout(r, 500));
      assert.strictEqual(sent.length, 0);
      assert.ok(!sent.some((m) => m.email === 'leak@other.test'));
    });
    await t('a deleted order cannot be copied', async () => {
      await Order.updateOne({ _id: SRC._id }, { $set: { deletedAt: new Date() } });
      assert.strictEqual((await copy(SRC._id)).statusCode, 404);
    });
  } finally {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
