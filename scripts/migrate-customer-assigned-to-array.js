/**
 * Migration: Customer.assigned_to  ObjectId → [ObjectId]
 *
 * Safe to run multiple times — already-migrated docs (where assigned_to is
 * already an array) are detected by the $type check and skipped.
 *
 * Usage:
 *   node backend/scripts/migrate-customer-assigned-to-array.js
 *   node backend/scripts/migrate-customer-assigned-to-array.js --apply   (actually writes)
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
  console.log('[DRY RUN] Pass --apply to actually write changes.\n');
}

async function run() {
  await mongoose.connect(DB_URI);
  console.log('Connected to MongoDB.\n');

  const col = mongoose.connection.collection('customers');

  // Docs where assigned_to is a single ObjectId (type 7 = objectId in BSON)
  const singleOidCursor = col.find({ assigned_to: { $type: 'objectId' } });
  const singleDocs = await singleOidCursor.toArray();

  // Docs where assigned_to is null or missing
  const nullCursor = col.find({
    $or: [{ assigned_to: null }, { assigned_to: { $exists: false } }],
  });
  const nullDocs = await nullCursor.toArray();

  console.log(`Single-ObjectId docs to convert : ${singleDocs.length}`);
  console.log(`Null/missing docs to convert    : ${nullDocs.length}`);

  if (DRY_RUN) {
    console.log('\nRun with --apply to perform the migration.');
    await mongoose.disconnect();
    return;
  }

  let converted = 0;
  let nulled = 0;

  // Convert single ObjectId → [ObjectId]
  for (const doc of singleDocs) {
    await col.updateOne(
      { _id: doc._id },
      { $set: { assigned_to: [doc.assigned_to] } }
    );
    converted++;
  }

  // Convert null/missing → []
  for (const doc of nullDocs) {
    await col.updateOne(
      { _id: doc._id },
      { $set: { assigned_to: [] } }
    );
    nulled++;
  }

  console.log(`\nConverted single-ObjectId : ${converted}`);
  console.log(`Converted null/missing    : ${nulled}`);
  console.log('\nMigration complete.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
