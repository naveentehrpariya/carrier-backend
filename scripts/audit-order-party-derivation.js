/**
 * READ-ONLY. Answers one question before anything is migrated:
 *
 *   "If the order's type were read from its legs instead of from the stored column,
 *    how many orders would change — and why?"
 *
 * Nothing is written. No connection is made to anything but the database, and no document is
 * modified. Run this, read the numbers, THEN decide whether the migration is safe to apply.
 *
 * USAGE:
 *   node scripts/audit-order-party-derivation.js
 *   node scripts/audit-order-party-derivation.js --tenant=cross-miles-carrier-inc-trucking
 *   node scripts/audit-order-party-derivation.js --limit=200 --verbose
 *   node scripts/audit-order-party-derivation.js --json=/tmp/party-audit.json
 *
 * Buckets:
 *   match        stored type == derived type. Nothing to do.
 *   mismatch     derived type differs. Each one is listed with the reason — these are the orders a
 *                human has to look at before the migration is allowed to touch them.
 *   mixed        the order has a carrier leg AND a fleet leg. Impossible to express today, so every
 *                one of these is currently mislabelled whichever way the column reads.
 *   unresolved   no leg could be read (no legs at all, a deleted truck, a blank leg). The migration
 *                must LEAVE THESE ALONE and keep the stored type.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
// NOT db/config: that connects with autoIndex:true, which lets Mongoose BUILD an index on the
// live database the first time a model is used. A read-only audit must not change anything at all,
// index definitions included, so it opens its own connection with autoIndex off.
mongoose.set('autoIndex', false);
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const { resolveOrderState } = require('../utils/orderParty');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

async function run() {
  const tenant = arg('tenant');
  const limit = Number(arg('limit') || 0);
  const jsonOut = arg('json');
  const verbose = process.argv.includes('--verbose');

  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) throw new Error('DB_URL_OFFICE / MONGODB_URI is not set.');
  await mongoose.connect(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 30000,
    autoIndex: false,   // read-only: never build an index as a side effect
  });
  console.log('Connected to MongoDB — READ ONLY, nothing will be written.\n');

  const orderFilter = {};
  if (tenant) orderFilter.tenantId = tenant;
  // Soft-deleted orders are excluded: the migration will not touch them either.
  orderFilter.$or = [{ deletedAt: null }, { deletedAt: { $exists: false } }];

  let q = Order.find(orderFilter)
    .select('_id tenantId serial_no order_type isOwnerOperatedTruck carrier carrier_amount input_carrier_amount settle_amount input_settle_amount ownerOperator ownerOperators isMixedOwner truck driver drivers createdAt')
    .sort({ createdAt: 1 })
    .lean();
  if (limit > 0) q = q.limit(limit);
  const orders = await q;

  console.log(`Orders in scope: ${orders.length}${tenant ? ` (tenant ${tenant})` : ' (all tenants)'}\n`);
  if (!orders.length) return;

  const orderIds = orders.map((o) => o._id);

  // One pass for the legs, one for the trucks. Never a query per order.
  const trips = await Trip.find({ order: { $in: orderIds }, deletedAt: null })
    .select('_id order tenantId trip_no truck carrier driver drivers settle_amount miles')
    .lean();

  const tripsByOrder = new Map();
  trips.forEach((t) => {
    const k = String(t.order);
    if (!tripsByOrder.has(k)) tripsByOrder.set(k, []);
    tripsByOrder.get(k).push(t);
  });

  const truckIds = [...new Set(trips.map((t) => t.truck).filter(Boolean).map(String))];
  // Deleted trucks must still be found, otherwise every order on one reads as "truck_missing"
  // when the truck actually exists and is simply soft-deleted. Those are two different problems.
  const trucks = await Truck.find({ _id: { $in: truckIds } })
    .select('_id ownerOperated ownerOperator deletedAt')
    .lean();
  const truckMap = new Map(trucks.map((t) => [String(t._id), t]));
  const deletedTruckIds = new Set(trucks.filter((t) => t.deletedAt).map((t) => String(t._id)));
  const trulyMissing = truckIds.filter((id) => !truckMap.has(id));

  const buckets = {
    match: [], mismatch: [], mixed: [], unresolved: [],
  };
  const reasonCounts = {};
  const sourceCounts = {};
  const mismatchKinds = {};
  const rows = [];

  for (const o of orders) {
    const legs = tripsByOrder.get(String(o._id)) || [];
    const state = resolveOrderState({ order: o, trips: legs, truckMap });
    const stored = String(o.order_type || '');

    const row = {
      _id: String(o._id),
      tenantId: o.tenantId,
      serial_no: o.serial_no,
      stored,
      derived: state.order_type,
      parties: state.order_parties,
      isMixedType: state.isMixedType,
      legCount: state.legCount,
      unresolvedLegs: state.unresolvedLegs,
      source: state.source,
      reasons: state.reasons,
      carrierIds: state.carrierIds,
      ownerIds: state.ownerIds,
      // Money columns, so the migration's invariant check has something to compare against later.
      carrier_amount: o.carrier_amount ?? null,
      settle_amount: o.settle_amount ?? null,
    };
    rows.push(row);

    sourceCounts[state.source] = (sourceCounts[state.source] || 0) + 1;
    state.reasons.forEach((r) => { reasonCounts[r] = (reasonCounts[r] || 0) + 1; });

    if (!state.resolved) { buckets.unresolved.push(row); continue; }
    if (state.isMixedType) { buckets.mixed.push(row); continue; }
    if (state.order_type === stored) { buckets.match.push(row); continue; }

    const kind = `${stored || '(none)'} -> ${state.order_type}`;
    mismatchKinds[kind] = (mismatchKinds[kind] || 0) + 1;
    buckets.mismatch.push(row);
  }

  const pct = (n) => (orders.length ? ((n / orders.length) * 100).toFixed(1) : '0.0');

  console.log('RESULT');
  console.log('------');
  console.log(`  match       ${String(buckets.match.length).padStart(5)}  (${pct(buckets.match.length)}%)  stored type already equals the derived one`);
  console.log(`  mixed       ${String(buckets.mixed.length).padStart(5)}  (${pct(buckets.mixed.length)}%)  carrier leg AND fleet leg on one order`);
  console.log(`  mismatch    ${String(buckets.mismatch.length).padStart(5)}  (${pct(buckets.mismatch.length)}%)  derived type differs from stored`);
  console.log(`  unresolved  ${String(buckets.unresolved.length).padStart(5)}  (${pct(buckets.unresolved.length)}%)  no leg could be read — migration must SKIP these`);

  console.log('\nWhere the answer came from');
  console.log('--------------------------');
  console.log(`  legs   ${String(sourceCounts.legs || 0).padStart(5)}  read from the order's legs (the only source that can show a mixed order)`);
  console.log(`  order  ${String(sourceCounts.order || 0).padStart(5)}  no readable leg — fell back to the order's own carrier/truck columns`);
  console.log(`  none   ${String(sourceCounts.none || 0).padStart(5)}  neither could answer — stored type is kept untouched`);

  if (Object.keys(mismatchKinds).length) {
    console.log('\nMismatch breakdown');
    console.log('------------------');
    Object.entries(mismatchKinds).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  ${k}`));
  }

  if (Object.keys(reasonCounts).length) {
    console.log('\nWhy legs could not be read (orders affected)');
    console.log('-------------------------------------------');
    Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  ${k}`));
  }

  console.log('\nLeg data');
  console.log('--------');
  console.log(`  legs scanned            ${trips.length}`);
  console.log(`  distinct trucks on legs ${truckIds.length}`);
  console.log(`  soft-deleted trucks     ${deletedTruckIds.size}`);
  console.log(`  truck ids with no row   ${trulyMissing.length}${trulyMissing.length ? ` (${trulyMissing.slice(0, 5).join(', ')}${trulyMissing.length > 5 ? ', …' : ''})` : ''}`);

  const show = (title, list, n) => {
    if (!list.length) return;
    console.log(`\n${title} (showing ${Math.min(n, list.length)} of ${list.length})`);
    console.log('-'.repeat(title.length + 20));
    list.slice(0, n).forEach((r) => {
      console.log(`  #${r.serial_no}  ${r.tenantId}`);
      console.log(`     stored=${r.stored || '(none)'}  derived=${r.derived || '(unreadable)'}  via=${r.source}  parties=[${r.parties.join(',')}]  legs=${r.legCount} (unreadable ${r.unresolvedLegs})${r.reasons.length ? `  reasons=${r.reasons.join(',')}` : ''}`);
    });
  };

  show('MISMATCH — a human must look at these', buckets.mismatch, verbose ? 200 : 20);
  show('MIXED — carrier + fleet on one order', buckets.mixed, verbose ? 200 : 20);
  show('UNRESOLVED — migration will skip these', buckets.unresolved, verbose ? 200 : 20);

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      generatedAt: new Date().toISOString(),
      scope: { tenant: tenant || null, limit: limit || null, orders: orders.length },
      counts: {
        match: buckets.match.length,
        mixed: buckets.mixed.length,
        mismatch: buckets.mismatch.length,
        unresolved: buckets.unresolved.length,
      },
      sourceCounts,
      mismatchKinds,
      reasonCounts,
      rows,
    }, null, 2));
    console.log(`\nFull rows written to ${jsonOut}`);
  }

  console.log('\nNothing was written. This script never modifies data.\n');
}

run()
  .catch((e) => { console.error('Audit failed:', e); process.exitCode = 1; })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
    process.exit(process.exitCode || 0);
  });
