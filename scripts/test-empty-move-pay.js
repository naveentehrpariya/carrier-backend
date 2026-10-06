/**
 * EMPTY MILES + FIXED TRUCK EXPENSES ON THE PAYSLIPS (client, 2026-10-06)
 *
 *   mongod --dbpath /tmp/em --port 27099 --fork --logpath /tmp/em/log
 *   node scripts/test-empty-move-pay.js
 *
 * Uses TEST_DB_URL, default mongodb://127.0.0.1:27099/carrier_empty_move_pay. REFUSES anything that
 * is not localhost, because it drops the database when it finishes. Google is stubbed: every
 * distance below is a number this file chose, so every expected figure is computed here by hand.
 *
 * What it pins down:
 *  - an empty move between two loads is paid to the driver at their EMPTY rate (solo rate when
 *    none is set), in their own currency, into the base and the taxable base;
 *  - generating with moves to review and no confirmation is a 409; confirmed, it is stamped;
 *  - removing a move takes it off the driver payslip AND the owner deduction (one switch), and
 *    restoring puts it back on both;
 *  - our driver's empty miles on an owner's truck and that truck's fixed monthly expenses land on
 *    the owner payslip as ledger deductions; excluding a fixed expense retracts its line;
 *  - regenerating never duplicates an auto line, and an auto line cannot be edited from the ledger;
 *  - a measured move is stored and not re-measured.
 */
const assert = require('assert');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_empty_move_pay';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

const loggerPath = require.resolve('../utils/activityLogger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true, exports: {
    logActivity: () => {}, logChange: () => {}, CreatePaymentLog: async () => {}, AUDIT_FIELDS: {},
  },
};
global.__pdfHtml = [];
const puppeteerPath = require.resolve('../utils/puppeteer');
require.cache[puppeteerPath] = {
  id: puppeteerPath, filename: puppeteerPath, loaded: true, exports: {
    hardenPage: async () => {},
    launchBrowser: async () => ({
      newPage: async () => ({
        setContent: async (html) => { global.__pdfHtml.push(html); },
        emulateMediaType: async () => {}, pdf: async () => Buffer.from('%PDF-1.4 stub'),
        setViewport: async () => {}, goto: async () => {}, setRequestInterception: async () => {},
        on: () => {}, evaluate: async () => {},
      }),
      close: async () => {},
    }),
  },
};

// Google, stubbed BEFORE tripController captures it.
const DIST = { 'Montreal, QC||Ottawa, ON': 120, 'Kingston, ON||London, ON': 200 };
let googleCalls = 0;
const routeDistance = require('../utils/routeDistance');
routeDistance.resolveRouteDistance = async ({ origin, destination }) => {
  googleCalls += 1;
  const miles = DIST[`${origin}||${destination}`];
  return miles === undefined ? { ok: false } : { ok: true, miles };
};

const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const Users = require('../db/Users');
const Company = require('../db/Company');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const ConversionRate = require('../db/ConversionRate');
const OwnerAdjustment = require('../db/OwnerAdjustment');
const EmptyMoveMiles = require('../db/EmptyMoveMiles');
const TruckExpense = require('../db/TruckExpense');
require('../db/Customer'); require('../db/Trailer'); require('../db/DriverDeduction');
require('../db/DriverSalary'); require('../db/OwnerOperatorSalary'); require('../db/OwnerOperatorFinancialRecord');

require('../controllers/tripController');
const driverSalaryController = require('../controllers/driverSalaryController');
const ownerOperatorController = require('../controllers/ownerOperatorController');

let pass = 0, fail = 0;
const failures = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push([name, e.message]); console.log(`  FAIL ${name}\n         ${e.message}`); }
};
const near = (a, b, eps = 0.011) => assert.ok(Math.abs(Number(a) - Number(b)) < eps, `expected ${b}, got ${a}`);

const TENANT = 'emptymove-co';
const oid = () => new mongoose.Types.ObjectId();
const MONTH = 6, YEAR = 2026;
const at = (d) => new Date(Date.UTC(YEAR, MONTH - 1, d, 12));
const KM_100MI = 160.9344;

let USER, CO, OWNER, T_OWN, T_CO, D1;
const EMPTY_RATE = 0.40, SOLO = 0.60;

const mkRes = () => {
  const r = { statusCode: 200, body: null };
  let settle;
  r.done = new Promise((res) => { settle = res; });
  const answer = (b) => { r.body = b; settle(b); return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = answer; r.send = answer; r.end = answer;
  r.headers = {}; r.setHeader = (k, v) => { r.headers[k] = v; return r; }; r.set = r.setHeader; r.type = () => r;
  return r;
};
const call = async (handler, req) => {
  const res = mkRes();
  handler({ ...req, user: USER, tenant: { tenantId: TENANT }, tenantId: TENANT }, res, (e) => { throw e; });
  await Promise.race([res.done, new Promise((_, rej) => setTimeout(() => rej(new Error('controller never answered')), 20000))]);
  return res;
};

let serial = 2000;
async function load(day, from, to, truck) {
  serial += 1;
  const order = await Order.create({
    tenantId: TENANT, company: CO._id, serial_no: serial, company_name: 'C',
    customer: oid(), total_amount: 1000, input_total_amount: 1000, input_currency: 'cad',
    revenue_currency: 'usd', fx_to_usd: 0.711173, totalDistance: KM_100MI, created_by: USER._id,
    order_type: 'regular', createdAt: at(day), updatedAt: at(day),
    shipping_details: [{ reference: `R${serial}`, locations: [
      { type: 'pickup', location: from, date: `2026-06-${String(day).padStart(2, '0')}` },
      { type: 'delivery', location: to, date: `2026-06-${String(day).padStart(2, '0')}` },
    ] }],
  });
  await Order.updateOne({ _id: order._id }, { $set: { createdAt: at(day) } }, { timestamps: false });
  const trip = await Trip.create({
    tenantId: TENANT, order: order._id, trip_no: 1, start_stop_index: 0, end_stop_index: 1,
    start_location: from, end_location: to, truck: truck._id, driver: D1._id, drivers: [D1._id],
    miles: 100, totalDistance: 100, rate_per_mile: SOLO, rate_currency: 'CAD',
  });
  await Trip.updateOne({ _id: trip._id }, { $set: { createdAt: at(day) } }, { timestamps: false });
  return { order, trip };
}

const driverReview = async () => (await call(driverSalaryController.getDriverEmptyMoves, {
  params: { driverId: String(D1._id) }, query: { month: MONTH, year: YEAR },
})).body;
const ownerReview = async () => (await call(ownerOperatorController.salaryAutoChargeReview, {
  query: { ownerOperatorId: String(OWNER._id), month: MONTH, year: YEAR },
})).body;
const genDriver = (body = {}) => call(driverSalaryController.generateDriverSalary, {
  params: { driverId: String(D1._id) }, body: { month: MONTH, year: YEAR, currency: 'CAD', ...body },
});
const genOwner = (body = {}) => call(ownerOperatorController.generateMonthlySalary, {
  body: { month: MONTH, year: YEAR, ownerOperatorId: String(OWNER._id), payoutCurrency: 'CAD', ...body },
});
const autoRows = () => OwnerAdjustment.find({ tenantId: TENANT, ownerOperator: OWNER._id, month: MONTH, year: YEAR, autoKey: { $ne: null }, deletedAt: null }).lean();

let L1, L2, L3;

(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.db.dropDatabase();
  try {
    CO = await Company.create({ tenantId: TENANT, name: 'EM Freight', email: 'ops@em.test', phone: '1', address: 'a', order_prefix: 'EMF' });
    USER = { _id: oid(), tenantId: TENANT, company: { _id: CO._id }, is_admin: 1, role: 3, permissions: [] };
    OWNER = await OwnerOperator.create({ tenantId: TENANT, company: CO._id, ownerOperatorId: 'OO1', fullName: 'Owner One', phone: '1', email: 'o1@em.test', status: 'active' });
    T_OWN = await Truck.create({ tenantId: TENANT, company: CO._id, unitNumber: 'O-1', truckNumber: '1313', plateNumber: 'OO1', ownerOperated: true, ownerOperator: OWNER._id, insuranceMonthly: 300, parkingMonthly: 50 });
    T_CO = await Truck.create({ tenantId: TENANT, company: CO._id, unitNumber: 'C-1', truckNumber: '1312', plateNumber: 'CO1', ownerOperated: false });
    D1 = await Users.create({ tenantId: TENANT, company: CO._id, name: 'Driver One', email: 'd1@em.test', corporateID: 'D1', password: 'Test@12345', phone: '1', country: 'Canada', address: 'a', status: 'active', permissions: ['driver'] });
    await DriverProfile.create({ tenantId: TENANT, user: D1._id, company: CO._id, rateCurrency: 'CAD', ratePerMile: SOLO, ratePerMileSolo: SOLO, ratePerMileTeam: 0.5, cityHoursRate: 25, ratePerEmptyMile: EMPTY_RATE });
    for (const [s, g, r] of [['USD', 'CAD', 1.402359], ['CAD', 'USD', 0.711173], ['USD', 'USD', 1], ['CAD', 'CAD', 1]]) {
      await ConversionRate.create({ tenantId: TENANT, month: MONTH, year: YEAR, sourceCurrency: s, targetCurrency: g, rate: r, createdBy: USER._id });
    }
    // Owner truck: Toronto→Montreal, then (empty 120 mi Montreal→Ottawa) Ottawa→Kingston.
    // Company truck: (empty 200 mi Kingston→London) London→Toronto.
    L1 = await load(10, 'Toronto, ON', 'Montreal, QC', T_OWN);
    L2 = await load(12, 'Ottawa, ON', 'Kingston, ON', T_OWN);
    L3 = await load(14, 'London, ON', 'Toronto, ON', T_CO);

    console.log('\nDriver payslip');
    await t('review lists both moves at the empty rate', async () => {
      const r = await driverReview();
      assert.strictEqual(r.status, true, r.message);
      assert.strictEqual(r.moves.length, 2);
      assert.strictEqual(r.emptyRate, EMPTY_RATE);
      assert.strictEqual(r.emptyRateSource, 'empty');
      near(r.emptyMiles, 320);
      near(r.emptyPay, 320 * EMPTY_RATE);
    });
    await t('a measured move is stored and not measured again', async () => {
      const before = googleCalls;
      await driverReview();
      assert.strictEqual(googleCalls, before, 'second review called Google again');
      assert.strictEqual(await EmptyMoveMiles.countDocuments({ tenantId: TENANT }), 2);
    });
    await t('generating without the confirmation is refused', async () => {
      const res = await genDriver();
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.code, 'empty_moves_not_reviewed');
    });
    let slip;
    await t('confirmed: empty pay joins the base, the payslip is stamped', async () => {
      const res = await genDriver({ emptyMovesReviewed: true });
      assert.strictEqual(res.body.status, true, res.body.message);
      slip = res.body.salary;
      near(slip.emptyPay, 128);
      near(slip.emptyMiles, 320);
      near(slip.tripPay, 300 * SOLO);
      near(slip.basePayable, 300 * SOLO + 128);
      assert.ok(slip.emptyMovesReviewedAt, 'review not stamped');
      assert.strictEqual(String(slip.emptyMovesReviewedBy), String(USER._id));
      assert.strictEqual(slip.emptyMoves.length, 2);
    });
    await t('the PDF prints the empty-miles line and both moves', async () => {
      global.__pdfHtml = [];
      await call(driverSalaryController.getDriverSalaryPdf, { params: { driverId: String(D1._id) }, query: { month: MONTH, year: YEAR, currency: 'CAD' } });
      const html = global.__pdfHtml.join('');
      assert.ok(/Empty Miles Pay \(320\.00 mi/.test(html), 'no empty miles total line');
      assert.ok(html.includes('Empty move'), 'no empty move table');
    });
    await t('no empty rate set ⇒ solo rate', async () => {
      await DriverProfile.updateOne({ user: D1._id }, { $set: { ratePerEmptyMile: null } });
      const r = await driverReview();
      assert.strictEqual(r.emptyRateSource, 'solo');
      near(r.emptyPay, 320 * SOLO);
      await DriverProfile.updateOne({ user: D1._id }, { $set: { ratePerEmptyMile: EMPTY_RATE } });
    });

    console.log('\nOwner payslip');
    await t('review: our driver\'s move on the owner truck + both fixed expenses', async () => {
      const r = await ownerReview();
      assert.strictEqual(r.status, true, r.message);
      assert.strictEqual(r.emptyMoves.length, 1, 'only the move INTO the owner truck load');
      near(r.emptyMoves[0].pay, 120 * EMPTY_RATE);
      assert.strictEqual(r.fixedExpenses.length, 2);
      assert.deepStrictEqual(r.fixedExpenses.map((f) => f.type).sort(), ['insurance', 'parking']);
    });
    await t('generating without the confirmation is refused', async () => {
      const res = await genOwner();
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.code, 'auto_charges_not_reviewed');
    });
    await t('confirmed: three ledger deductions, payslip stamped', async () => {
      const res = await genOwner({ autoChargesReviewed: true });
      assert.strictEqual(res.body.status, true, res.body.message);
      const rows = await autoRows();
      assert.strictEqual(rows.length, 3);
      const empty = rows.find((r) => r.autoSource === 'empty_move');
      near(empty.amount, 48); assert.strictEqual(empty.currency, 'CAD'); assert.strictEqual(empty.category, 'empty_miles');
      const ins = rows.find((r) => r.category === 'insurance');
      near(ins.amount, 300);
      const s = res.body.salaries[0];
      assert.ok(s.autoChargesReviewedAt, 'not stamped');
      // 48 CAD + (300+50) USD at 1.402359
      near(s.manualDeduction, 48 + 350 * 1.402359, 0.05);
    });
    await t('regenerating does not duplicate an auto line', async () => {
      await genOwner({ autoChargesReviewed: true });
      assert.strictEqual((await autoRows()).length, 3);
    });
    await t('an auto line cannot be edited or removed from the ledger', async () => {
      const row = (await autoRows())[0];
      const u = await call(ownerOperatorController.updateSalaryAdjustment, { params: { id: String(row._id) }, body: { amount: 1, notes: 'x' } });
      assert.strictEqual(u.body.code, 'auto_generated_row');
      const r = await call(ownerOperatorController.removeSalaryAdjustment, { params: { id: String(row._id) }, body: {} });
      assert.strictEqual(r.body.code, 'auto_generated_row');
    });
    await t('excluding a fixed expense retracts its line on regenerate', async () => {
      const r = await ownerReview();
      const park = r.fixedExpenses.find((f) => f.type === 'parking');
      const ex = await call(ownerOperatorController.setFixedExpenseExcluded, { body: { expenseId: String(park._id), excluded: true } });
      assert.strictEqual(ex.body.excluded, true);
      await genOwner({ autoChargesReviewed: true });
      const rows = await autoRows();
      assert.strictEqual(rows.length, 2);
      assert.ok(!rows.some((x) => x.category === 'parking'));
      const exp = await TruckExpense.findById(park._id).lean();
      assert.strictEqual(exp.deletedAt, null, 'the expense itself must stay on the truck');
    });

    console.log('\nOne switch');
    await t('removing a move takes it off the driver AND the owner', async () => {
      const res = await call(driverSalaryController.setEmptyMoveIgnored, { body: {
        driverId: String(D1._id), after_trip_id: String(L1.trip._id), before_trip_id: String(L2.trip._id), ignored: true,
      } });
      assert.strictEqual(res.body.status, true, res.body.message);
      const d = await driverReview();
      near(d.emptyMiles, 200);
      assert.strictEqual(d.moves.filter((m) => m.ignored).length, 1, 'removed move must stay listed so it can be restored');
      const o = await ownerReview();
      assert.strictEqual(o.emptyMoves[0].ignored, true);
      await genOwner({ autoChargesReviewed: true });
      assert.ok(!(await autoRows()).some((x) => x.autoSource === 'empty_move'), 'empty line not retracted');
    });
    await t('restoring puts it back on both', async () => {
      await call(driverSalaryController.setEmptyMoveIgnored, { body: {
        driverId: String(D1._id), after_trip_id: String(L1.trip._id), before_trip_id: String(L2.trip._id), ignored: false,
      } });
      near((await driverReview()).emptyMiles, 320);
      await genOwner({ autoChargesReviewed: true });
      assert.ok((await autoRows()).some((x) => x.autoSource === 'empty_move'));
    });
    await t('a move id from another driver is refused', async () => {
      const other = await Users.create({ tenantId: TENANT, company: CO._id, name: 'Other', email: 'o@em.test', corporateID: 'O', password: 'Test@12345', phone: '1', country: 'Canada', address: 'a', status: 'active', permissions: ['driver'] });
      const res = await call(driverSalaryController.setEmptyMoveIgnored, { body: {
        driverId: String(other._id), after_trip_id: String(L1.trip._id), before_trip_id: String(L2.trip._id), ignored: true,
      } });
      assert.strictEqual(res.statusCode, 404);
    });
    await t('a malformed id is a 400', async () => {
      const res = await call(driverSalaryController.setEmptyMoveIgnored, { body: { driverId: { $ne: null }, after_trip_id: 'x', before_trip_id: 'y', ignored: true } });
      assert.strictEqual(res.statusCode, 400);
    });
    await t('a driver with nothing to review generates without the tick', async () => {
      const lone = await Users.create({ tenantId: TENANT, company: CO._id, name: 'Lone', email: 'l@em.test', corporateID: 'L', password: 'Test@12345', phone: '1', country: 'Canada', address: 'a', status: 'active', permissions: ['driver'] });
      await DriverProfile.create({ tenantId: TENANT, user: lone._id, company: CO._id, rateCurrency: 'CAD', ratePerMileSolo: 0.5, ratePerMileTeam: 0.4, cityHoursRate: 20 });
      const res = await call(driverSalaryController.generateDriverSalary, { params: { driverId: String(lone._id) }, body: { month: MONTH, year: YEAR, currency: 'CAD' } });
      assert.strictEqual(res.body.status, true, res.body.message);
      assert.strictEqual(res.body.salary.emptyMovesReviewedAt, null);
    });
  } finally {
    await mongoose.connection.db.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(([n, m]) => console.log(` - ${n}: ${m}`)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
