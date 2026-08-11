/**
 * Rewrite `Trip.miles` / `Trip.totalDistance` to REAL miles.
 *
 * Trip Planning used to store each leg's distance as the sum of its own per-stop-pair
 * /getdistance calls. Measuring stop pairs one at a time returns a longer path than the order's
 * single multi-stop route, so an order's legs added up to MORE miles than the order itself
 * (CMC-1028: legs 1662.89 mi vs order 1419.68 mi) — and the page then paid the driver on the
 * inflated number while the payslip paid on the real one.
 *
 * Payouts never used these values directly: utils/distance.js#deriveTripMiles proportions the
 * ORDER's km by each trip's raw share, so the ratio — not the magnitude — is what mattered.
 * Scaling every trip of an order by the same factor leaves that ratio identical, which is why
 * this migration moves no money. It only makes the stored number match what is paid.
 *
 * Skips orders with no `totalDistance` (nothing to proportion against) and orders whose trips
 * already add up to the order distance.
 *
 * Usage:
 *   node backend/scripts/migrate-trip-real-miles.js            # dry run
 *   node backend/scripts/migrate-trip-real-miles.js --apply    # write
 *   node backend/scripts/migrate-trip-real-miles.js --tenant x # limit to one tenant
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trip = require('../db/Trip');
const Order = require('../db/Order');
const { MI_PER_KM, KM_PER_MI } = require('../utils/distance');

const APPLY = process.argv.includes('--apply');
const tenantArg = process.argv.indexOf('--tenant');
const TENANT = tenantArg > -1 ? process.argv[tenantArg + 1] : null;

// Below this the difference is rounding, not a unit/route mismatch.
const TOLERANCE = 0.005; // 0.5%

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) {
    console.error('No DB_URL_OFFICE / MONGODB_URI in env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}${TENANT ? ` (tenant ${TENANT})` : ''}`);

  const tripFilter = { deletedAt: null };
  if (TENANT) tripFilter.tenantId = TENANT;

  const trips = await Trip.find(tripFilter)
    .select('order tenantId miles totalDistance total_km rate_per_mile total_driver_pay')
    .lean();

  const byOrder = new Map();
  trips.forEach((t) => {
    const oid = String(t.order || '');
    if (!oid) return;
    if (!byOrder.has(oid)) byOrder.set(oid, []);
    byOrder.get(oid).push(t);
  });

  const orderIds = [...byOrder.keys()];
  const orders = await Order.find({ _id: { $in: orderIds } })
    .select('serial_no totalDistance tenantId').lean();
  const orderMap = new Map(orders.map((o) => [String(o._id), o]));

  let scanned = 0, skippedNoDistance = 0, alreadyOk = 0, ordersChanged = 0, tripsChanged = 0;
  const samples = [];

  for (const [oid, list] of byOrder.entries()) {
    scanned++;
    const order = orderMap.get(oid);
    const orderMiles = Number(order?.totalDistance || 0) * MI_PER_KM;
    if (!(orderMiles > 0)) { skippedNoDistance++; continue; }

    const raws = list.map((t) => Math.max(Number(t.totalDistance || t.miles || t.total_km || 0), 0));
    const rawTotal = raws.reduce((a, b) => a + b, 0);
    if (!(rawTotal > 0)) { skippedNoDistance++; continue; }

    const inTolerance = Math.abs(rawTotal - orderMiles) / orderMiles <= TOLERANCE;
    const scale = inTolerance ? 1 : orderMiles / rawTotal;
    if (inTolerance) alreadyOk++;
    else {
      ordersChanged++;
      if (samples.length < 10) {
        samples.push(`${order?.serial_no || oid}: ${rawTotal.toFixed(2)} mi -> ${orderMiles.toFixed(2)} mi (${list.length} legs, x${scale.toFixed(4)})`);
      }
    }

    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const real = Number((raws[i] * scale).toFixed(2));
      const wantKm = Number((real * KM_PER_MI).toFixed(2));
      const wantPay = Number((real * Number(t.rate_per_mile || 0)).toFixed(2));
      // An order can be in tolerance on miles yet still carry derived columns computed from the
      // pre-migration value — an earlier run of this script used updateOne, which skips the
      // pre('save') hook that maintains them. Repair those rows too.
      const derivedStale = Math.abs(Number(t.total_km || 0) - wantKm) > 0.01
        || Math.abs(Number(t.total_driver_pay || 0) - wantPay) > 0.01;
      if (inTolerance && !derivedStale) continue;
      tripsChanged++;
      if (APPLY) {
        // updateOne bypasses the pre('save') hook, so the derived columns it maintains
        // (total_km, total_driver_pay = miles × rate_per_mile) must be rewritten here too —
        // otherwise Order View keeps showing pay computed from the old, inflated miles.
        await Trip.updateOne(
          { _id: t._id },
          {
            $set: {
              miles: real,
              totalDistance: real,
              distance_unit: 'mi',
              total_km: wantKm,
              total_driver_pay: wantPay,
            },
          }
        );
      }
    }
  }

  console.log(`Orders scanned:        ${scanned}`);
  console.log(`  no order distance:   ${skippedNoDistance}`);
  console.log(`  already correct:     ${alreadyOk}`);
  console.log(`  rescaled:            ${ordersChanged} orders`);
  console.log(`  trips written:       ${tripsChanged} (incl. derived-column repairs)`);
  if (samples.length) {
    console.log('\nSamples:');
    samples.forEach((s) => console.log('  ' + s));
  }
  if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
