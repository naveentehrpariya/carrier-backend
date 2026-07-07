/**
 * Migration: email/phone uniqueness → company-scoped
 *
 * Changes uniqueness from per-tenant (or global) to per-company so the SAME
 * email can be used in a different company of the same tenant, and drops the
 * flawed GLOBAL unique indexes on Carrier/Customer email + Carrier carrierID.
 *
 * Old indexes dropped:
 *   users     : tenantId_1_email_1 (unique)
 *   carriers  : email_1 (unique), carrierID_1 (unique),
 *               tenantId_1_email_1 (unique), tenantId_1_carrierID_1 (unique)
 *   customers : email_1 (unique), tenantId_1_email_1 (unique)
 *
 * New indexes (created by syncIndexes from the model definitions):
 *   users     : { tenantId, company, email } unique
 *   carriers  : { tenantId, company, email } unique, { tenantId, company, carrierID } unique
 *   customers : { tenantId, company, email } unique
 *
 * Safe to run multiple times — dropIndex on a missing index is ignored.
 *
 * Usage:
 *   node backend/scripts/migrate-company-scoped-email-indexes.js
 *   node backend/scripts/migrate-company-scoped-email-indexes.js --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');

const DB_URI = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
if (!DB_URI) {
  console.error('No DB_URL_OFFICE / MONGODB_URI in environment.');
  process.exit(1);
}

const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) {
  console.log('[DRY RUN] Pass --apply to actually change indexes.\n');
}

// collection -> old index names to drop
const OLD_INDEXES = {
  users: ['tenantId_1_email_1'],
  carriers: ['email_1', 'carrierID_1', 'tenantId_1_email_1', 'tenantId_1_carrierID_1'],
  customers: ['email_1', 'tenantId_1_email_1'],
};

async function dropOld(col, names) {
  const existing = (await col.indexes()).map((i) => i.name);
  for (const name of names) {
    if (!existing.includes(name)) {
      console.log(`  - ${col.collectionName}.${name} not present, skip`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  - would drop ${col.collectionName}.${name}`);
    } else {
      await col.dropIndex(name);
      console.log(`  - dropped ${col.collectionName}.${name}`);
    }
  }
}

async function run() {
  await mongoose.connect(DB_URI);
  console.log('Connected to MongoDB.\n');

  const db = mongoose.connection.db;

  console.log('Dropping old indexes:');
  for (const [name, idx] of Object.entries(OLD_INDEXES)) {
    await dropOld(db.collection(name), idx);
  }

  // Backfill: free email/phone on records already soft-deleted BEFORE this fix,
  // so their original addresses can be re-used. Skips already-mangled docs.
  console.log('\nFreeing email/phone on already-deleted records:');
  const backfillTargets = [
    { name: 'users', fields: ['email'] },
    { name: 'carriers', fields: ['email'] },
    { name: 'customers', fields: ['email', 'phone'] },
  ];
  for (const { name, fields } of backfillTargets) {
    const col = db.collection(name);
    for (const field of fields) {
      const filter = {
        deletedAt: { $ne: null },
        [field]: { $exists: true, $nin: [null, ''], $not: /^deleted_/ },
      };
      const count = await col.countDocuments(filter);
      if (DRY_RUN) {
        console.log(`  - would free ${name}.${field}: ${count} doc(s)`);
      } else {
        const pipeline = [
          {
            $set: {
              [field]: { $concat: ['deleted_', { $toString: '$deletedAt' }, '_', `$${field}`] },
            },
          },
        ];
        const r = await col.updateMany(filter, pipeline);
        console.log(`  - freed ${name}.${field}: ${r.modifiedCount} doc(s)`);
      }
    }
  }

  if (!DRY_RUN) {
    console.log('\nBuilding new indexes from model definitions (syncIndexes):');
    const models = {
      users: require('../db/Users'),
      carriers: require('../db/Carrier'),
      customers: require('../db/Customer'),
    };
    for (const [name, model] of Object.entries(models)) {
      await model.syncIndexes();
      console.log(`  - synced ${name}`);
    }
  } else {
    console.log('\n[DRY RUN] Skipping syncIndexes. New indexes created on --apply.');
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
