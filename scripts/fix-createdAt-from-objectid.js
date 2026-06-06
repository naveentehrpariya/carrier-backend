/**
 * Fix corrupted `createdAt` timestamps that were caused by the
 * `default: Date.now()` (invoked-once-at-startup) bug.
 *
 * Every MongoDB ObjectId embeds the document's true creation time, so we
 * reset `createdAt` to `_id.getTimestamp()` wherever the two differ by more
 * than a small tolerance.
 *
 * USAGE:
 *   node scripts/fix-createdAt-from-objectid.js              # DRY RUN (no writes)
 *   node scripts/fix-createdAt-from-objectid.js --apply      # actually update
 *   node scripts/fix-createdAt-from-objectid.js --apply --only=orders,customers
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../db/config');

// Collections that had the Date.now() default bug
const COLLECTIONS = [
  'orders',
  'customers',
  'carriers',
  'companies',
  'commudity',
  'charges',
  'equipment',
  'paymentlogs',
  'employee_docs',
  'files',
  'notifications',
];

// Only fix when createdAt is off from the _id timestamp by more than this
// (handles tiny clock differences between _id generation and the doc save).
const TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

async function run() {
  const apply = process.argv.includes('--apply');
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : null;

  const targets = only ? COLLECTIONS.filter(c => only.includes(c)) : COLLECTIONS;

  await connectDB();
  console.log(`\n${apply ? '🔧 APPLY MODE — writing changes' : '🔍 DRY RUN — no changes will be written'}`);
  console.log(`Collections: ${targets.join(', ')}\n`);

  let grandTotal = 0;
  let grandFixed = 0;

  for (const coll of targets) {
    const collection = mongoose.connection.db.collection(coll);

    const total = await collection.countDocuments();
    if (total === 0) {
      console.log(`• ${coll.padEnd(16)} — empty, skipped`);
      continue;
    }

    const cursor = collection.find({}, { projection: { _id: 1, createdAt: 1 } });

    let toFix = 0;
    const ops = [];
    const samples = [];

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const idTime = doc._id.getTimestamp().getTime();
      const current = doc.createdAt ? new Date(doc.createdAt).getTime() : null;

      // Needs fixing if createdAt missing, or differs from _id time beyond tolerance
      if (current === null || Math.abs(current - idTime) > TOLERANCE_MS) {
        toFix++;
        if (samples.length < 3) {
          samples.push({
            _id: doc._id.toString(),
            from: current ? new Date(current).toISOString() : '(none)',
            to: new Date(idTime).toISOString(),
          });
        }
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { createdAt: doc._id.getTimestamp() } },
          },
        });
      }
    }

    grandTotal += total;
    grandFixed += toFix;

    console.log(`• ${coll.padEnd(16)} — ${toFix}/${total} need fixing`);
    samples.forEach(s => console.log(`    e.g. ${s._id}: ${s.from}  →  ${s.to}`));

    if (apply && ops.length > 0) {
      // Write in batches of 1000
      for (let i = 0; i < ops.length; i += 1000) {
        await collection.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
      }
      console.log(`    ✅ Updated ${ops.length} documents`);
    }
  }

  console.log(`\n${apply ? '✅ Done' : '🔍 Dry run complete'} — ${grandFixed}/${grandTotal} documents ${apply ? 'fixed' : 'would be fixed'}.`);
  if (!apply && grandFixed > 0) {
    console.log('Run again with --apply to write the changes.\n');
  }
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
