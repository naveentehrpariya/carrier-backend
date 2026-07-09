/**
 * Migration: fix multi-tenant uniqueness in MongoDB indexes.
 *
 * 1. Drops every STALE unique index on tenant-owned collections whose key does
 *    not start with tenantId (leftovers from the old single-tenant schema,
 *    e.g. orders.serial_no_1, users.corporateID_1, carriers.email_1...).
 *    Mongoose never drops removed indexes on its own, so these survive schema
 *    changes and cause cross-tenant E11000 collisions ("A record with that
 *    serial_no already exists" for a brand-new tenant).
 *
 * 2. Ensures users.email has a GLOBAL unique index — login email must be
 *    unique across all tenants because multi-tenant login / forgot-password
 *    resolve the account (and tenant) from the email alone. Before creating
 *    it, checks for existing duplicate emails and lists them instead of
 *    failing; resolve those manually, then re-run.
 *
 * Safe to run multiple times.
 *
 * Usage:
 *   node backend/scripts/migrate-tenant-unique-indexes.js           (dry run)
 *   node backend/scripts/migrate-tenant-unique-indexes.js --apply
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
  console.log('[DRY RUN] Pass --apply to actually modify indexes.\n');
}

// Collections that are global by design — unique indexes here are fine.
const GLOBAL_COLLECTIONS = new Set([
  'tenants',
  'superadmins',
  'subscription_plans',
  'subscriptionplans',
  'subscriptionhistories',
  'counters',
  'sessions',
  'agendajobs',
]);

// Unique indexes that are intentionally NOT tenant-scoped.
// users.email: global login uniqueness (created by this migration).
const ALLOWED_GLOBAL_UNIQUE = new Set(['users|email_1']);

async function run() {
  await mongoose.connect(DB_URI);
  const db = mongoose.connection.db;
  console.log('Connected to MongoDB.\n');

  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .sort();

  // ---- Step 1: drop stale non-tenant-scoped unique indexes ----
  console.log('=== Step 1: stale unique indexes ===');
  let staleFound = 0;
  for (const name of collections) {
    if (GLOBAL_COLLECTIONS.has(name)) continue;
    let indexes;
    try {
      indexes = await db.collection(name).indexes();
    } catch {
      continue;
    }
    for (const idx of indexes) {
      if (!idx.unique || idx.name === '_id_') continue;
      const firstKey = Object.keys(idx.key)[0];
      if (firstKey === 'tenantId') continue; // correctly tenant-scoped
      if (ALLOWED_GLOBAL_UNIQUE.has(`${name}|${idx.name}`)) continue;

      staleFound++;
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would drop ${name}.${idx.name}  key=${JSON.stringify(idx.key)}`);
      } else {
        await db.collection(name).dropIndex(idx.name);
        console.log(`Dropped ${name}.${idx.name}  key=${JSON.stringify(idx.key)}`);
      }
    }
  }
  if (staleFound === 0) console.log('No stale unique indexes found.');

  // ---- Step 2: global unique index on users.email ----
  console.log('\n=== Step 2: users.email global unique ===');
  const users = db.collection('users');
  const userIndexes = await users.indexes();
  const hasEmailUnique = userIndexes.some(
    (idx) => idx.unique && Object.keys(idx.key).length === 1 && idx.key.email === 1
  );

  if (hasEmailUnique) {
    console.log('users.email_1 unique index already present.');
  } else {
    const dupes = await users
      .aggregate([
        { $group: { _id: '$email', count: { $sum: 1 }, ids: { $push: '$_id' }, tenants: { $addToSet: '$tenantId' } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (dupes.length > 0) {
      console.log(`BLOCKED: ${dupes.length} duplicate email(s) exist — resolve these first, then re-run:`);
      for (const d of dupes) {
        console.log(`  ${d._id}  x${d.count}  tenants=${JSON.stringify(d.tenants)}  ids=${d.ids.join(', ')}`);
      }
    } else if (DRY_RUN) {
      console.log('[DRY RUN] Would create unique index users.{ email: 1 } (no duplicates found).');
    } else {
      await users.createIndex({ email: 1 }, { unique: true });
      console.log('Created unique index users.{ email: 1 }.');
    }
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
