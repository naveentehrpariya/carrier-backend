/**
 * Soft-delete legs and files that belong to an order that no longer exists.
 *
 * `deleteOrder` used to stamp `deletedAt` on the order alone, so its legs stayed live: they still
 * carried a driver, miles and a rate, and every trip aggregate, driver log and payslip kept
 * counting a load that was cancelled. Files stayed attached to nothing and were never cleaned up.
 * The cascade is fixed in deleteOrder; this repairs what is already in the database.
 *
 * Soft delete only — a mistaken order delete stays recoverable, and so does this.
 *
 *   node backend/scripts/migrate-orphan-trips-and-files.js            # dry run, prints the damage
 *   node backend/scripts/migrate-orphan-trips-and-files.js --apply    # writes
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) throw new Error('No DB_URL_OFFICE / MONGODB_URI in env');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const liveOrderIds = new Set(
    (await db.collection('orders').find({
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    }).project({ _id: 1 }).toArray()).map((o) => String(o._id))
  );

  const legs = await db.collection('trips')
    .find({ $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] })
    .project({ order: 1, trip_no: 1, miles: 1, drivers: 1, driver: 1, start_stop_index: 1, end_stop_index: 1 })
    .toArray();
  const orphanLegs = legs.filter((t) => !t.order || !liveOrderIds.has(String(t.order)));

  const files = await db.collection('files')
    .find({ $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] })
    .project({ order: 1, name: 1 })
    .toArray();
  const orphanFiles = files.filter((f) => f.order && !liveOrderIds.has(String(f.order)));

  // Legs whose stop indexes fell outside the order after its stops were edited. The route on these
  // reads blank (extractLocMeta finds nothing) — clamp them back inside the order's stop list.
  const orders = await db.collection('orders')
    .find({ $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] })
    .project({ serial_no: 1, 'shipping_details.locations': 1 })
    .toArray();
  const stopCount = new Map(orders.map((o) => [String(o._id), (o.shipping_details?.[0]?.locations || []).length]));
  const serialOf = new Map(orders.map((o) => [String(o._id), o.serial_no]));
  const strayLegs = [];
  legs.forEach((t) => {
    const n = stopCount.get(String(t.order));
    if (!n) return; // orphan or stop-less order, handled elsewhere
    const last = n - 1;
    const start = Math.min(Math.max(Number(t.start_stop_index || 0), 0), last);
    const end = Math.min(Math.max(Number(t.end_stop_index || 0), start), last);
    if (start !== t.start_stop_index || end !== t.end_stop_index) {
      strayLegs.push({ _id: t._id, serial: serialOf.get(String(t.order)), from: `${t.start_stop_index}-${t.end_stop_index}`, to: `${start}-${end}`, start, end });
    }
  });

  const miles = orphanLegs.reduce((sum, t) => sum + (Number(t.miles) || 0), 0);
  const withDriver = orphanLegs.filter((t) => (t.drivers || []).length > 0 || t.driver).length;

  console.log(`legs scanned:  ${legs.length}`);
  console.log(`  orphaned:    ${orphanLegs.length}  (${miles.toFixed(0)} miles, ${withDriver} with a driver on them)`);
  console.log(`files scanned: ${files.length}`);
  console.log(`  orphaned:    ${orphanFiles.length}`);
  console.log(`legs with stop indexes outside their order: ${strayLegs.length}`);
  strayLegs.slice(0, 10).forEach((s) => console.log(`  #${s.serial}: ${s.from} -> ${s.to}`));

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to soft-delete these.');
    await mongoose.disconnect();
    return;
  }

  const deletedAt = new Date();
  const legResult = orphanLegs.length
    ? await db.collection('trips').updateMany({ _id: { $in: orphanLegs.map((t) => t._id) } }, { $set: { deletedAt } })
    : { modifiedCount: 0 };
  const fileResult = orphanFiles.length
    ? await db.collection('files').updateMany({ _id: { $in: orphanFiles.map((f) => f._id) } }, { $set: { deletedAt } })
    : { modifiedCount: 0 };

  let clamped = 0;
  for (const s of strayLegs) {
    const r = await db.collection('trips').updateOne(
      { _id: s._id },
      { $set: { start_stop_index: s.start, end_stop_index: s.end } }
    );
    clamped += r.modifiedCount;
  }

  console.log(`\nsoft-deleted -> legs: ${legResult.modifiedCount} | files: ${fileResult.modifiedCount}`);
  console.log(`stop indexes clamped -> legs: ${clamped}`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
