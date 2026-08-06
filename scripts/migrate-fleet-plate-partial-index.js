/**
 * Make the truck/trailer plate unique index apply to LIVE records only.
 *
 * Trucks and trailers are soft-deleted (`deletedAt`), but `{tenantId, plateNumber}` was a plain
 * unique index — so a deleted truck kept holding its plate and re-adding the same truck failed
 * with "Truck with this plate already exists" (and E11000 at the DB level). Mongoose never drops
 * a changed index, so the old one must be dropped explicitly here.
 *
 * Steps per collection:
 *   1. backfill `deletedAt: null` where the field is missing (legacy rows)
 *   2. report live-plate duplicates — if any exist the partial unique index cannot be built
 *   3. drop the old non-partial unique index, create the partial one
 *
 * Usage:
 *   node backend/scripts/migrate-fleet-plate-partial-index.js          # dry run
 *   node backend/scripts/migrate-fleet-plate-partial-index.js --apply  # write
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const TARGETS = [
  { name: 'trucks', label: 'Truck' },
  { name: 'trailers', label: 'Trailer' }
];

async function migrateCollection(db, { name, label }) {
  const col = db.collection(name);
  console.log(`\n=== ${name} ===`);

  const missingDeletedAt = await col.countDocuments({ deletedAt: { $exists: false } });
  console.log(`${label}s missing deletedAt: ${missingDeletedAt}`);
  if (missingDeletedAt && APPLY) {
    const r = await col.updateMany({ deletedAt: { $exists: false } }, { $set: { deletedAt: null } });
    console.log(`  backfilled deletedAt: ${r.modifiedCount}`);
  }

  // Duplicate live plates would block the unique partial index.
  const dupes = await col
    .aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: { tenantId: '$tenantId', plateNumber: '$plateNumber' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }
    ])
    .toArray();
  if (dupes.length) {
    console.log(`  BLOCKED — ${dupes.length} duplicate live plate(s):`);
    dupes.forEach(d => console.log(`    tenant=${d._id.tenantId} plate=${d._id.plateNumber} count=${d.n}`));
    return false;
  }
  console.log('  no duplicate live plates');

  const indexes = await col.indexes();
  const target = indexes.find(
    i => i.key && i.key.tenantId === 1 && i.key.plateNumber === 1 && Object.keys(i.key).length === 2
  );
  if (!target) {
    console.log('  no {tenantId, plateNumber} index found — will create partial unique');
  } else if (target.unique && target.partialFilterExpression) {
    console.log(`  index "${target.name}" already partial unique — nothing to do`);
    return true;
  } else {
    console.log(`  index "${target.name}" is unique=${!!target.unique} partial=no — needs rebuild`);
  }

  if (!APPLY) {
    console.log('  DRY RUN — no index changes');
    return true;
  }

  if (target) {
    await col.dropIndex(target.name);
    console.log(`  dropped ${target.name}`);
  }
  await col.createIndex(
    { tenantId: 1, plateNumber: 1 },
    { unique: true, partialFilterExpression: { deletedAt: null }, name: 'tenantId_1_plateNumber_1' }
  );
  console.log('  created partial unique tenantId_1_plateNumber_1 (deletedAt: null)');
  return true;
}

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) {
    console.error('No DB_URL_OFFICE / MONGODB_URI in env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  let ok = true;
  for (const t of TARGETS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await migrateCollection(mongoose.connection.db, t);
    ok = ok && res;
  }

  console.log(ok ? '\nDone.' : '\nDone with blockers — resolve duplicates and re-run.');
  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
})();
