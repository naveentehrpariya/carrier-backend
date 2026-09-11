/**
 * Seed a complete tenant into a LOCAL database so the app can be driven in a real browser.
 *
 *   mongod --dbpath /tmp/carrier-browser --port 27099 --fork --logpath /tmp/carrier-browser/log
 *   TEST_DB_URL=mongodb://127.0.0.1:27099/carrier_browser node scripts/seed-browser-test.js
 *   DB_URL_OFFICE=mongodb://127.0.0.1:27099/carrier_browser PORT=8099 node index.js
 *   cd ../frontend && BROWSER=none PORT=3001 REACT_APP_API_URL=http://localhost:8099 npm start
 *   # then open http://localhost:3001 and log in with the credentials this script prints
 *
 * Refuses any non-localhost URI — it drops the database. **Never point it at DB_URL_OFFICE, which
 * is production.**
 *
 * What it builds is the smallest set that can exercise every order shape end to end:
 *   - a company truck AND an owner-operated truck, so a fleet leg can be either party
 *   - TWO carriers, so one order can be split between them
 *   - an ACTIVE subscription — /order/add refuses every request without one
 *   - monthly FX rows — the money paths hard-fail (`fx_unavailable`) rather than convert 1:1
 *   - charge + equipment master data, without which the order form's selects are empty and its
 *     `isObjectValid` check silently refuses to submit
 */
require('dotenv').config();
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_browser';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to seed a non-local database: ${URI}`);
  process.exit(1);
}

const Tenant = require('../db/Tenant');
const Company = require('../db/Company');
const Users = require('../db/Users');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const Truck = require('../db/Truck');
const Trailer = require('../db/Trailer');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const ConversionRate = require('../db/ConversionRate');
const Charges = require('../db/Charges');
const Equipment = require('../db/Equipment');

const TENANT = 'testco';
const PASSWORD = 'Test@12345';

(async () => {
  await mongoose.connect(URI, { autoIndex: true });
  await mongoose.connection.dropDatabase();

  const co = await Company.create({
    tenantId: TENANT, name: 'Test Carriers Inc', email: 'ops@testco.com', phone: '4160000000',
    address: '1 Yonge St, Toronto, ON',
    // Deliberately NOT 'CMC' — a hardcoded prefix anywhere shows up immediately.
    order_prefix: 'TST',
    route_country_policy: 'domestic_only',
  });

  const plan = await SubscriptionPlan.create({
    name: 'Test Unlimited', slug: 'test-unlimited', description: 'Unlimited plan for browser testing',
    monthlyPrice: 0, currency: 'USD',
    maxOrders: 0, maxUsers: 0, isActive: true,   // 0 = unlimited; a run must not hit an order cap
    allowedModules: ['regular', 'outsourcing'],
  });

  const endDate = new Date(); endDate.setFullYear(endDate.getFullYear() + 5);
  await Tenant.create({
    tenantId: TENANT, name: 'Test Carriers Inc', subdomain: TENANT,
    domain: `${TENANT}.example.com`, status: 'active',
    contactInfo: { adminName: 'Admin', adminEmail: 'admin@testco.com' },
    subscription: {
      status: 'active', plan: plan._id, planSlug: plan.slug, billingCycle: 'yearly',
      startDate: new Date(), endDate, allowedModules: ['regular', 'outsourcing'],
    },
  });

  const mkUser = (o) => Users.create({
    tenantId: TENANT, password: PASSWORD, phone: '4160000001', country: 'CA',
    address: '1 St, Toronto', status: 'active', company: co._id, ...o,
  });

  const admin = await mkUser({
    name: 'Test Admin', email: 'admin@testco.com', corporateID: 'AD1',
    is_admin: 1, role: 3, isTenantAdmin: true, staff_commision: 10,
    permissions: ['regular', 'outsourcing', 'accounting', 'customers', 'customers_write',
      'carriers', 'carriers_write', 'employees', 'subadmin', 'invoices'],
    allowedModules: ['regular', 'outsourcing'],
  });
  const driver1 = await mkUser({ name: 'Dave Driver', email: 'dave@testco.com', corporateID: 'DR1', permissions: ['driver'] });
  const driver2 = await mkUser({ name: 'Sam Second', email: 'sam@testco.com', corporateID: 'DR2', permissions: ['driver'] });

  // Both CAD so a team leg is legal — one pay currency per trip is enforced.
  for (const d of [driver1, driver2]) {
    await DriverProfile.create({
      tenantId: TENANT, user: d._id, company: co._id, licenseNumber: `LIC-${d.corporateID}`,
      ratePerMile: 0.55, ratePerMileSolo: 0.55, ratePerMileTeam: 0.45,
      cityHoursRate: 25, rateCurrency: 'CAD',
    });
  }

  const owner = await OwnerOperator.create({
    tenantId: TENANT, company: co._id, ownerOperatorId: 'OO1', fullName: 'Olly Owner',
    companyName: 'Olly Transport Ltd', phone: '4160000002', email: 'olly@testco.com',
    address: '5 Owner Way', state: 'ON', city: 'Mississauga', zipcode: 'L5B', status: 'active',
  });
  const companyTruck = await Truck.create({
    tenantId: TENANT, company: co._id, unitNumber: 'T-100', plateNumber: 'CO100AB',
    vin: '1FUJGLDR0CSBP1000', make: 'Freightliner', model: 'Cascadia', year: 2021, ownerOperated: false,
  });
  const ownerTruck = await Truck.create({
    tenantId: TENANT, company: co._id, unitNumber: 'T-200', plateNumber: 'OO200CD',
    vin: '1FUJGLDR0CSBP2000', make: 'Volvo', model: 'VNL', year: 2022,
    ownerOperated: true, ownerOperator: owner._id,
  });
  await Trailer.create({
    tenantId: TENANT, company: co._id, unitNumber: 'TR-1', plateNumber: 'TRL001',
    type: 'Dry Van', make: 'Utility', model: '3000R', year: 2020, isActive: true,
  });

  const carrierA = await Carrier.create({
    tenantId: TENANT, company: co._id, name: 'Alpha Freight Lines', mc_code: 'MC100100',
    phone: '4165551111', email: 'alpha@carriers.com', country: 'Canada', state: 'ON',
    city: 'Brampton', zipcode: 'L6T 3T6', location: '40 West Drive, Brampton, ON', carrierID: 'CA1',
  });
  const carrierB = await Carrier.create({
    tenantId: TENANT, company: co._id, name: 'Beta Cartage Co', mc_code: 'MC200200',
    phone: '4165552222', email: 'beta@carriers.com', country: 'Canada', state: 'ON',
    city: 'Windsor', zipcode: 'N8X', location: '9 Dock Rd, Windsor, ON', carrierID: 'CA2',
  });
  const customer = await Customer.create({
    tenantId: TENANT, company: co._id, name: 'Northern Retail Group', email: 'ap@northern.com',
    phone: '4165559090', address: '1234 Main St', country: 'Canada', state: 'ON',
    city: 'Toronto', zipcode: 'M5V 2T6', created_by: admin._id,
  });

  for (const name of ['Line Haul', 'Fuel Surcharge', 'Detention', 'Border Crossing']) {
    await Charges.create({ tenantId: TENANT, name, created_by: admin._id }).catch(() => {});
  }
  for (const name of ['Dry Van', 'Reefer', 'Flatbed']) {
    await Equipment.create({ tenantId: TENANT, name, created_by: admin._id }).catch(() => {});
  }

  // This month and the two before it. Real Aug-2026 pairs — note they are NOT exact reciprocals,
  // which is the whole reason money is converted once, at the row's own month.
  const now = new Date();
  const pairs = [['USD','CAD',1.402359], ['CAD','USD',0.711173], ['USD','USD',1], ['CAD','CAD',1],
                 ['INR','USD',0.0119], ['USD','INR',84.2]];
  for (let back = 0; back < 3; back++) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    for (const [sourceCurrency, targetCurrency, rate] of pairs) {
      // The fields are `sourceCurrency`/`targetCurrency`. They were written as `fromCurrency`/
      // `toCurrency`, which strict mode drops — so `sourceCurrency` was missing, the required-field
      // error was swallowed by the `.catch()` below, and this seed produced ZERO FX rows while
      // reporting success. Not caught, so a broken rate row fails loudly next time.
      await ConversionRate.create({
        tenantId: TENANT, month: d.getMonth() + 1, year: d.getFullYear(),
        sourceCurrency, targetCurrency, rate, createdBy: admin._id,
      });
    }
  }

  console.log(JSON.stringify({
    uri: URI, tenant: TENANT,
    login: { email: admin.email, password: PASSWORD },
    ids: {
      company: String(co._id), admin: String(admin._id),
      driver1: String(driver1._id), driver2: String(driver2._id), owner: String(owner._id),
      companyTruck: String(companyTruck._id), ownerTruck: String(ownerTruck._id),
      carrierA: String(carrierA._id), carrierB: String(carrierB._id), customer: String(customer._id),
    },
  }, null, 2));

  await mongoose.connection.close();
  process.exit(0);
})().catch((e) => { console.error('Seed failed:', e); process.exit(1); });
