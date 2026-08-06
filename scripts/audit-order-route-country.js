/**
 * Audit existing orders for distances measured on a border-crossing route.
 *
 * Google returns the fastest route, which for a domestic long haul can cut through the other
 * country (AB -> ON via North Dakota). That route is shorter than the one the truck drives, and
 * the difference flows into driver pay, owner settlement and truck gross.
 *
 * READ-ONLY. Nothing is written — it recalculates each order with the domestic-only policy and
 * reports the gap so you can decide what, if anything, to correct by hand.
 *
 * Usage:
 *   node backend/scripts/audit-order-route-country.js                    # all tenants, 50 orders
 *   node backend/scripts/audit-order-route-country.js --limit 200
 *   node backend/scripts/audit-order-route-country.js --tenant acme
 *   node backend/scripts/audit-order-route-country.js --min-gap 25       # only gaps over 25 mi
 *
 * Each order costs 1–2 Google Directions calls, so keep --limit sane.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../db/Order');
const { resolveRouteDistance } = require('../utils/routeDistance');

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const LIMIT = Number(argValue('--limit', 50));
const TENANT = argValue('--tenant', null);
const MIN_GAP_MI = Number(argValue('--min-gap', 10));
const MI_PER_KM = 0.621371;

function orderLocations(order) {
  const locs = order?.shipping_details?.[0]?.locations || [];
  return locs
    .map((l) => String(l?.location || l?.address || '').trim())
    .filter(Boolean);
}

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) {
    console.error('No DB_URL_OFFICE / MONGODB_URI in env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. READ-ONLY audit — limit ${LIMIT}${TENANT ? `, tenant ${TENANT}` : ''}, min gap ${MIN_GAP_MI} mi\n`);

  const filter = {
    totalDistance: { $gt: 0 },
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };
  if (TENANT) filter.tenantId = TENANT;

  const orders = await Order.find(filter)
    .select('serial_no tenantId totalDistance shipping_details createdAt route_crosses_border distance_source')
    .sort({ createdAt: -1 })
    .limit(LIMIT)
    .lean();

  console.log(`Checking ${orders.length} orders…\n`);

  const flagged = [];
  let skipped = 0;

  for (const order of orders) {
    if (order.distance_source === 'manual') { skipped += 1; continue; }
    const locations = orderLocations(order);
    if (locations.length < 2) { skipped += 1; continue; }

    let result;
    try {
      result = await resolveRouteDistance({
        origin: locations[0],
        destination: locations[locations.length - 1],
        waypoints: locations.slice(1, -1),
        tenantId: order.tenantId,
        policy: 'domestic_only',
        optimizeWaypoints: true,
      });
    } catch (err) {
      skipped += 1;
      continue;
    }
    if (!result?.ok) { skipped += 1; continue; }

    const storedKm = Number(order.totalDistance || 0);
    const gapKm = result.km - storedKm;
    const gapMi = gapKm * MI_PER_KM;

    if (gapMi >= MIN_GAP_MI) {
      flagged.push({
        order: order.serial_no ?? String(order._id).slice(-6),
        tenant: order.tenantId,
        storedKm: storedKm.toFixed(0),
        domesticKm: result.km.toFixed(0),
        gapMi: gapMi.toFixed(0),
        route: result.countries.join('+'),
        source: result.source,
      });
    }
  }

  if (!flagged.length) {
    console.log(`No order is short by ${MIN_GAP_MI} mi or more. (${skipped} skipped: manual, incomplete or unroutable)`);
  } else {
    console.table(flagged);
    const totalGap = flagged.reduce((s, f) => s + Number(f.gapMi), 0);
    console.log(`\n${flagged.length} orders short by ${MIN_GAP_MI}+ mi. Total missing: ${totalGap.toFixed(0)} mi.`);
    console.log(`${skipped} skipped (manual distance, incomplete addresses or unroutable).`);
    console.log('\nNothing was written. Correct an order by opening it and editing the distance manually.');
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
