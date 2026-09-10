/**
 * Give every order a leg.
 *
 * USAGE:
 *   node scripts/migrate-order-default-leg.js                 # DRY RUN
 *   node scripts/migrate-order-default-leg.js --tenant=<id>
 *   node scripts/migrate-order-default-leg.js --apply         # backs up, then writes
 *   node scripts/migrate-order-default-leg.js --verbose
 *
 * WHY THIS IS A PREREQUISITE, not a tidy-up.
 *
 * The order's type, its parties and its cost are all becoming readings of its LEGS. An order with
 * no legs cannot answer any of those questions — its cost would read as zero and it would drop out
 * of every carrier's order list. On the live database that is **374 of 820 orders**: all
 * outsourcing, all on the older tenant, all from before `create_order` began writing a default leg.
 * Every one of them has a carrier and at least two stops, so the leg they should always have had is
 * fully reconstructable.
 *
 * WHAT IT WRITES
 *   One leg per legless order, covering the WHOLE route (stop 0 → last stop), carrying the party the
 *   order itself names: its carrier, or its truck/trailer/driver. Exactly what `create_order` builds
 *   for a new order — this is the same leg, written late.
 *
 * WHAT IT DOES NOT WRITE
 *   `settle_amount` and `carrier_amount` are left NULL on the leg. A null leg amount means "take
 *   your share from the order's pot", so the order's own money columns stay the source and not one
 *   cent moves. Making the leg the source of the money is a later, separate step; doing it here
 *   would turn a structural repair into a money migration.
 *
 * The money invariant is checked per order and proven, not asserted: an order whose cost would
 * differ before and after is skipped and listed.
 *
 * Idempotent — an order that already has a leg is never touched.
 * Reverse with: node scripts/restore-backup.js --from=order-default-leg-backup --apply
 *   (plus removing the created legs, whose ids the run prints to db_backups/<label>/created-legs.json)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../db/config');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
require('../db/Users');
const { kmToMiles } = require('../utils/distance');
const { resolveOrderCostFields } = require('../utils/orderCost');
const { resolveOrderState } = require('../utils/orderParty');
const { backupCollections } = require('./_backupHelper');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const cents = (v) => Math.round(num(v) * 100);
const idOf = (v) => {
  if (!v) return null;
  const s = String(v._id || v);
  return s && s !== 'null' && s !== 'undefined' ? s : null;
};

/** Every stop of the order, flattened — leg indexes address stops by position. */
const stopsOf = (order) => (Array.isArray(order?.shipping_details) ? order.shipping_details : [])
  .flatMap((b) => (Array.isArray(b?.locations) ? b.locations : []));

const stopText = (loc) => {
  const base = String(loc?.location || loc?.address || '').trim();
  const city = String(loc?.city || '').trim();
  if (base && city && !base.includes(city)) return `${base}, ${city}`;
  return base || city || '';
};

async function migrate() {
  const apply = process.argv.includes('--apply');
  const verbose = process.argv.includes('--verbose');
  const tenant = arg('tenant');

  await connectDB();
  console.log('Connected to MongoDB');
  console.log(apply ? '\nAPPLY MODE — will back up, then write\n' : '\nDRY RUN — nothing will be written (use --apply)\n');

  const filter = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
  if (tenant) filter.tenantId = tenant;

  const orders = await Order.find(filter)
    .select('_id tenantId serial_no order_type order_parties isMixedType carrier truck trailer driver drivers '
      + 'ownerOperator totalDistance shipping_details total_amount carrier_amount input_carrier_amount '
      + 'settle_amount input_settle_amount cost_amount input_cost_amount isOwnerOperatedTruck created_by')
    .lean();

  const legged = new Set(
    (await Trip.find({ deletedAt: null }).select('order').lean()).map((t) => String(t.order))
  );
  const legless = orders.filter((o) => !legged.has(String(o._id)));

  console.log(`Orders in scope: ${orders.length}${tenant ? ` (tenant ${tenant})` : ''}`);
  console.log(`Already have a leg: ${orders.length - legless.length}`);
  console.log(`WITHOUT a leg:      ${legless.length}\n`);
  if (!legless.length) {
    console.log('Nothing to do.\n');
    return;
  }

  // Trucks are needed to read a fleet leg's party (owner vs company) for the invariant check.
  const truckIds = [...new Set(legless.map((o) => idOf(o.truck)).filter(Boolean))];
  const truckRows = truckIds.length
    ? await Truck.find({ _id: { $in: truckIds } }).select('ownerOperated ownerOperator').lean()
    : [];
  const truckMap = new Map(truckRows.map((t) => [String(t._id), t]));

  const stats = { willCreate: 0, skipStops: 0, skipNoParty: 0, skipMoney: 0, noDistance: 0 };
  const plan = [];
  const skipped = [];

  for (const o of legless) {
    const stops = stopsOf(o);
    if (stops.length < 2) {
      stats.skipStops++;
      skipped.push({ o, why: `only ${stops.length} stop(s) — a leg needs a start and an end` });
      continue;
    }

    const carrierId = idOf(o.carrier);
    const truckId = idOf(o.truck);
    const driverId = idOf(o.driver) || (Array.isArray(o.drivers) ? idOf(o.drivers[0]) : null);
    if (!carrierId && !truckId && !driverId) {
      stats.skipNoParty++;
      skipped.push({ o, why: 'the order names neither a carrier nor a truck/driver — nobody to attribute the leg to' });
      continue;
    }

    // Order distance is KM; a leg's miles are miles. Writing the km into `miles` is the exact bug
    // create_order once had, and it inflated every single-leg order by 60%.
    const miles = kmToMiles(num(o.totalDistance));
    if (miles <= 0) stats.noDistance++;

    const legDoc = {
      tenantId: o.tenantId,
      order: o._id,
      trip_no: 1,
      start_stop_index: 0,
      end_stop_index: stops.length - 1,
      // The party the ORDER names. A carrier wins outright, exactly as tripParty reads it.
      carrier: carrierId ? new mongoose.Types.ObjectId(carrierId) : null,
      truck: !carrierId && truckId ? new mongoose.Types.ObjectId(truckId) : null,
      trailer: !carrierId && idOf(o.trailer) ? new mongoose.Types.ObjectId(idOf(o.trailer)) : null,
      driver: !carrierId && driverId ? new mongoose.Types.ObjectId(driverId) : null,
      drivers: !carrierId && Array.isArray(o.drivers)
        ? o.drivers.filter(Boolean).map((d) => new mongoose.Types.ObjectId(idOf(d)))
        : [],
      start_location: stopText(stops[0]),
      end_location: stopText(stops[stops.length - 1]),
      miles,
      totalDistance: miles,
      distance_unit: 'mi',
      rate_per_mile: 0,
      // Left null on purpose: "take your share from the order's pot". See the header.
      settle_amount: null,
      carrier_amount: null,
      created_by: o.created_by || null,
    };

    // THE INVARIANT. The order's cost must read the same with the leg as it did without it.
    const before = resolveOrderCostFields({ order: o, trips: [], truckMap });
    const after = resolveOrderCostFields({ order: o, trips: [legDoc], truckMap });
    if (cents(before.set.cost_amount) !== cents(after.set.cost_amount)
      || cents(before.set.input_cost_amount) !== cents(after.set.input_cost_amount)) {
      stats.skipMoney++;
      skipped.push({
        o,
        why: `cost would move: ${num(before.set.cost_amount)} -> ${num(after.set.cost_amount)}`,
      });
      continue;
    }

    const party = resolveOrderState({ order: o, trips: [legDoc], truckMap });
    stats.willCreate++;
    plan.push({ o, legDoc, party, miles });
    if (verbose && plan.length <= 15) {
      console.log(`  #${o.serial_no} ${o.tenantId}: ${party.order_parties.join(',')} leg, `
        + `${miles.toFixed(2)} mi, stops 0-${stops.length - 1}`);
    }
  }

  console.log('RESULT');
  console.log('------');
  console.log(`  ${apply ? 'legs created        ' : 'legs to create      '} ${String(stats.willCreate).padStart(5)}`);
  console.log(`  skipped: <2 stops     ${String(stats.skipStops).padStart(5)}`);
  console.log(`  skipped: no party     ${String(stats.skipNoParty).padStart(5)}`);
  console.log(`  skipped: cost moves   ${String(stats.skipMoney).padStart(5)}  NEVER written — needs a human`);
  console.log(`  created with 0 miles  ${String(stats.noDistance).padStart(5)}  the order itself has no distance`);

  if (skipped.length) {
    console.log(`\nSkipped (${skipped.length})`);
    console.log('-------------------');
    skipped.slice(0, 40).forEach(({ o, why }) => console.log(`  #${o.serial_no} ${o.tenantId}: ${why}`));
  }

  if (!apply) {
    console.log(`\nDry run complete. ${plan.length} leg(s) would be created. Re-run with --apply.\n`);
    return;
  }
  if (!plan.length) {
    console.log('\nNothing to write.\n');
    return;
  }

  console.log('\nBacking up the orders before any write...');
  const backupDir = await backupCollections('order-default-leg-backup', [{
    collection: 'orders',
    projection: {
      _id: 1, tenantId: 1, serial_no: 1,
      order_type: 1, order_parties: 1, isMixedType: 1,
      carrier: 1, carriers: 1, isMixedCarrier: 1, carrier_ratio: 1,
      carrier_amount: 1, input_carrier_amount: 1,
      settle_amount: 1, input_settle_amount: 1,
      cost_amount: 1, input_cost_amount: 1,
      total_amount: 1, isOwnerOperatedTruck: 1, isMixedOwner: 1,
    },
  }]);

  // The created legs' ids are the only way to undo this half of the migration — the order backup
  // cannot express "and delete the trips that were added". So the file is written after EVERY chunk
  // and again on failure: with `ordered: false` a throwing insertMany still leaves the documents it
  // managed to write, and losing their ids would leave legs that nothing could take back out.
  const legFile = path.join(backupDir, 'created-legs.json');
  const createdIds = [];
  const flushIds = () => fs.writeFileSync(legFile, JSON.stringify(createdIds, null, 2));
  flushIds();

  try {
    for (let i = 0; i < plan.length; i += 200) {
      const chunk = plan.slice(i, i + 200);
      const rows = await Trip.insertMany(chunk.map((p) => p.legDoc), { ordered: false });
      rows.forEach((r) => createdIds.push(String(r._id)));
      flushIds();
    }
  } catch (insertErr) {
    // `insertedDocs` carries what did land before the error, on both mongoose and driver errors.
    (insertErr?.insertedDocs || []).forEach((d) => { if (d?._id) createdIds.push(String(d._id)); });
    flushIds();
    console.error(`\nInsert failed after ${createdIds.length} leg(s). Their ids are in ${legFile}.`);
    throw insertErr;
  }
  console.log(`Created ${createdIds.length} leg(s).`);
  console.log(`Leg ids written to ${legFile}`);

  // Now that every one of them HAS a leg, the party stamp can be read for the first time.
  const stampOps = [];
  plan.forEach(({ o, party }) => {
    if (!party.resolved) return;
    const prev = Array.isArray(o.order_parties) ? o.order_parties : [];
    const same = prev.length === party.order_parties.length
      && prev.every((v, idx) => v === party.order_parties[idx]);
    if (same && o.isMixedType === party.isMixedType) return;
    stampOps.push({
      updateOne: {
        filter: { _id: o._id },
        // `carriers` goes with `order_parties`: a stamp that says "a carrier runs this" while the
        // carrier list is empty is half a reading, and the shape readers query that list.
        // Deliberately NOT stamped: cost_amount / carrier_amount. Those are money, and this
        // migration is a structural repair — see the header.
        update: {
          $set: {
            order_parties: party.order_parties,
            isMixedType: party.isMixedType,
            carriers: party.carrierIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
      },
    });
  });
  if (stampOps.length) {
    for (let i = 0; i < stampOps.length; i += 500) {
      await Order.bulkWrite(stampOps.slice(i, i + 500), { ordered: false });
    }
    console.log(`Stamped ${stampOps.length} order(s) with their now-readable parties.`);
  }

  console.log('\nUndo:');
  console.log(`  node scripts/restore-backup.js --from=order-default-leg-backup --apply`);
  console.log(`  ...then soft-delete the leg ids in ${path.join(backupDir, 'created-legs.json')}\n`);
}

migrate()
  .catch((e) => { console.error('Migration failed:', e); process.exitCode = 1; })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
    process.exit(process.exitCode || 0);
  });
