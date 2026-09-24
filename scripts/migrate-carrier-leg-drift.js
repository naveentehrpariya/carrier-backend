/**
 * Repair outsourcing orders whose ORDER names one carrier while their only LEG names another.
 *
 *   node scripts/migrate-carrier-leg-drift.js                 # dry run — lists every order
 *   node scripts/migrate-carrier-leg-drift.js --apply
 *   node scripts/migrate-carrier-leg-drift.js --tenant=x --apply
 *
 * HOW THEY GOT THIS WAY
 * ---------------------
 * `create_order` writes a default leg carrying the order's carrier. Until the order-party work was
 * deployed (~2026-09-12), changing the carrier on the Edit Order form wrote the ORDER only and never
 * touched that leg. Nothing read a single outsourcing order's leg for its carrier back then, so the
 * disagreement was invisible. The audit trail shows the pattern exactly: e.g. #1767, 2026-09-08,
 * "Updated order" with `carrier` among the changed fields — and the leg's `updatedAt` still equal to
 * its `createdAt`.
 *
 * WHY IT MUST BE REPAIRED NOW
 * ---------------------------
 * The order's carrier is now a READING of its legs: every save re-reads them and writes the leg's
 * carrier back onto the order. The Edit Order form is safe (it re-sends the order's carrier, which
 * `planOrderCarrierEdit` pushes onto the leg), but any path that saves WITHOUT a carrier — Trip
 * Planning re-saving the legs it loaded, an edit that only touches stops — would put back a carrier
 * a dispatcher deliberately replaced months ago. And the per-leg rate confirmation is addressed to
 * the LEG's carrier, so today it names the wrong company for every one of these orders.
 *
 * WHICH SIDE IS TRUE
 * ------------------
 * The ORDER. It is the side a person changed, after the leg was written; the leg is the untouched
 * creation-time value. That is only assumed where it can be shown, so a leg is repaired ONLY when:
 *   - it is the order's single live carrier leg (no ambiguity about which leg);
 *   - it was never edited after it was created (`updatedAt` == `createdAt`) — a leg someone did
 *     change is evidence the other way, and goes to a human;
 *   - its carrier payment is still pending — a paid leg is a contract with the carrier on it;
 *   - the order's carrier exists in the same tenant.
 * Everything else is listed, not touched.
 *
 * No money moves: only `Trip.carrier` is written. Every leg amount on these orders is null (they
 * take the order's figure), which the dry run re-checks.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const arg = (k) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=')[1] : null; };
const TENANT = arg('tenant');
// When the order-party code went live. Rate confirmations downloaded after it were addressed to the
// LEG's carrier, so on these orders they may have gone to the wrong company.
const LIVE_SINCE = new Date('2026-09-11T00:00:00Z');

const live = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
const sameInstant = (a, b) => a && b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 2000;

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) { console.error('No DB_URL_OFFICE / MONGODB_URI.'); process.exit(1); }
  await mongoose.connect(uri, { autoIndex: false });
  const db = mongoose.connection.db;
  console.log(`Connected to ${mongoose.connection.name}${APPLY ? '' : '   (DRY RUN — nothing will be written)'}\n`);

  const orderFilter = { order_type: 'outsourcing', ...live };
  if (TENANT) orderFilter.tenantId = TENANT;
  const orders = await db.collection('orders').find(orderFilter,
    { projection: { serial_no: 1, tenantId: 1, carrier: 1, input_carrier_amount: 1 } }).toArray();

  const legs = await db.collection('trips').find({ order: { $in: orders.map((o) => o._id) }, ...live },
    { projection: { order: 1, carrier: 1, truck: 1, carrier_amount: 1, carrier_payment_status: 1, createdAt: 1, updatedAt: 1, trip_no: 1 } })
    .toArray();
  const legsByOrder = new Map();
  legs.forEach((l) => {
    const k = String(l.order);
    if (!legsByOrder.has(k)) legsByOrder.set(k, []);
    legsByOrder.get(k).push(l);
  });

  const drifted = [];
  for (const o of orders) {
    const carrierLegs = (legsByOrder.get(String(o._id)) || []).filter((l) => l.carrier);
    if (carrierLegs.length !== 1) continue;
    const leg = carrierLegs[0];
    if (!o.carrier || String(leg.carrier) === String(o.carrier)) continue;
    drifted.push({ order: o, leg });
  }

  const carrierIds = [...new Set(drifted.flatMap((d) => [String(d.order.carrier), String(d.leg.carrier)]))]
    .map((id) => new mongoose.Types.ObjectId(id));
  const carriers = await db.collection('carriers').find({ _id: { $in: carrierIds } },
    { projection: { name: 1, tenantId: 1, deletedAt: 1 } }).toArray();
  const carrierById = new Map(carriers.map((c) => [String(c._id), c]));
  const nm = (id) => (carrierById.get(String(id))?.name || `?${String(id).slice(-6)}`).slice(0, 26);

  const repair = [];
  const hold = [];
  for (const d of drifted) {
    const reasons = [];
    if (!sameInstant(d.leg.createdAt, d.leg.updatedAt)) reasons.push('the leg was edited after it was created');
    if (String(d.leg.carrier_payment_status || 'pending').toLowerCase() !== 'pending') reasons.push(`the leg is ${d.leg.carrier_payment_status}`);
    const target = carrierById.get(String(d.order.carrier));
    if (!target) reasons.push("the order's carrier no longer exists");
    else if (target.tenantId && target.tenantId !== d.order.tenantId) reasons.push("the order's carrier belongs to another tenant");
    if (d.leg.carrier_amount !== null && d.leg.carrier_amount !== undefined) reasons.push(`the leg carries its own amount (${d.leg.carrier_amount})`);
    (reasons.length ? hold : repair).push({ ...d, reasons });
  }

  // Rate confirmations are addressed to the LEG's carrier. On a drifted order, one downloaded after
  // the new code went live named the carrier the dispatcher had already replaced.
  const logs = db.collection('activitylogs');
  const rateCons = new Map();
  for (const d of drifted) {
    const n = await logs.countDocuments({
      resourceId: String(d.order._id), action: 'DOWNLOAD',
      description: /rate confirmation/i, createdAt: { $gte: LIVE_SINCE },
    });
    if (n) rateCons.set(String(d.order._id), n);
  }

  const line = (d) => `  #${String(d.order.serial_no).padEnd(5)} ${String(d.order.tenantId).padEnd(33)} leg: ${nm(d.leg.carrier).padEnd(26)} -> order: ${nm(d.order.carrier)}`;
  console.log(`Outsourcing orders scanned : ${orders.length}`);
  console.log(`Order and leg disagree     : ${drifted.length}`);
  console.log(`  repair (leg -> order)    : ${repair.length}`);
  console.log(`  hold for a person        : ${hold.length}\n`);

  if (repair.length) { console.log('Will set the leg\'s carrier to the order\'s:'); repair.forEach((d) => console.log(line(d))); }
  if (hold.length) {
    console.log('\nNOT touched — decide by hand:');
    hold.forEach((d) => console.log(`${line(d)}\n        because ${d.reasons.join('; ')}`));
  }
  if (rateCons.size) {
    console.log('\n⚠ A per-leg rate confirmation was downloaded for these AFTER the new code went live — it named the');
    console.log('  LEG\'s (old) carrier. Check whether it was sent before trusting it:');
    drifted.filter((d) => rateCons.has(String(d.order._id)))
      .forEach((d) => console.log(`  #${d.order.serial_no}  ${rateCons.get(String(d.order._id))}x, addressed to ${nm(d.leg.carrier)}`));
  } else if (drifted.length) {
    console.log('\nNo per-leg rate confirmation was downloaded for any of them since the new code went live.');
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    await mongoose.connection.close();
    return;
  }
  if (!repair.length) { console.log('\nNothing to repair.'); await mongoose.connection.close(); return; }

  const dir = path.join(__dirname, '..', '..', 'db_backups', `carrier-leg-drift-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trips.json'), JSON.stringify(repair.map((d) => d.leg), null, 2));
  fs.writeFileSync(path.join(dir, '_projection.json'), JSON.stringify({ collection: 'trips', fields: ['carrier'] }, null, 2));
  console.log(`\nBackup: ${dir}/trips.json`);

  let written = 0;
  for (const d of repair) {
    /* Guarded on the value we read, so a leg someone changed between the dry run and now is left
       alone rather than overwritten. Written with the native driver, which does not touch
       `updatedAt` — this repairs a decision a person already made; it is not a new edit, and the
       "never edited since created" test above must still mean what it says on a re-run. */
    const r = await db.collection('trips').updateOne(
      { _id: d.leg._id, carrier: d.leg.carrier },
      { $set: { carrier: d.order.carrier } },
    );
    written += r.modifiedCount;
  }
  console.log(`Repaired ${written} of ${repair.length} leg(s).`);
  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
