/**
 * Seed a complete, EMPTY tenant so a person can sign in and start adding orders immediately.
 *
 *   node scripts/seed-demo-tenant.js                 # dry run — says exactly what it would write
 *   node scripts/seed-demo-tenant.js --apply
 *   node scripts/seed-demo-tenant.js --tenant=demo-two --email-domain=demo2.ca --apply
 *   node scripts/seed-demo-tenant.js --tenant=demo-logistics --remove --apply
 *
 * Unlike `seed-browser-test.js` this is SAFE ON A LIVE DATABASE: it never drops anything, never
 * touches a document that is not its own tenant's, and refuses to run at all if the slug is
 * already taken. Everything it writes is scoped by `tenantId`, which is how the whole app scopes
 * every query — so the new company is invisible to every existing one.
 *
 * What it builds is the smallest set that makes `Add Order` actually work:
 *   - an ACTIVE subscription (`/order/add` 403s `subscription_inactive` without one), reusing a
 *     plan record that already exists — a new plan would show up in every tenant's billing page
 *   - monthly FX rows (order create throws `fx_unavailable` rather than convert 1:1)
 *   - charges + equipment master data, or the order form's selects are empty and `isObjectValid`
 *     refuses to submit with a message that points at the wrong card
 *   - a company truck AND an owner-operated truck, so a leg can be either party
 *   - two carriers, so one order can be split between them
 *
 * `--remove` deletes only what this script creates, and refuses on any tenant that has orders or
 * legs — a tenant somebody has actually worked in is not a test fixture any more.
 */
require('dotenv').config();
const mongoose = require('mongoose');

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
const Order = require('../db/Order');
const Trip = require('../db/Trip');

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');
const TENANT = arg('tenant', 'demo-logistics');
const PASSWORD = arg('password', 'Demo@12345');
const PREFIX = arg('prefix', 'DEM').toUpperCase();
/* Short, because this is what gets typed at the login box every day. It is NOT derived from the
 * slug: a second demo tenant would then be silently fine, and the day someone wants two they get a
 * clear collision error telling them to pass --email-domain instead of a login they cannot guess. */
const DOMAIN = arg('email-domain', 'demofreight.ca');

/* A tenant slug that does not look like a demo is almost certainly a real company. The check is
 * belt and braces — `--remove` also refuses any tenant carrying orders — but a typo'd slug is
 * exactly how a cleanup flag turns into an incident. */
if (!/^[a-z][a-z0-9-]{2,40}$/.test(TENANT)) {
  console.error(`Refusing: "${TENANT}" is not a valid tenant slug (lowercase letters, digits, dashes).`);
  process.exit(1);
}

async function main() {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) { console.error('No DB_URL_OFFICE / MONGODB_URI in the environment.'); process.exit(1); }

  // `db/config` connects with autoIndex:true, which would BUILD indexes on a live database as a
  // side effect of running a script. Open our own connection instead.
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`Connected to ${mongoose.connection.name}${APPLY ? '' : '  (DRY RUN — nothing will be written)'}`);
  console.log(`Tenant: ${TENANT}\n`);

  if (REMOVE) return await remove();
  return await seed();
}

/* ------------------------------------------------------------------ remove */

async function remove() {
  const tenant = await Tenant.findOne({ tenantId: TENANT }).lean();
  const company = await Company.findOne({ tenantId: TENANT }).lean();
  if (!tenant && !company) { console.log('Nothing to remove — no tenant with that id.'); return; }

  const orders = await Order.countDocuments({ tenantId: TENANT });
  const trips = await Trip.countDocuments({ tenantId: TENANT });
  if (orders || trips) {
    console.error(`REFUSING to remove: this tenant has ${orders} order(s) and ${trips} leg(s).`);
    console.error('Somebody has done real work in it. Delete those first if you truly mean to.');
    process.exitCode = 1;
    return;
  }

  const targets = [
    [Users, 'users'], [DriverProfile, 'driver profiles'], [Customer, 'customers'],
    [Carrier, 'carriers'], [Truck, 'trucks'], [Trailer, 'trailers'],
    [OwnerOperator, 'owner operators'], [Charges, 'charges'], [Equipment, 'equipment'],
    [ConversionRate, 'fx rows'], [Company, 'company'], [Tenant, 'tenant'],
  ];
  for (const [Model, label] of targets) {
    const key = Model === Tenant ? { tenantId: TENANT } : { tenantId: TENANT };
    const n = await Model.countDocuments(key);
    if (!n) continue;
    console.log(`  ${APPLY ? 'deleting' : 'would delete'} ${n} ${label}`);
    if (APPLY) await Model.deleteMany(key);
  }
  console.log(APPLY ? '\nRemoved.' : '\nDry run — re-run with --apply.');
}

/* -------------------------------------------------------------------- seed */

async function seed() {
  const clash = await Tenant.findOne({ tenantId: TENANT }).lean();
  if (clash) {
    console.error(`REFUSING: tenant "${TENANT}" already exists (${clash.name}).`);
    console.error('Pick another with --tenant=<slug>, or remove it with --remove --apply.');
    process.exitCode = 1;
    return;
  }

  const people = [
    { key: 'admin',   name: 'Demo Admin',   email: `admin@${DOMAIN}`,  corporateID: 'DEM-AD1' },
    { key: 'driver1', name: 'Harry Singh',  email: `harry@${DOMAIN}`,  corporateID: 'DEM-DR1' },
    { key: 'driver2', name: 'Marco Rossi',  email: `marco@${DOMAIN}`,  corporateID: 'DEM-DR2' },
  ];

  /* `Users.email` is GLOBALLY unique, not tenant-scoped — multi-tenant login resolves the account
   * from the email alone. A collision here would not be a duplicate demo user, it would be a
   * write that fails halfway through and leaves the tenant half-built. */
  const taken = await Users.find(
    { email: { $in: people.map((p) => p.email) } },
    { email: 1, tenantId: 1 },
  ).setOptions({ includeInactive: true }).lean();
  if (taken.length) {
    console.error('REFUSING: these login emails are already in use (they are unique across ALL tenants):');
    taken.forEach((u) => console.error(`  ${u.email}  (${u.tenantId})`));
    console.error('Re-run with a different --tenant=<slug> — the emails are derived from it.');
    process.exitCode = 1;
    return;
  }

  /* Reuse a plan that already exists. Creating one would add a row to the catalogue every other
   * tenant reads on its billing page. */
  const plan = await SubscriptionPlan.findOne({ isActive: true }).sort({ monthlyPrice: -1 }).lean();
  if (!plan) {
    console.error('REFUSING: no active subscription plan on this database to attach the tenant to.');
    console.error('Run scripts/seed-subscription-plans.js --apply first.');
    process.exitCode = 1;
    return;
  }

  const plannedFx = fxPlan();
  console.log('Will create:');
  console.log(`  tenant        ${TENANT}  (subdomain ${TENANT}, plan "${plan.name}", active 5 years)`);
  console.log(`  company       Demo Freight Systems  (order prefix ${PREFIX}-)`);
  console.log(`  users         ${people.map((p) => `${p.name} <${p.email}>`).join(', ')}`);
  console.log('  drivers       2 driver profiles @ CAD 0.58 solo / 0.48 team, 28/hr city');
  console.log('  owner op      Gurpreet Dhaliwal (Dhaliwal Transport Ltd) + owner-operated truck D-201');
  console.log('  trucks        C-101 (company), D-201 (owner operated)   trailers: TRL-11, TRL-12');
  console.log('  carriers      Maple Line Logistics, Silverway Carriers');
  console.log('  customers     Northbridge Retail Group, Harbourline Foods');
  console.log(`  charges       ${CHARGES.length} revenue items`);
  console.log(`  equipment     ${EQUIPMENT.length} equipment types`);
  console.log(`  fx            ${plannedFx.length} monthly rates (this month, 3 back, 1 forward)\n`);

  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  const co = await Company.create({
    tenantId: TENANT, name: 'Demo Freight Systems',
    email: `ops@${DOMAIN}`, phone: '4160000100',
    address: '120 Adelaide St W, Toronto, ON M5H 1T1',
    order_prefix: PREFIX,
    route_country_policy: 'domestic_only',
  });

  const endDate = new Date(); endDate.setFullYear(endDate.getFullYear() + 5);
  await Tenant.create({
    tenantId: TENANT, name: 'Demo Freight Systems', subdomain: TENANT, domain: DOMAIN,
    status: 'active',
    contactInfo: { adminName: 'Demo Admin', adminEmail: `admin@${DOMAIN}`, phone: '4160000100' },
    subscription: {
      plan: plan._id, planSlug: plan.slug, status: 'active', billingCycle: 'yearly',
      startDate: new Date(), endDate,
      allowedModules: ['regular', 'outsourcing'],
      planLimits: {
        maxUsers: plan.maxUsers || 0, maxOrders: plan.maxOrders || 0,
        maxCustomers: plan.maxCustomers || 0, maxCarriers: plan.maxCarriers || 0,
      },
    },
  });

  const mkUser = (o) => Users.create({
    tenantId: TENANT, password: PASSWORD, phone: '4160000101', country: 'Canada',
    address: '120 Adelaide St W, Toronto, ON', status: 'active', company: co._id, ...o,
  });

  const admin = await mkUser({
    name: people[0].name, email: people[0].email, corporateID: people[0].corporateID,
    is_admin: 1, role: 3, isTenantAdmin: true, staff_commision: 10,
    permissions: ['regular', 'outsourcing', 'accounting', 'customers', 'customers_write',
      'carriers', 'carriers_write', 'employees', 'subadmin', 'invoices'],
    allowedModules: ['regular', 'outsourcing'],
  });

  const drivers = [];
  for (const p of people.slice(1)) {
    const u = await mkUser({ name: p.name, email: p.email, corporateID: p.corporateID, permissions: ['driver'] });
    /* Both CAD on purpose: one pay currency per trip is enforced, so two drivers of different
     * currencies could never share a team leg. */
    await DriverProfile.create({
      tenantId: TENANT, user: u._id, company: co._id,
      licenseNumber: `ON-${p.corporateID}`, licenseState: 'ON',
      ratePerMile: 0.58, ratePerMileSolo: 0.58, ratePerMileTeam: 0.48,
      cityHoursRate: 28, rateCurrency: 'CAD',
    });
    drivers.push(u);
  }

  const owner = await OwnerOperator.create({
    tenantId: TENANT, company: co._id, ownerOperatorId: 'OO-01',
    fullName: 'Gurpreet Dhaliwal', companyName: 'Dhaliwal Transport Ltd',
    phone: '9050000200', email: `gurpreet@${DOMAIN}`,
    address: '88 Kennedy Rd S', city: 'Brampton', state: 'ON', zipcode: 'L6W 3E7',
    country: 'Canada', status: 'active',
  });

  const companyTruck = await Truck.create({
    tenantId: TENANT, company: co._id, unitNumber: 'C-101', plateNumber: 'DMO101',
    vin: '1FUJGLD59LLLL1010', make: 'Freightliner', model: 'Cascadia', year: 2022,
    ownerOperated: false,
  });
  const ownerTruck = await Truck.create({
    tenantId: TENANT, company: co._id, unitNumber: 'D-201', plateNumber: 'DMO201',
    vin: '4V4NC9EH8NN2020', make: 'Volvo', model: 'VNL 860', year: 2023,
    ownerOperated: true, ownerOperator: owner._id,
  });
  for (const [unit, plate, type] of [['TRL-11', 'DMT011', 'Dry Van'], ['TRL-12', 'DMT012', 'Reefer']]) {
    await Trailer.create({
      tenantId: TENANT, company: co._id, unitNumber: unit, plateNumber: plate,
      type, make: 'Utility', model: '3000R', year: 2021, isActive: true,
    });
  }

  const carrierA = await Carrier.create({
    tenantId: TENANT, company: co._id, name: 'Maple Line Logistics', mc_code: 'MC771001',
    phone: '9055551010', email: 'dispatch@maplelinelogistics.ca', carrierID: 'CR-01',
    country: 'Canada', state: 'ON', city: 'Brampton', zipcode: 'L6T 3T6',
    location: '40 West Drive, Brampton, ON L6T 3T6',
  });
  const carrierB = await Carrier.create({
    tenantId: TENANT, company: co._id, name: 'Silverway Carriers', mc_code: 'MC771002',
    phone: '5195552020', email: 'ops@silverwaycarriers.ca', carrierID: 'CR-02',
    country: 'Canada', state: 'ON', city: 'Windsor', zipcode: 'N8X 1A1',
    location: '9 Dock Road, Windsor, ON N8X 1A1',
  });

  const customerA = await Customer.create({
    tenantId: TENANT, company: co._id, name: 'Northbridge Retail Group',
    email: 'ap@northbridgeretail.ca', phone: '4165559090', created_by: admin._id,
    address: '1234 Lake Shore Blvd W', country: 'Canada', state: 'ON',
    city: 'Toronto', zipcode: 'M5V 2T6',
  });
  const customerB = await Customer.create({
    tenantId: TENANT, company: co._id, name: 'Harbourline Foods',
    email: 'accounts@harbourlinefoods.ca', phone: '9055558080', created_by: admin._id,
    address: '77 Harbour Street', country: 'Canada', state: 'ON',
    city: 'Hamilton', zipcode: 'L8P 4X5',
  });

  for (const name of CHARGES) await Charges.create({ tenantId: TENANT, company: co._id, name });
  for (const name of EQUIPMENT) await Equipment.create({ tenantId: TENANT, company: co._id, name });

  /* The field names are `sourceCurrency`/`targetCurrency`. Getting them wrong writes nothing and
   * the order form then fails with `fx_unavailable` on the first non-USD order — so this is NOT
   * wrapped in a catch that would hide it. */
  for (const row of fxPlan()) {
    await ConversionRate.create({ tenantId: TENANT, ...row, createdBy: admin._id });
  }

  console.log('Created.\n');
  console.log(JSON.stringify({
    tenant: TENANT,
    login: { email: `admin@${DOMAIN}`, password: PASSWORD },
    orderNumbersStartAt: `${PREFIX}-1001`,
    ids: {
      company: String(co._id), admin: String(admin._id),
      drivers: drivers.map((d) => String(d._id)),
      ownerOperator: String(owner._id),
      companyTruck: String(companyTruck._id), ownerTruck: String(ownerTruck._id),
      carriers: [String(carrierA._id), String(carrierB._id)],
      customers: [String(customerA._id), String(customerB._id)],
    },
  }, null, 2));
}

const CHARGES = [
  'Line Haul', 'Fuel Surcharge', 'Detention', 'Layover', 'Border Crossing',
  'Chassis', 'Stop Off Fee', 'Drop Fee', 'Waiting', 'TONU', 'Storage', 'Toll Fee',
];
const EQUIPMENT = ['Dry Van', 'Reefer', 'Flatbed', 'Step Deck', 'Container', 'Straight Truck'];

/* Real rates, and deliberately NOT exact reciprocals (1.402359 × 0.711173 = 0.99732) — that is the
 * whole reason money is converted once, at the row's own month, instead of round-tripping. */
function fxPlan() {
  const pairs = [
    ['USD', 'CAD', 1.402359], ['CAD', 'USD', 0.711173],
    ['USD', 'USD', 1], ['CAD', 'CAD', 1], ['INR', 'INR', 1],
    ['INR', 'USD', 0.011876], ['USD', 'INR', 84.2],
    ['INR', 'CAD', 0.016654], ['CAD', 'INR', 60.04],
  ];
  const now = new Date();
  const rows = [];
  for (let back = 3; back >= -1; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    for (const [sourceCurrency, targetCurrency, rate] of pairs) {
      rows.push({ month: d.getMonth() + 1, year: d.getFullYear(), sourceCurrency, targetCurrency, rate });
    }
  }
  return rows;
}

main()
  .then(async () => { await mongoose.connection.close(); process.exit(process.exitCode || 0); })
  .catch(async (e) => { console.error('\nFAILED:', e.message); try { await mongoose.connection.close(); } catch (_) {} process.exit(1); });
