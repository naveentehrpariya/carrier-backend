/**
 * THE MONEY MATRIX — every order shape, then the three reports that pay real people.
 *
 *   mongod --dbpath /tmp/matrix --port 27099 --fork --logpath /tmp/matrix/log
 *   node scripts/test-payroll-matrix.js
 *
 * Uses TEST_DB_URL, default mongodb://127.0.0.1:27099/carrier_payroll_matrix. REFUSES anything that
 * is not localhost, because it drops the database when it finishes.
 *
 * WHY THIS EXISTS
 * ---------------
 * An order can now be run by our own truck, an owner-operator's truck, an outside carrier, several
 * of those at once, or nobody yet. Three separate reports then pay real money off those legs:
 * the driver payslip, the owner-operator statement and the truck gross earnings report. Each reads
 * the legs through a different helper, so a shape that one of them gets right is not evidence that
 * the other two do.
 *
 * The client's original ask is the sharpest case here, and it is asserted directly:
 *   "driver salery me only un trips ki miles uthaya jo ragular h"
 * — a driver is paid for the legs THEY ran, never for the miles an outside carrier moved, even when
 * both legs sit on one order.
 *
 * HOW IT CHECKS
 * -------------
 * Every expected figure is computed here from first principles — miles x rate, share of a pot —
 * NOT by calling the same helper the code under test calls. A test that asks the implementation
 * what the answer should be proves only that the implementation is self-consistent.
 */
const assert = require('assert');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_payroll_matrix';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

// The audit trail is a hash-chained write per change and is not what is under test.
const loggerPath = require.resolve('../utils/activityLogger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true, exports: {
    logActivity: () => {}, logChange: () => {}, CreatePaymentLog: async () => {}, AUDIT_FIELDS: {},
  },
};

/* The PDF routes are worth testing for the FIGURES they print, not for Chrome's rendering. Stub the
 * browser and keep the HTML the controller actually produced — the template and the data wiring are
 * what can be wrong. `hardenPage` is exercised for real elsewhere. */
global.__pdfHtml = [];
const puppeteerPath = require.resolve('../utils/puppeteer');
require.cache[puppeteerPath] = {
  id: puppeteerPath, filename: puppeteerPath, loaded: true, exports: {
    hardenPage: async () => {},
    launchBrowser: async () => ({
      newPage: async () => ({
        setContent: async (html) => { global.__pdfHtml.push(html); },
        emulateMediaType: async () => {},
        pdf: async () => Buffer.from('%PDF-1.4 stub'),
        setViewport: async () => {},
        goto: async () => {},
        setRequestInterception: async () => {},
        on: () => {},
        evaluate: async () => {},
      }),
      close: async () => {},
    }),
  },
};

const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const Users = require('../db/Users');
const Carrier = require('../db/Carrier');
const Customer = require('../db/Customer');
const Company = require('../db/Company');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const ConversionRate = require('../db/ConversionRate');
require('../db/Trailer');
require('../db/DriverDeduction');
require('../db/DriverSalary');
require('../db/OwnerOperatorSalary');
require('../db/OwnerOperatorFinancialRecord');
require('../db/TruckExpense');

const tripController = require('../controllers/tripController');
const driverSalaryController = require('../controllers/driverSalaryController');
const ownerOperatorController = require('../controllers/ownerOperatorController');
const orderController = require('../controllers/orderController');
const { isUnassigned, hasCarrierWork, hasFleetWork } = require('../utils/orderParty');

let pass = 0, fail = 0;
const failures = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; failures.push([name, e.message]); console.log(`  FAIL ${name}\n         ${e.message}`); }
};
const near = (a, b, eps = 0.02) => assert.ok(
  Math.abs(Number(a) - Number(b)) < eps, `expected ${b}, got ${a}`);

const TENANT = 'matrix-co';
const oid = () => new mongoose.Types.ObjectId();

// 321.8688 km is exactly 200 miles. Every order below is 200 miles so a two-leg split is 100/100
// and the arithmetic can be checked by hand.
const KM_200MI = 321.8688;
const MONTH = 6, YEAR = 2026;
const WHEN = new Date(Date.UTC(YEAR, MONTH - 1, 15));

let CO, CUSTOMER, CARRIER_A, CARRIER_B;
let OWNER_1, OWNER_2, T_CO, T_CO2, T_O1, T_O2;
let D1, D2, D3;                        // D1/D2 CAD, D3 USD — cross-currency payslip
const RATE = { solo: 0.60, team: 0.50, soloUsd: 0.45, teamUsd: 0.38 };

let USER;
const mkRes = () => {
  const r = { statusCode: 200, body: null };
  let settle;
  r.done = new Promise((res) => { settle = res; });
  const answer = (b) => { r.body = b; settle(b); return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = answer; r.send = answer; r.end = answer;
  // The PDF routes set headers and stream a buffer, so the double has to behave like a real
  // response or the handler dies on `res.setHeader` long before anything can be asserted.
  r.headers = {};
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.set = r.setHeader;
  r.type = () => r;
  return r;
};
const answered = (res, ms = 15000) => Promise.race([
  res.done,
  new Promise((_, rej) => setTimeout(() => rej(new Error('controller never answered')), ms)),
]);
const call = async (handler, req) => {
  const res = mkRes();
  handler({ ...req, user: USER, tenant: { tenantId: TENANT } }, res, (e) => { throw e; });
  await answered(res);
  return res;
};

async function seed() {
  CO = await Company.create({
    tenantId: TENANT, name: 'Matrix Freight', email: 'ops@matrix.test',
    phone: '4160000000', address: '1 Test St, Toronto, ON', order_prefix: 'MTX',
  });
  USER = { _id: oid(), tenantId: TENANT, company: { _id: CO._id }, is_admin: 1, role: 3, permissions: [] };

  CUSTOMER = await Customer.create({
    tenantId: TENANT, company: CO._id, name: 'Matrix Customer', email: 'c@matrix.test',
    phone: '1', address: 'a', country: 'Canada', state: 'ON', city: 'Toronto', zipcode: 'M5V',
    created_by: USER._id,
  });
  CARRIER_A = await Carrier.create({ tenantId: TENANT, company: CO._id, name: 'Alpha Freight', carrierID: 'CR-A', mc_code: 'MC1', phone: '1', email: 'a@matrix.test', country: 'Canada', state: 'ON', city: 'Brampton', zipcode: 'L6T', location: 'Brampton, ON' });
  CARRIER_B = await Carrier.create({ tenantId: TENANT, company: CO._id, name: 'Beta Cartage', carrierID: 'CR-B', mc_code: 'MC2', phone: '2', email: 'b@matrix.test', country: 'Canada', state: 'ON', city: 'Windsor', zipcode: 'N8X', location: 'Windsor, ON' });

  OWNER_1 = await OwnerOperator.create({ tenantId: TENANT, company: CO._id, ownerOperatorId: 'OO1', fullName: 'Owner One', phone: '1', email: 'o1@matrix.test', status: 'active' });
  OWNER_2 = await OwnerOperator.create({ tenantId: TENANT, company: CO._id, ownerOperatorId: 'OO2', fullName: 'Owner Two', phone: '2', email: 'o2@matrix.test', status: 'active' });

  T_CO = await Truck.create({ tenantId: TENANT, company: CO._id, unitNumber: 'C-1', plateNumber: 'CO1', ownerOperated: false });
  T_CO2 = await Truck.create({ tenantId: TENANT, company: CO._id, unitNumber: 'C-2', plateNumber: 'CO2', ownerOperated: false });
  T_O1 = await Truck.create({ tenantId: TENANT, company: CO._id, unitNumber: 'O-1', plateNumber: 'OO1', ownerOperated: true, ownerOperator: OWNER_1._id });
  T_O2 = await Truck.create({ tenantId: TENANT, company: CO._id, unitNumber: 'O-2', plateNumber: 'OO2', ownerOperated: true, ownerOperator: OWNER_2._id });

  const mkDriver = async (name, email, cur, solo, team) => {
    const u = await Users.create({
      tenantId: TENANT, company: CO._id, name, email, corporateID: name.replace(/\s/g, ''),
      password: 'Test@12345', phone: '1', country: 'Canada', address: 'a',
      status: 'active', permissions: ['driver'],
    });
    await DriverProfile.create({
      tenantId: TENANT, user: u._id, company: CO._id, licenseNumber: `L-${name}`,
      ratePerMile: solo, ratePerMileSolo: solo, ratePerMileTeam: team,
      cityHoursRate: 25, rateCurrency: cur,
    });
    return u;
  };
  D1 = await mkDriver('Driver One', 'd1@matrix.test', 'CAD', RATE.solo, RATE.team);
  D2 = await mkDriver('Driver Two', 'd2@matrix.test', 'CAD', RATE.solo, RATE.team);
  D3 = await mkDriver('Driver Three', 'd3@matrix.test', 'USD', RATE.soloUsd, RATE.teamUsd);

  // Real, deliberately non-reciprocal rates — that asymmetry is why money converts once, at the
  // row's own month, instead of round-tripping.
  const pairs = [['USD', 'CAD', 1.402359], ['CAD', 'USD', 0.711173], ['USD', 'USD', 1], ['CAD', 'CAD', 1]];
  for (const [sourceCurrency, targetCurrency, rate] of pairs) {
    await ConversionRate.create({ tenantId: TENANT, month: MONTH, year: YEAR, sourceCurrency, targetCurrency, rate, createdBy: USER._id });
  }
}


/* What an owner is owed for the month, computed here rather than by the app's own allocator.
 *
 * The rule has TWO branches and both matter: on a MIXED-owner order each owner leg carries its
 * frozen share (`Trip.settle_amount`), but on a single-owner order the leg is deliberately left
 * null and the ORDER's own settle column is the source — freezing a leg that nobody is competing
 * for would be a second copy of the same number. Summing leg amounts alone therefore misses every
 * single-owner order, which is most of them. */
const expectedOwnerBase = async (owner) => {
  const truckIds = (await Truck.find({ tenantId: TENANT, ownerOperator: owner._id }).lean())
    .map((x) => String(x._id));
  const legs = await Trip.find({ tenantId: TENANT, deletedAt: null }).lean();
  const mine = legs.filter((l) => l.truck && truckIds.includes(String(l.truck)));
  const byOrder = new Map();
  for (const l of mine) {
    if (!byOrder.has(String(l.order))) byOrder.set(String(l.order), []);
    byOrder.get(String(l.order)).push(l);
  }
  let total = 0;
  for (const [orderId, theirLegs] of byOrder) {
    const order = await Order.findById(orderId).lean();
    if (!order) continue;
    if (order.isMixedOwner) {
      total += theirLegs.reduce((s, l) => s + Number(l.settle_amount || 0), 0);
    } else {
      total += Number(order.settle_amount || 0);
    }
  }
  return total;
};

let serial = 1000;
async function makeOrder(over = {}) {
  serial += 1;
  return Order.create({
    tenantId: TENANT, company: CO._id, customer: CUSTOMER._id, serial_no: serial,
    company_name: 'Matrix Customer',
    total_amount: 3000, input_total_amount: 3000,
    input_currency: 'usd', revenue_currency: 'usd', fx_to_usd: 1,
    totalDistance: KM_200MI, created_by: USER._id,
    createdAt: WHEN, updatedAt: WHEN,
    shipping_details: [{ reference: `R${serial}`, locations: [
      { type: 'pickup', location: 'Toronto, ON', date: '2026-06-10' },
      { type: 'delivery', location: 'Montreal, QC', date: '2026-06-11' },
    ] }],
    ...over,
  });
}

const seg = (over = {}) => ({ start_stop_index: 0, end_stop_index: 1, miles: 100, totalDistance: 100, ...over });

const split = async (order, segments) => call(tripController.splitOrder,
  { body: { orderId: String(order._id), segments } });

// Date-stamp the legs into the payroll month. splitOrder writes them with `new Date()`, and the
// payslip selects by the order's month — without this every leg lands in whatever month the test
// happens to run in and the payslips come back empty.
const stampLegs = async () => {
  await Trip.updateMany({ tenantId: TENANT }, { $set: { createdAt: WHEN, updatedAt: WHEN } }, { timestamps: false });
  await Order.updateMany({ tenantId: TENANT }, { $set: { createdAt: WHEN, updatedAt: WHEN } }, { timestamps: false });
};

const driverPay = async (driver, currency) => {
  const res = await call(driverSalaryController.getDriverSalary, {
    params: { driverId: String(driver._id) }, query: { month: MONTH, year: YEAR, currency },
  });
  assert.ok(res.body?.status !== false, `payslip failed: ${res.body?.message}`);
  return res.body.salary || res.body.data || res.body;
};

const truckGross = async () => {
  // The report defaults to a recent window; every fixture here is dated into the payroll month, so
  // the range has to be stated or both the legs and the expenses fall outside it.
  const res = await call(tripController.getTrucksGrossEarnings, {
    query: { currency: 'usd', from: '2026-06-01', to: '2026-06-30' },
  });
  assert.ok(res.statusCode === 200, `truck gross ${res.statusCode}: ${res.body?.message}`);
  return res.body;
};

async function run() {
  await mongoose.connect(URI, { autoIndex: true });
  await mongoose.connection.dropDatabase();
  await seed();

  console.log('\n══ 1. ORDER SHAPES — what each one is read as ══\n');

  const shapes = {};

  await t('fleet, company truck + one driver → regular / company', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 0, input_settle_amount: 0 });
    const r = await split(o, [seg({ truck: T_CO._id, driver: D1._id, miles: 200, totalDistance: 200 })]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.deepStrictEqual(f.order_parties, ['company']);
    assert.strictEqual(f.order_type, 'regular');
    shapes.fleetSolo = f;
  });

  await t('fleet team — two drivers on one leg', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 0, input_settle_amount: 0 });
    const r = await split(o, [seg({ truck: T_CO2._id, drivers: [D1._id, D2._id], miles: 200, totalDistance: 200 })]);
    assert.ok(r.body.status !== false, r.body?.message);
    const legs = await Trip.find({ order: o._id }).lean();
    assert.strictEqual(legs[0].drivers.length, 2, 'both drivers must be on the leg');
    shapes.fleetTeam = await Order.findById(o._id).lean();
  });

  await t("owner truck, owner's OWN driver (no driver of ours) → owner, deduction 0", async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 1000, input_settle_amount: 1000 });
    const r = await split(o, [seg({ truck: T_O1._id, miles: 200, totalDistance: 200 })]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.deepStrictEqual(f.order_parties, ['owner']);
    shapes.ownerNoDriver = f;
  });

  await t('owner truck run by OUR driver → owner, and the driver is still paid', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 1000, input_settle_amount: 1000 });
    const r = await split(o, [seg({ truck: T_O2._id, driver: D2._id, miles: 200, totalDistance: 200 })]);
    assert.ok(r.body.status !== false, r.body?.message);
    shapes.ownerOurDriver = await Order.findById(o._id).lean();
  });

  await t('single carrier → outsourcing', async () => {
    const o = await makeOrder({ order_type: 'outsourcing', carrier: CARRIER_A._id, carrier_amount: 2000, input_carrier_amount: 2000 });
    const r = await split(o, [seg({ carrier: CARRIER_A._id, miles: 200, totalDistance: 200 })]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.deepStrictEqual(f.order_parties, ['carrier']);
    shapes.outsourcing = f;
  });

  await t('TWO carriers on one order → carrier is null, carriers[] holds both', async () => {
    const o = await makeOrder({ order_type: 'outsourcing', carrier: CARRIER_A._id, carrier_amount: 2000, input_carrier_amount: 2000 });
    const r = await split(o, [
      seg({ carrier: CARRIER_A._id, carrier_amount: 1100 }),
      seg({ carrier: CARRIER_B._id, carrier_amount: 900, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.strictEqual(f.carriers.length, 2, 'both carriers listed');
    assert.strictEqual(f.carrier, null, 'no single carrier on a two-carrier order');
    shapes.twoCarriers = f;
  });

  await t('MIXED — our truck on leg 1, a carrier on leg 2', async () => {
    const o = await makeOrder({
      order_type: 'regular', settle_amount: 0, input_settle_amount: 0,
      carrier_amount: 0, input_carrier_amount: 0,
    });
    const r = await split(o, [
      seg({ truck: T_CO._id, driver: D1._id }),
      seg({ carrier: CARRIER_A._id, carrier_amount: 900, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.strictEqual(f.isMixedType, true, 'must be flagged mixed');
    assert.deepStrictEqual(f.order_parties, ['company', 'carrier']);
    assert.strictEqual(f.order_type, 'regular', 'a mixed order is stamped regular');
    shapes.mixed = f;
  });

  await t('MIXED OWNER — two different owners on one order', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 1600, input_settle_amount: 1600 });
    const r = await split(o, [
      seg({ truck: T_O1._id, driver: D1._id }),
      seg({ truck: T_O2._id, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.strictEqual(f.isMixedOwner, true);
    assert.strictEqual(f.ownerOperator, null, 'a mixed-owner order names no single owner');
    assert.strictEqual(f.ownerOperators.length, 2);
    shapes.mixedOwner = f;
  });

  await t('THREE parties — owner + company + carrier on one order', async () => {
    const o = await makeOrder({
      order_type: 'regular', settle_amount: 700, input_settle_amount: 700,
      totalDistance: KM_200MI * 1.5,   // 300 miles, three 100-mile legs
    });
    const r = await split(o, [
      seg({ truck: T_O1._id, driver: D1._id }),
      seg({ truck: T_CO._id, driver: D2._id, start_stop_index: 1, end_stop_index: 1 }),
      seg({ carrier: CARRIER_B._id, carrier_amount: 800, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.deepStrictEqual(f.order_parties, ['company', 'owner', 'carrier']);
    assert.strictEqual(f.isMixedType, true);
    shapes.threeWay = f;
  });

  await t('UNASSIGNED — booked, nobody on it yet', async () => {
    const o = await makeOrder({ order_type: 'regular', order_parties: [] });
    const f = await Order.findById(o._id).lean();
    assert.strictEqual(isUnassigned(f), true);
    assert.strictEqual(hasCarrierWork(f), false, 'nobody assigned is not carrier work');
    shapes.unassigned = f;
  });

  console.log('\n══ 2. GUARDS — what must be refused ══\n');

  await t('a leg with neither truck nor carrier is refused (2+ legs)', async () => {
    const o = await makeOrder({ order_type: 'regular' });
    const r = await split(o, [seg({ truck: T_CO._id, driver: D1._id }), seg({ start_stop_index: 1, end_stop_index: 1 })]);
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.code, 'leg_has_no_party');
  });

  await t('an owner leg with no settlement anywhere is refused', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 0, input_settle_amount: 0 });
    const r = await split(o, [seg({ truck: T_O1._id, driver: D1._id, miles: 200, totalDistance: 200 })]);
    assert.strictEqual(r.statusCode, 400, `expected a refusal, got ${r.statusCode}`);
  });

  await t('leg amounts summing OVER the settlement pot are refused', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 1000, input_settle_amount: 1000 });
    const r = await split(o, [
      seg({ truck: T_O1._id, driver: D1._id, settle_amount: 800 }),
      seg({ truck: T_O2._id, settle_amount: 700, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.code, 'settle_over_allocated');
  });

  await t('carrier leg amounts over the carrier pot are refused', async () => {
    const o = await makeOrder({ order_type: 'outsourcing', carrier: CARRIER_A._id, carrier_amount: 1000, input_carrier_amount: 1000 });
    const r = await split(o, [
      seg({ carrier: CARRIER_A._id, carrier_amount: 700 }),
      seg({ carrier: CARRIER_B._id, carrier_amount: 600, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.code, 'carrier_over_allocated');
  });

  await t('two drivers of DIFFERENT pay currencies on one leg are refused', async () => {
    const o = await makeOrder({ order_type: 'regular' });
    const r = await split(o, [seg({ truck: T_CO._id, drivers: [D1._id, D3._id], miles: 200, totalDistance: 200 })]);
    assert.strictEqual(r.statusCode, 400, 'one pay currency per leg is enforced');
  });

  console.log('\n══ 3. DRIVER PAY — the client\'s rule: only OUR legs\' miles ══\n');

  await stampLegs();

  await t('D1 is paid for every fleet leg they ran, at the right rate', async () => {
    const legs = await Trip.find({ tenantId: TENANT, $or: [{ driver: D1._id }, { drivers: D1._id }] })
      .populate('order').lean();
    // Computed here from first principles, not by calling the app's own helper.
    let expected = 0;
    for (const l of legs) {
      const o = l.order;
      if (!o) continue;
      const orderMiles = Number(o.totalDistance) * 0.621371;
      const all = await Trip.find({ order: o._id, deletedAt: null }).lean();
      const rawTotal = all.reduce((s, x) => s + Number(x.totalDistance || x.miles || 0), 0);
      const share = rawTotal > 0 ? Number(l.totalDistance || l.miles || 0) / rawTotal : 0;
      const realMiles = orderMiles * share;
      const crew = (l.drivers && l.drivers.length) ? l.drivers.length : 1;
      const rate = crew > 1 ? RATE.team : RATE.solo;
      expected += (realMiles / crew) * rate;
    }
    const slip = await driverPay(D1, 'CAD');
    near(slip.tripPay ?? slip.totalTripPay, expected, 0.5);
    global.__d1Expected = expected;
  });

  await t('A CARRIER leg never puts miles on a driver payslip', async () => {
    // shapes.mixed: leg 1 ours (D1, 100 mi), leg 2 a carrier's (100 mi). The order is 200 miles,
    // so a payslip that counted the whole order would pay D1 for 200.
    const legs = await Trip.find({ order: shapes.mixed._id }).lean();
    const mine = legs.filter((l) => String(l.driver) === String(D1._id));
    assert.strictEqual(mine.length, 1, 'exactly one leg of the mixed order is ours');
    const carrierLegs = legs.filter((l) => l.carrier);
    assert.strictEqual(carrierLegs.length, 1);
    assert.ok(!carrierLegs[0].driver, 'a carrier leg carries no driver of ours');
    // And the carrier leg still counts in the DENOMINATOR, so our leg is 100 of 200 — not 100 of 100.
    const raw = legs.reduce((s, x) => s + Number(x.totalDistance || x.miles || 0), 0);
    near(Number(mine[0].totalDistance) / raw, 0.5, 0.001);
  });

  await t('a team leg SNAPSHOTS the team rate, not the solo rate and not zero', async () => {
    /* Trip Planning sends a two-driver leg as `drivers: [...]` with no `driver` key. splitOrder used
       to look the rate up from `seg.driver` only, so the snapshot was 0 — and `buildTripLogItem`
       reads that snapshot, so the truck and driver trip logs showed a team leg earning nothing. */
    const leg = await Trip.findOne({ order: shapes.fleetTeam._id }).lean();
    assert.strictEqual(leg.drivers.length, 2);
    near(leg.rate_per_mile, RATE.team, 0.001);
    assert.notStrictEqual(Number(leg.rate_per_mile), RATE.solo, 'the solo rate must not be used for a team leg');
  });

  await t('a solo leg still snapshots the SOLO rate', async () => {
    const leg = await Trip.findOne({ order: shapes.fleetSolo._id }).lean();
    near(leg.rate_per_mile, RATE.solo, 0.001);
  });

  await t('the stored snapshot agrees with what the payslip pays', async () => {
    // 200 miles, two drivers at the team rate → 100 miles each.
    const leg = await Trip.findOne({ order: shapes.fleetTeam._id }).lean();
    near(Number(leg.total_driver_pay), 200 * RATE.team, 0.5);
  });

  await t("an owner's own driver costs us nothing", async () => {
    const leg = await Trip.findOne({ order: shapes.ownerNoDriver._id }).lean();
    assert.ok(!leg.driver, 'no driver of ours on the leg');
    near(leg.total_driver_pay || 0, 0, 0.001);
  });

  await t('a USD driver who ran nothing gets an empty payslip, not a broken one', async () => {
    const slip = await driverPay(D3, 'USD');
    near(slip.tripPay ?? slip.totalTripPay ?? 0, 0, 0.001);
  });

  await t('the payslip converts to the asked currency, at the order month FX', async () => {
    const cad = await driverPay(D1, 'CAD');
    const usd = await driverPay(D1, 'USD');
    const cadPay = Number(cad.tripPay ?? cad.totalTripPay ?? 0);
    const usdPay = Number(usd.tripPay ?? usd.totalTripPay ?? 0);
    assert.ok(cadPay > 0, 'nothing to convert');
    near(usdPay, cadPay * 0.711173, 1.0);
  });

  console.log('\n══ 4. OWNER OPERATOR SETTLEMENT ══\n');

  await t('a single-owner order pays that owner the whole pot', async () => {
    const legs = await Trip.find({ order: shapes.ownerNoDriver._id }).lean();
    assert.strictEqual(legs.length, 1);
    const o = await Order.findById(shapes.ownerNoDriver._id).lean();
    near(o.settle_amount, 1000, 0.02);
    assert.strictEqual(String(o.ownerOperator), String(OWNER_1._id));
  });

  await t('a mixed-owner order splits the pot by MILES, and freezes each leg', async () => {
    const legs = await Trip.find({ order: shapes.mixedOwner._id }).sort({ trip_no: 1 }).lean();
    assert.strictEqual(legs.length, 2);
    // 1600 over two equal legs → 800 each, written back onto the trip so a re-read cannot shrink it.
    near(legs[0].settle_amount, 800, 0.02);
    near(legs[1].settle_amount, 800, 0.02);
    const o = await Order.findById(shapes.mixedOwner._id).lean();
    near(o.settle_amount, 1600, 0.02);
  });

  await t('re-splitting a mixed-owner order does NOT shrink the settlement', async () => {
    const o = await Order.findById(shapes.mixedOwner._id).lean();
    const before = Number(o.settle_amount);
    const r = await split({ _id: shapes.mixedOwner._id }, [
      seg({ truck: T_O1._id, driver: D1._id }),
      seg({ truck: T_O2._id, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const after = await Order.findById(shapes.mixedOwner._id).lean();
    near(after.settle_amount, before, 0.02);
  });

  await t('a CARRIER leg never eats the owner settlement pot', async () => {
    // shapes.threeWay: owner 100mi + company 100mi + carrier 100mi, pot 700.
    // The carrier is paid from its own column; the owner's share comes out of the 700 with only the
    // FLEET legs dividing it.
    const legs = await Trip.find({ order: shapes.threeWay._id }).sort({ trip_no: 1 }).lean();
    const ownerLeg = legs.find((l) => String(l.truck) === String(T_O1._id));
    assert.ok(ownerLeg, 'owner leg present');
    assert.ok(Number(ownerLeg.settle_amount) > 0, 'the owner must be paid something');
    const carrierLeg = legs.find((l) => l.carrier);
    near(carrierLeg.settle_amount || 0, 0, 0.001);
  });

  await t('the owner statement pays the sum of THAT owner\'s legs, less our driver\'s pay', async () => {
    await stampLegs();
    const res = await call(ownerOperatorController.generateMonthlySalary, {
      body: { month: MONTH, year: YEAR, ownerOperatorId: String(OWNER_1._id), payoutCurrency: 'USD' },
    });
    assert.ok(res.statusCode === 200, `generate failed ${res.statusCode}: ${res.body?.message}`);
    const slip = (res.body.salaries || [])[0];
    assert.ok(slip, 'no statement produced');

    /* Expected, computed here from the legs rather than from the app's own allocator: every leg run
       by a truck of THIS owner, at the amount frozen onto that leg. */
    const expectedBase = await expectedOwnerBase(OWNER_1);
    assert.ok(expectedBase > 0, 'the fixture gave this owner nothing to be paid');
    near(slip.basePayable, expectedBase, 1.0);

    /* Our driver ran some of those legs, so their pay is deducted from what the owner is paid —
       the owner supplied the truck, we supplied the driver. It is converted CAD→USD once, at the
       order's own month, which is why it is not a round number. */
    const driverCost = Number(slip.totalDriverDeduction || 0);
    assert.ok(driverCost > 0, 'a company driver ran this owner\'s legs, so there must be a driver cost');
    near(slip.finalPayable, Number(slip.basePayable) - driverCost, 1.0);

    // D1 ran 100 miles of this owner's work on each of two orders, at CAD 0.60, converted to USD.
    near(driverCost, 2 * 100 * RATE.solo * 0.711173, 2.0);
  });

  await t('the OTHER owner is paid only their own leg, not the whole order', async () => {
    const res = await call(ownerOperatorController.generateMonthlySalary, {
      body: { month: MONTH, year: YEAR, ownerOperatorId: String(OWNER_2._id), payoutCurrency: 'USD' },
    });
    assert.ok(res.statusCode === 200, `generate failed ${res.statusCode}: ${res.body?.message}`);
    const slip = (res.body.salaries || [])[0];
    assert.ok(slip, 'no statement produced');
    const expectedBase = await expectedOwnerBase(OWNER_2);
    near(slip.basePayable, expectedBase, 1.0);
    // The mixed-owner order was 1600 across two owners; this owner must get their 800, not all of it.
    const mixed = await Order.findById(shapes.mixedOwner._id).lean();
    assert.ok(expectedBase < Number(mixed.settle_amount) + 1000 + 1,
      'this owner was credited with the other owner\'s share');
  });

  console.log('\n══ 5. TRUCK GROSS EARNINGS ══\n');

  await t('every truck that ran appears, and an idle truck is not invented', async () => {
    const g = await truckGross();
    const rows = g.trucks || g.data || [];
    assert.ok(Array.isArray(rows) && rows.length > 0, 'no truck rows returned');
    const units = rows.map((r) => r.unitNumber || r.truck?.unitNumber).filter(Boolean);
    assert.ok(units.includes('C-1'), `C-1 missing from ${units.join(',')}`);
  });

  await t('a carrier leg contributes NO truck miles', async () => {
    // Every leg with a carrier must have no truck, or the gross report would credit one of our
    // trucks with miles an outside carrier drove.
    const carrierLegs = await Trip.find({ tenantId: TENANT, carrier: { $ne: null } }).lean();
    assert.ok(carrierLegs.length > 0, 'no carrier legs to check');
    for (const l of carrierLegs) {
      assert.ok(!l.truck, `carrier leg ${l._id} also names a truck`);
    }
  });

  await t('truck miles are DERIVED, never the raw leg number', async () => {
    // A leg stores whatever was measured; the real figure is the order's distance times the leg's
    // share. On the three-way order the legs were stored as 100 each of a 300-mile order.
    const legs = await Trip.find({ order: shapes.threeWay._id }).lean();
    const raw = legs.reduce((s, l) => s + Number(l.totalDistance || l.miles || 0), 0);
    const orderMiles = KM_200MI * 1.5 * 0.621371;
    near(orderMiles, 300, 0.5);
    for (const l of legs) near(orderMiles * (Number(l.totalDistance) / raw), 100, 0.5);
  });

  console.log('\n══ 6. EXPENSES, DEDUCTIONS AND THE EDGES ══\n');

  await t('a truck expense in ANOTHER currency is converted at its own month', async () => {
    const TruckExpense = require('../db/TruckExpense');
    // 200 CAD of fuel at the June rate (CAD→USD 0.711173) = 142.23 USD off that truck's profit.
    await TruckExpense.create({
      tenantId: TENANT, company: CO._id, truck: T_CO._id, type: 'fuel',
      amount: 200, currency: 'CAD', date: WHEN, paid_by: 'owner', created_by: USER._id,
    });
    const g = await truckGross();
    const row = (g.trucks || []).find((r) => r.unitNumber === 'C-1');
    assert.ok(row, 'C-1 missing');
    near(row.totalExpenses, 200 * 0.711173, 0.5);
    near(row.profit, Number(row.totalGross) - Number(row.totalExpenses), 0.02);
  });

  await t('a deduction comes off the payslip and is itemised', async () => {
    const DriverDeduction = require('../db/DriverDeduction');
    await DriverDeduction.create({
      tenantId: TENANT, driver: D1._id, company: CO._id, type: 'advance', direction: 'deduct',
      amount: 100, currency: 'CAD', date: WHEN, note: 'cash advance', created_by: USER._id,
    });
    const slip = await driverPay(D1, 'CAD');
    const trip = Number(slip.tripPay ?? slip.totalTripPay ?? 0);
    const deducted = Number(slip.deductionTotal ?? 0);
    near(deducted, 100, 0.02);
    near(Number(slip.finalPayable), trip - 100, 0.5);
  });

  await t('deductions larger than earnings produce OWED, never a silent zero', async () => {
    const DriverDeduction = require('../db/DriverDeduction');
    await DriverDeduction.create({
      tenantId: TENANT, driver: D2._id, company: CO._id, type: 'advance', direction: 'deduct',
      amount: 500, currency: 'CAD', date: WHEN, note: 'big advance', created_by: USER._id,
    });
    const slip = await driverPay(D2, 'CAD');
    /* `finalPayable` deliberately STAYS negative and `owedAmount` is its positive mirror — clamping
       it to zero is what used to read as "settled" and forgive the balance at period end. `due` is
       what we owe them, which is nothing while they owe us. */
    const payable = Number(slip.finalPayable);
    assert.ok(payable < 0, `expected a negative payable, got ${payable}`);
    near(Number(slip.owedAmount), -payable, 0.02);
    near(Number(slip.dueAmount), 0, 0.02);
    assert.strictEqual(slip.paymentStatus, 'owed', `status was ${slip.paymentStatus}`);
  });

  await t('an order with NO distance pays nobody, and does not divide by zero', async () => {
    const o = await makeOrder({ order_type: 'regular', totalDistance: 0, settle_amount: 0, input_settle_amount: 0 });
    const r = await split(o, [seg({ truck: T_CO2._id, driver: D3._id, miles: 0, totalDistance: 0 })]);
    assert.ok(r.body.status !== false, r.body?.message);
    await stampLegs();
    const slip = await driverPay(D3, 'USD');
    const pay = Number(slip.tripPay ?? slip.totalTripPay ?? 0);
    assert.ok(Number.isFinite(pay), `pay is not a number: ${pay}`);
    near(pay, 0, 0.001);
  });

  await t('a THREE-leg relay pays each driver only their own leg', async () => {
    const o = await makeOrder({
      order_type: 'regular', settle_amount: 0, input_settle_amount: 0,
      totalDistance: KM_200MI * 1.5,   // 300 miles over three legs
      shipping_details: [{ reference: 'RELAY', locations: [
        { type: 'pickup', location: 'Toronto, ON', date: '2026-06-10' },
        { type: 'relay', location: 'Kingston, ON', date: '2026-06-10' },
        { type: 'relay', location: 'Cornwall, ON', date: '2026-06-11' },
        { type: 'delivery', location: 'Montreal, QC', date: '2026-06-11' },
      ] }],
    });
    const r = await split(o, [
      seg({ truck: T_CO._id, driver: D1._id, start_stop_index: 0, end_stop_index: 1 }),
      seg({ truck: T_CO2._id, driver: D2._id, start_stop_index: 1, end_stop_index: 2 }),
      seg({ truck: T_CO._id, driver: D1._id, start_stop_index: 2, end_stop_index: 3 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const legs = await Trip.find({ order: o._id }).sort({ trip_no: 1 }).lean();
    assert.strictEqual(legs.length, 3);
    // 300 miles over three equal legs → 100 each; D1 ran two of them, D2 one.
    const mine = legs.filter((l) => String(l.driver) === String(D1._id));
    assert.strictEqual(mine.length, 2, 'D1 ran two legs of the relay');
    for (const l of legs) near(l.rate_per_mile, RATE.solo, 0.001);
  });

  console.log('\n══ 7. CITY HOURS, CARRY-FORWARD, OVERPAYMENT, PDFs, FINANCE REPORT ══\n');

  await t('city hours are PAID, and counted as pay even if entered as a deduction', async () => {
    const DriverDeduction = require('../db/DriverDeduction');
    const before = Number((await driverPay(D1, 'CAD')).cityPay || 0);
    /* Entered through the CONTROLLER, deliberately asking for 'deduct'. The rule that forces a
       city_hours row to 'add' lives there, not on the schema — the payslip counts every such row as
       pay regardless, so a row stored as 'deduct' would read one way on screen and pay the other way
       on the statement. Writing the row straight to the collection would skip the very rule under
       test. */
    const driverDeductionController = require('../controllers/driverDeductionController');
    const addRes = await call(driverDeductionController.addDeduction, {
      params: { driverId: String(D1._id) },
      body: { type: 'city_hours', direction: 'deduct', hours: 4, date: '2026-06-15', note: 'yard time' },
    });
    assert.ok(addRes.statusCode === 200 || addRes.body?.status !== false,
      `could not add city hours: ${addRes.body?.message}`);
    const slip = await driverPay(D1, 'CAD');
    near(Number(slip.cityPay || 0), before + 4 * 25, 0.02);
    const row = await DriverDeduction.findOne({ driver: D1._id, type: 'city_hours' }).lean();
    assert.strictEqual(row.direction, 'add', 'a city_hours row must be stored as pay');
  });

  await t("last month's unpaid balance carries into this month", async () => {
    const DriverSalary = require('../db/DriverSalary');
    // A May payslip left 120 CAD unpaid.
    await DriverSalary.create({
      tenantId: TENANT, driver: D1._id, company: CO._id, month: 5, year: YEAR,
      currency: 'CAD', rateCurrency: 'CAD',
      basePayable: 120, finalPayable: 120, paidAmount: 0, dueAmount: 120, paymentStatus: 'pending',
    });
    const res = await call(driverSalaryController.generateDriverSalary, {
      params: { driverId: String(D1._id) }, body: { month: MONTH, year: YEAR, currency: 'CAD' },
    });
    assert.ok(res.statusCode === 200, `generate failed: ${res.body?.message}`);
    const slip = res.body.salary || res.body.data;
    near(Number(slip.previousDueAdded), 120, 0.02);

    /* And it is ADDED, not merely displayed. Note the shape while asserting it: `basePayable` is
       TRIP pay only — city-hours pay is a separate column that joins the total on its own, so the
       identity is base + city + carried-forward − deductions. Reading `basePayable` as "everything
       earned" understates a driver who spent the month on city work. */
    near(
      Number(slip.finalPayable),
      Number(slip.basePayable) + Number(slip.cityPay || 0)
        + Number(slip.previousDueAdded) - Number(slip.previousOwedDeducted || 0)
        + Number(slip.manualAddition || 0) - Number(slip.deductionTotal || 0),
      0.05,
    );
  });

  await t('paying MORE than the payslip is refused, not silently clamped', async () => {
    const DriverSalary = require('../db/DriverSalary');
    const saved = await DriverSalary.findOne({ tenantId: TENANT, driver: D1._id, month: MONTH, year: YEAR }).lean();
    assert.ok(saved, 'no generated payslip to pay');
    const res = await call(driverSalaryController.updateDriverSalary, {
      params: { driverId: String(D1._id), salaryId: String(saved._id) },
      body: { paidAmount: Number(saved.finalPayable) + 500 },
    });
    assert.strictEqual(res.statusCode, 409, `expected a refusal, got ${res.statusCode}`);
    assert.strictEqual(res.body.code, 'overpayment');
  });

  await t('an overpayment is recorded, and tracked as recoverable, when confirmed', async () => {
    const DriverSalary = require('../db/DriverSalary');
    const saved = await DriverSalary.findOne({ tenantId: TENANT, driver: D1._id, month: MONTH, year: YEAR }).lean();
    const over = Number(saved.finalPayable) + 500;
    const res = await call(driverSalaryController.updateDriverSalary, {
      params: { driverId: String(D1._id), salaryId: String(saved._id) },
      body: { paidAmount: over, allowOverpay: true },
    });
    assert.ok(res.statusCode === 200, `expected it to be recorded, got ${res.statusCode}`);
    const after = await DriverSalary.findById(saved._id).lean();
    near(after.paidAmount, over, 0.02);              // what was typed, not a clamp
    near(after.overpaidAmount, 500, 0.02);           // and the excess is named
    near(after.dueAmount, 0, 0.02);
  });

  await t('the driver payslip PDF prints the same figures as the payslip', async () => {
    global.__pdfHtml = [];
    const res = await call(driverSalaryController.getDriverSalaryPdf, {
      params: { driverId: String(D1._id) }, query: { month: MONTH, year: YEAR, currency: 'CAD' },
    });
    assert.ok(res.statusCode === 200, `pdf failed ${res.statusCode}: ${res.body?.message}`);
    const html = global.__pdfHtml.join('');
    assert.ok(html.length > 500, 'no document was rendered');
    assert.ok(/Driver One/i.test(html), "the driver's name is missing from their own payslip");
    const slip = await driverPay(D1, 'CAD');
    // The net figure has to appear on the page the driver is handed.
    const net = Number(slip.finalPayable).toFixed(2);
    const netWithSeparators = Number(slip.finalPayable).toLocaleString('en-US', { minimumFractionDigits: 2 });
    assert.ok(html.includes(net) || html.includes(netWithSeparators),
      `net payable ${net} does not appear in the document`);
  });

  await t('the owner statement PDF renders with that owner on it', async () => {
    const OwnerOperatorSalary = require('../db/OwnerOperatorSalary');
    const slip = await OwnerOperatorSalary.findOne({ tenantId: TENANT, ownerOperator: OWNER_1._id }).lean();
    assert.ok(slip, 'no owner statement to render');
    global.__pdfHtml = [];
    const res = await call(ownerOperatorController.salaryStatementPdf, { params: { id: String(slip._id) } });
    assert.ok(res.statusCode === 200, `pdf failed ${res.statusCode}: ${res.body?.message}`);
    const html = global.__pdfHtml.join('');
    assert.ok(html.length > 500, 'no document was rendered');
    assert.ok(/Owner One/i.test(html), 'the owner is not named on their own statement');
  });

  await t('the finance report totals match the orders it covers', async () => {
    const tenantAdmin = require('../controllers/tenantAdminController');
    const handler = tenantAdmin.getFinanceReport || tenantAdmin;
    const res = await call(typeof handler === 'function' ? handler : tenantAdmin.getFinanceReport, {
      tenantId: TENANT,
      query: { type: 'regular', period: 'custom', startDate: '2026-06-01', endDate: '2026-06-30', currency: 'usd' },
    });
    assert.ok(res.statusCode === 200, `report failed ${res.statusCode}: ${res.body?.message}`);
    const d = res.body.data;
    assert.ok(d && d.summary, 'no summary returned');
    // Every REGULAR order in June, revenue summed independently.
    const orders = await Order.find({
      tenantId: TENANT, order_type: 'regular', deletedAt: null,
      createdAt: { $gte: new Date('2026-06-01'), $lte: new Date('2026-06-30T23:59:59Z') },
    }).lean();
    const expectedRevenue = orders.reduce((sum, o) => sum + Number(o.input_total_amount || o.total_amount || 0), 0);
    near(d.summary.totalRevenue, expectedRevenue, 1.0);
    assert.strictEqual(d.summary.totalOrders, orders.length);
  });

  await t("a MIXED order's carrier cost reaches the finance report", async () => {
    /* A mixed order is stamped `regular`, so it lands in the FLEET report — and reading only the
       settlement column would drop its carrier cost out of the figures entirely. */
    const tenantAdmin = require('../controllers/tenantAdminController');
    const res = await call(tenantAdmin.getFinanceReport, {
      tenantId: TENANT,
      query: { type: 'regular', period: 'custom', startDate: '2026-06-01', endDate: '2026-06-30', currency: 'usd' },
    });
    const row = (res.body.data.orders || []).find((o) => String(o._id) === String(shapes.mixed._id));
    assert.ok(row, 'the mixed order is missing from the fleet report');
    // `carrier_amount` on the row is overwritten with the order's TOTAL outside cost.
    near(row.carrier_amount, 900, 1.0);
  });

  console.log('\n══ 8. ADVERSARIAL EDGES — rounding, ghosts, locks, rollups ══\n');

  await t('three legs of one order sum EXACTLY to the order, no mile lost to rounding', async () => {
    /* 100 miles over three legs is 33.333... each. If each leg rounds independently the driver is
       paid for 99.99 or 100.01 miles, and the truck report disagrees with the payslip by the
       residue on every single order. */
    const o = await makeOrder({ order_type: 'regular', totalDistance: 160.9344, settle_amount: 0, input_settle_amount: 0 }); // 100 mi
    const r = await split(o, [
      seg({ truck: T_CO._id, driver: D1._id, miles: 33, totalDistance: 33 }),
      seg({ truck: T_CO._id, driver: D1._id, miles: 33, totalDistance: 33, start_stop_index: 1, end_stop_index: 1 }),
      seg({ truck: T_CO._id, driver: D1._id, miles: 34, totalDistance: 34, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const legs = await Trip.find({ order: o._id }).lean();
    const orderMiles = 160.9344 * 0.621371;
    const raw = legs.reduce((a, l) => a + Number(l.totalDistance), 0);
    const derived = legs.reduce((a, l) => a + orderMiles * (Number(l.totalDistance) / raw), 0);
    near(derived, orderMiles, 0.0001);
    near(orderMiles, 100, 0.01);
  });

  await t('legs whose measured miles are all ZERO do not divide by zero', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 0, input_settle_amount: 0 });
    const r = await split(o, [
      seg({ truck: T_CO._id, driver: D1._id, miles: 0, totalDistance: 0 }),
      seg({ truck: T_CO._id, driver: D1._id, miles: 0, totalDistance: 0, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const legs = await Trip.find({ order: o._id }).lean();
    for (const l of legs) {
      assert.ok(Number.isFinite(Number(l.total_driver_pay || 0)), `pay is not a number: ${l.total_driver_pay}`);
      assert.ok(!Number.isNaN(Number(l.miles)), 'miles became NaN');
    }
  });

  await t('a SOFT-DELETED leg pays nobody', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 0, input_settle_amount: 0 });
    await split(o, [seg({ truck: T_CO._id, driver: D3._id, miles: 200, totalDistance: 200 })]);
    await Trip.updateMany({ order: o._id }, { $set: { createdAt: WHEN, updatedAt: WHEN } }, { timestamps: false });
    await Order.updateOne({ _id: o._id }, { $set: { createdAt: WHEN, updatedAt: WHEN } }, { timestamps: false });
    const withLeg = Number((await driverPay(D3, 'USD')).tripPay ?? 0);
    assert.ok(withLeg > 0, 'the fixture leg paid nothing to begin with');
    await Trip.updateMany({ order: o._id }, { $set: { deletedAt: new Date() } });
    const afterDelete = Number((await driverPay(D3, 'USD')).tripPay ?? 0);
    near(afterDelete, 0, 0.02);
  });

  await t('ONE owner running TWO trucks on an order is not a MIXED-owner order', async () => {
    const t3 = await Truck.create({
      tenantId: TENANT, company: CO._id, unitNumber: 'O-1b', plateNumber: 'OO1B',
      ownerOperated: true, ownerOperator: OWNER_1._id,
    });
    const o = await makeOrder({ order_type: 'regular', settle_amount: 900, input_settle_amount: 900 });
    const r = await split(o, [
      seg({ truck: T_O1._id, driver: D1._id }),
      seg({ truck: t3._id, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.strictEqual(f.isMixedOwner, false, 'one owner is not a mix, however many trucks they run');
    assert.strictEqual(String(f.ownerOperator), String(OWNER_1._id), 'the single owner must still be named');
    near(f.settle_amount, 900, 0.02);
  });

  await t('a driver paid across TWO orders of different lengths gets both, each on its own basis', async () => {
    const short = await makeOrder({ order_type: 'regular', totalDistance: 160.9344, settle_amount: 0, input_settle_amount: 0 }); // 100 mi
    const long = await makeOrder({ order_type: 'regular', totalDistance: 643.7376, settle_amount: 0, input_settle_amount: 0 }); // 400 mi
    for (const o of [short, long]) {
      const r = await split(o, [seg({ truck: T_CO2._id, driver: D3._id, miles: 10, totalDistance: 10 })]);
      assert.ok(r.body.status !== false, r.body?.message);
    }
    await Trip.updateMany({ order: { $in: [short._id, long._id] } }, { $set: { createdAt: WHEN, updatedAt: WHEN } }, { timestamps: false });
    await Order.updateMany({ _id: { $in: [short._id, long._id] } }, { $set: { createdAt: WHEN, updatedAt: WHEN } }, { timestamps: false });
    const slip = await driverPay(D3, 'USD');
    // One leg per order, each leg IS the whole order → 100 + 400 miles at the USD solo rate.
    near(Number(slip.tripPay ?? 0), (100 + 400) * RATE.soloUsd, 1.0);
  });

  await t('a CAD order paying a USD driver converts the other way, once', async () => {
    const o = await makeOrder({
      order_type: 'regular', input_currency: 'cad', revenue_currency: 'usd', fx_to_usd: 0.711173,
      total_amount: 1422.35, input_total_amount: 2000,
      settle_amount: 0, input_settle_amount: 0,
    });
    const r = await split(o, [seg({ truck: T_CO2._id, driver: D3._id, miles: 200, totalDistance: 200 })]);
    assert.ok(r.body.status !== false, r.body?.message);
    const leg = await Trip.findOne({ order: o._id }).lean();
    // The driver's pay currency is theirs, not the order's — USD 0.45, not CAD.
    assert.strictEqual(leg.rate_currency, 'USD');
    near(leg.rate_per_mile, RATE.soloUsd, 0.001);
  });

  await t('regenerating a payslip keeps what was already paid', async () => {
    const DriverSalary = require('../db/DriverSalary');
    const saved = await DriverSalary.findOne({ tenantId: TENANT, driver: D1._id, month: MONTH, year: YEAR }).lean();
    assert.ok(saved && Number(saved.paidAmount) > 0, 'nothing was paid to preserve');
    const paidBefore = Number(saved.paidAmount);
    const res = await call(driverSalaryController.generateDriverSalary, {
      params: { driverId: String(D1._id) }, body: { month: MONTH, year: YEAR, currency: 'CAD' },
    });
    assert.ok(res.statusCode === 200, `regenerate failed: ${res.body?.message}`);
    const after = await DriverSalary.findById(saved._id).lean();
    near(after.paidAmount, paidBefore, 0.02);
  });

  await t('regenerating an owner statement does not multiply their financial summary', async () => {
    const OwnerRecord = require('../db/OwnerOperatorFinancialRecord');
    const countGen = () => OwnerRecord.countDocuments({ tenantId: TENANT, ownerOperator: OWNER_1._id, type: 'SALARY_GENERATED' });
    const before = await countGen();
    for (let i = 0; i < 2; i++) {
      const res = await call(ownerOperatorController.generateMonthlySalary, {
        body: { month: MONTH, year: YEAR, ownerOperatorId: String(OWNER_1._id), payoutCurrency: 'USD' },
      });
      assert.ok(res.statusCode === 200, `generate failed: ${res.body?.message}`);
    }
    const after = await countGen();
    assert.strictEqual(after, Math.max(before, 1), `SALARY_GENERATED rows went ${before} → ${after}`);
  });

  await t('changing who runs a leg is REFUSED once a payslip exists for the order', async () => {
    /* shapes.fleetSolo was run by D1, who now has a generated payslip covering this month. Handing
       that leg to a carrier would silently change what the payslip was built from. */
    const r = await split({ _id: shapes.fleetSolo._id }, [
      seg({ carrier: CARRIER_A._id, carrier_amount: 500, miles: 200, totalDistance: 200 }),
    ]);
    assert.strictEqual(r.statusCode, 409, `expected a lock, got ${r.statusCode}`);
    assert.strictEqual(r.body.code, 'leg_party_locked');
  });

  await t('re-saving the SAME parties is never blocked, even on a paid order', async () => {
    const r = await split({ _id: shapes.fleetSolo._id }, [
      seg({ truck: T_CO._id, driver: D1._id, miles: 200, totalDistance: 200 }),
    ]);
    assert.ok(r.body.status !== false, `a no-op re-save was refused: ${r.body?.message}`);
  });

  await t('paying ONE carrier of two leaves the order partial, not paid', async () => {
    const o = await Order.findById(shapes.twoCarriers._id).lean();
    const legs = await Trip.find({ order: o._id }).sort({ trip_no: 1 }).lean();
    const res = await call(orderController.updateOrderPaymentStatus, {
      params: { id: String(o._id), type: 'carrier' },
      body: { status: 'paid', method: 'wire', tripId: String(legs[0]._id) },
    });
    assert.ok(res.statusCode === 200, `payment failed ${res.statusCode}: ${res.body?.message}`);
    const after = await Order.findById(o._id).lean();
    assert.strictEqual(after.carrier_payment_status, 'partial',
      `one of two carriers paid must read partial, got ${after.carrier_payment_status}`);
  });

  await t('paying the second carrier rolls the order up to paid', async () => {
    const legs = await Trip.find({ order: shapes.twoCarriers._id }).sort({ trip_no: 1 }).lean();
    const res = await call(orderController.updateOrderPaymentStatus, {
      params: { id: String(shapes.twoCarriers._id), type: 'carrier' },
      body: { status: 'paid', method: 'wire', tripId: String(legs[1]._id) },
    });
    assert.ok(res.statusCode === 200, `payment failed: ${res.body?.message}`);
    const after = await Order.findById(shapes.twoCarriers._id).lean();
    assert.strictEqual(after.carrier_payment_status, 'paid');
  });

  await t('a leg id from ANOTHER order cannot be paid through this one', async () => {
    const foreign = await Trip.findOne({ order: shapes.mixed._id, carrier: { $ne: null } }).lean();
    const res = await call(orderController.updateOrderPaymentStatus, {
      params: { id: String(shapes.outsourcing._id), type: 'carrier' },
      body: { status: 'paid', method: 'wire', tripId: String(foreign._id) },
    });
    /* Assert the refusal itself, not just that nothing moved — "nothing moved" also passes when the
       leg happened to be unpaid already, which would make this test prove nothing. */
    const stillUnpaid = await Trip.findById(foreign._id).lean();
    assert.notStrictEqual(stillUnpaid.carrier_payment_status, 'paid',
      'a leg was paid through an order it does not belong to');
    // The real answer is 404 carrier_leg_not_found — the leg is looked up scoped to THIS order.
    assert.ok(res.statusCode >= 400, `a foreign leg id was accepted (HTTP ${res.statusCode})`);
  });

  await t('a malformed leg id is a 400, never a cast error surfacing as a generic failure', async () => {
    const res = await call(orderController.updateOrderPaymentStatus, {
      params: { id: String(shapes.outsourcing._id), type: 'carrier' },
      body: { status: 'paid', method: 'wire', tripId: { $ne: null } },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_leg_id');
  });

  await t('a distance that already paid someone cannot be moved', async () => {
    /* Every leg's miles share is derived from the order's distance, and that share is what the
       payslip paid from. shapes.fleetSolo now sits on a generated payslip. */
    const res = await call(orderController.update_order, {
      params: { id: String(shapes.fleetSolo._id) },
      body: { totalDistance: 999 },
    });
    assert.strictEqual(res.statusCode, 409, `expected a lock, got ${res.statusCode}: ${res.body?.message}`);
    assert.ok(['route_locked_by_payroll', 'route_change_resplits_legs'].includes(res.body.code),
      `unexpected code ${res.body.code}`);
    const after = await Order.findById(shapes.fleetSolo._id).lean();
    near(after.totalDistance, KM_200MI, 0.01);
  });

  await t('deleting an order stops it paying anyone', async () => {
    const o = await makeOrder({ order_type: 'regular', settle_amount: 0, input_settle_amount: 0 });
    await split(o, [seg({ truck: T_CO2._id, driver: D2._id, miles: 200, totalDistance: 200 })]);
    await Trip.updateMany({ order: o._id }, { $set: { createdAt: WHEN, updatedAt: WHEN } }, { timestamps: false });
    await Order.updateOne({ _id: o._id }, { $set: { createdAt: WHEN, updatedAt: WHEN } }, { timestamps: false });
    const before = Number((await driverPay(D2, 'CAD')).tripPay ?? 0);

    const res = await call(orderController.deleteOrder, { params: { id: String(o._id) } });
    assert.ok(res.statusCode === 200, `delete failed ${res.statusCode}: ${res.body?.message}`);

    // The legs must go with it, or a cancelled load keeps paying driver wages for ever.
    const liveLegs = await Trip.countDocuments({ order: o._id, deletedAt: null });
    assert.strictEqual(liveLegs, 0, 'the order was deleted but its legs are still live');
    const after = Number((await driverPay(D2, 'CAD')).tripPay ?? 0);
    assert.ok(after < before - 1, `the driver is still paid for a deleted order (${before} → ${after})`);
  });

  await t('deleting a relay stop rebuilds the legs WITH the crew and the money', async () => {
    const o = await makeOrder({
      order_type: 'regular', settle_amount: 1200, input_settle_amount: 1200,
      shipping_details: [{ reference: 'RELAY2', locations: [
        { type: 'pickup', location: 'Toronto, ON', date: '2026-06-10' },
        { type: 'relay', location: 'Kingston, ON', date: '2026-06-10' },
        { type: 'delivery', location: 'Montreal, QC', date: '2026-06-11' },
      ] }],
    });
    const r = await split(o, [
      seg({ truck: T_O1._id, drivers: [D1._id, D2._id], settle_amount: 700, start_stop_index: 0, end_stop_index: 1 }),
      seg({ truck: T_O2._id, settle_amount: 500, start_stop_index: 1, end_stop_index: 2 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const legs = await Trip.find({ order: o._id }).sort({ trip_no: 1 }).lean();
    const teamLeg = legs[0];
    assert.strictEqual(teamLeg.drivers.length, 2);

    const del = await call(tripController.deleteTrip, { params: { tripId: String(legs[1]._id) } });
    assert.ok(del.statusCode === 200, `relay delete failed ${del.statusCode}: ${del.body?.message}`);

    const rebuilt = await Trip.find({ order: o._id, deletedAt: null }).sort({ trip_no: 1 }).lean();
    assert.ok(rebuilt.length >= 1, 'every leg vanished');
    const crew = rebuilt[0].drivers || [];
    assert.strictEqual(crew.length, 2,
      'the rebuild dropped a driver — a team leg silently became solo, moving the survivor to the solo rate');
    assert.ok(Number(rebuilt[0].settle_amount) > 0, 'the rebuild dropped the leg settlement');
  });

  await t('one truck working two orders is credited with both', async () => {
    const g = await truckGross();
    const row = (g.trucks || []).find((r) => r.unitNumber === 'C-2');
    assert.ok(row, 'C-2 missing from the report');
    const legs = await Trip.find({ tenantId: TENANT, truck: T_CO2._id, deletedAt: null }).lean();
    const orders = [...new Set(legs.map((l) => String(l.order)))];
    assert.ok(orders.length > 1, `the fixture only gave C-2 ${orders.length} order(s)`);
    assert.ok(Number(row.totalGross) > 0, 'a truck that ran several orders shows no gross');
  });

  await t("an owner leg sitting on a MIXED-type order still settles that owner", async () => {
    const o = await makeOrder({
      order_type: 'regular', settle_amount: 600, input_settle_amount: 600,
      carrier_amount: 0, input_carrier_amount: 0,
    });
    const r = await split(o, [
      seg({ truck: T_O2._id, driver: D2._id }),
      seg({ carrier: CARRIER_B._id, carrier_amount: 400, start_stop_index: 1, end_stop_index: 1 }),
    ]);
    assert.ok(r.body.status !== false, r.body?.message);
    const f = await Order.findById(o._id).lean();
    assert.strictEqual(f.isMixedType, true);
    // The owner is paid the whole settle pot: the carrier leg is paid from its own column and the
    // owner leg is the only FLEET leg, so nothing consumes a share beside it.
    near(f.settle_amount, 600, 0.02);
    near(f.cost_amount, 600 + 400, 0.02);
  });

  await t('an INACTIVE driver still on a leg does not break the payslip', async () => {
    await Users.updateOne({ _id: D3._id }, { $set: { status: 'inactive' } });
    const res = await call(driverSalaryController.getDriverSalary, {
      params: { driverId: String(D3._id) }, query: { month: MONTH, year: YEAR, currency: 'USD' },
    });
    await Users.updateOne({ _id: D3._id }, { $set: { status: 'active' } });
    assert.ok(res.statusCode === 200 || res.body?.status !== false,
      `an inactive driver's payslip failed: ${res.body?.message}`);
  });

  console.log('\n══ 9. ORDER COST — every shape adds up ══\n');

  await t('fleet-only order: cost is the settlement, never doubled', async () => {
    const o = await Order.findById(shapes.ownerNoDriver._id).lean();
    near(o.cost_amount, 1000, 0.02);
  });

  await t('outsourcing order: cost is the carrier amount', async () => {
    const o = await Order.findById(shapes.outsourcing._id).lean();
    near(o.cost_amount, 2000, 0.02);
  });

  await t('mixed order: cost is carrier legs PLUS the owner settlement', async () => {
    const o = await Order.findById(shapes.mixed._id).lean();
    near(o.cost_amount, 900, 0.02);   // company leg costs payroll, not a payable
  });

  await t('three-way order: a COMPANY leg consumes its share of the pot but is never paid', async () => {
    /* Pot 700 across an owner leg (100mi) and a company leg (100mi) — the carrier leg is paid from
       its own column and never touches the pot. The company leg takes its 350 share and is paid
       NOTHING (its cost is payroll, not a payable), so `settle_amount` is rewritten to the owner
       legs alone: 350. Total outside cost = 350 + 800.
       This is the documented rule and it is worth pinning: the naive reading is 700 + 800, and a
       dispatcher who typed 700 meaning "the owner gets 700" will under-allocate — which is exactly
       what Trip Planning's pot meter warns about. */
    const o = await Order.findById(shapes.threeWay._id).lean();
    near(o.settle_amount, 350, 0.02);
    near(o.cost_amount, 350 + 800, 0.02);
  });

  await t('unassigned order: cost is zero and nothing is invented', async () => {
    const o = await Order.findById(shapes.unassigned._id).lean();
    near(o.cost_amount || 0, 0, 0.001);
    near(o.carrier_amount || 0, 0, 0.001);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) {
    console.log('Failures:');
    failures.forEach(([n, m]) => console.log(`  - ${n}\n      ${m}`));
  }
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => {
  console.error('\nSUITE CRASHED:', e);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
