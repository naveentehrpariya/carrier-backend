/**
 * Migration: drop legacy global-unique serial_no index from `orders`.
 *
 * Old single-tenant schema had a unique index on { serial_no: 1 } alone.
 * Mongoose never drops removed indexes, so multi-tenant inserts collide
 * across tenants (new tenant's first order #1001 hits E11000 because some
 * other tenant already owns 1001). The correct index is the compound
 * { tenantId: 1, serial_no: 1 } unique — that one is kept/ensured here.
 *
 * Safe to run multiple times.
 *
 * Usage:
 *   node backend/scripts/migrate-drop-legacy-serial-no-index.js           (dry run)
 *   node backend/scripts/migrate-drop-legacy-serial-no-index.js --apply   (actually drops)
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DB_URI = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
if (!DB_URI) {
  console.error('No DB_URL_OFFICE / MONGODB_URI in environment.');
  process.exit(1);
}

const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) {
  console.log('[DRY RUN] Pass --apply to actually drop the index.\n');
}

async function run() {
  await mongoose.connect(DB_URI);
  console.log('Connected to MongoDB.\n');

  const col = mongoose.connection.collection('orders');
  const indexes = await col.indexes();

  console.log('Current indexes on `orders`:');
  for (const idx of indexes) {
    console.log(
      `  - ${idx.name}  key=${JSON.stringify(idx.key)}${idx.unique ? '  UNIQUE' : ''}`
    );
  }
  console.log('');

  // Any index whose key is serial_no alone (with or without unique) is legacy.
  const legacy = indexes.filter(
    (idx) =>
      Object.keys(idx.key).length === 1 &&
      idx.key.serial_no !== undefined &&
      idx.name !== '_id_'
  );

  if (legacy.length === 0) {
    console.log('No legacy standalone serial_no index found. Nothing to do.');
  } else {
    for (const idx of legacy) {
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would drop index: ${idx.name}`);
      } else {
        await col.dropIndex(idx.name);
        console.log(`Dropped index: ${idx.name}`);
      }
    }
  }

  // Ensure the correct tenant-scoped unique index exists.
  const hasCompound = indexes.some(
    (idx) => idx.key.tenantId === 1 && idx.key.serial_no === 1 && idx.unique
  );
  if (hasCompound) {
    console.log('Compound unique index { tenantId, serial_no } already present.');
  } else if (DRY_RUN) {
    console.log('[DRY RUN] Would create unique index { tenantId: 1, serial_no: 1 }.');
  } else {
    await col.createIndex({ tenantId: 1, serial_no: 1 }, { unique: true });
    console.log('Created unique index { tenantId: 1, serial_no: 1 }.');
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
