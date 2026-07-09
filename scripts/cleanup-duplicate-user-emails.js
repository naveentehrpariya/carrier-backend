/**
 * Cleanup: resolve duplicate login emails across tenants so the global
 * unique index on users.email can be created (see
 * migrate-tenant-unique-indexes.js).
 *
 * For each email that exists on more than one user doc:
 *   - exactly ONE active doc + rest inactive/soft-deleted → soft-delete the
 *     inactive ones (same as tenantAdmin removeUser: mangle email to
 *     `deleted_<ts>_<email>`, set status=inactive + deletedAt). The doc stays,
 *     so old orders/trips/salaries referencing the user keep working.
 *   - anything ambiguous (multiple active, or all inactive) → SKIPPED and
 *     listed for manual resolution.
 *
 * Safe to run multiple times.
 *
 * Usage:
 *   node backend/scripts/cleanup-duplicate-user-emails.js           (dry run)
 *   node backend/scripts/cleanup-duplicate-user-emails.js --apply
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
  const users = mongoose.connection.db.collection('users');
  console.log('Connected to MongoDB.\n');

  const dupes = await users
    .aggregate([
      { $group: { _id: '$email', count: { $sum: 1 }, docs: { $push: { id: '$_id', tenantId: '$tenantId', status: '$status', deletedAt: '$deletedAt' } } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (dupes.length === 0) {
    console.log('No duplicate emails found. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  let fixed = 0;
  const skipped = [];

  for (const d of dupes) {
    const active = d.docs.filter((x) => x.status === 'active' && !x.deletedAt);
    const losers = d.docs.filter((x) => !(x.status === 'active' && !x.deletedAt));

    if (active.length !== 1) {
      skipped.push({ email: d._id, reason: `${active.length} active docs`, docs: d.docs });
      continue;
    }

    for (const loser of losers) {
      const ts = Date.now();
      const newEmail = `deleted_${ts}_${d._id}`;
      if (DRY_RUN) {
        console.log(`[DRY RUN] ${d._id}: keep ${active[0].tenantId}, soft-delete doc ${loser.id} (${loser.tenantId}) → ${newEmail}`);
      } else {
        await users.updateOne(
          { _id: loser.id },
          { $set: { email: newEmail, status: 'inactive', deletedAt: new Date() } }
        );
        console.log(`${d._id}: kept ${active[0].tenantId}, soft-deleted doc ${loser.id} (${loser.tenantId})`);
      }
      fixed++;
    }
  }

  console.log(`\n${DRY_RUN ? 'Would fix' : 'Fixed'}: ${fixed} doc(s).`);
  if (skipped.length > 0) {
    console.log(`SKIPPED ${skipped.length} email(s) — resolve manually:`);
    for (const s of skipped) {
      console.log(`  ${s.email} (${s.reason}): ${s.docs.map((x) => `${x.id}@${x.tenantId}[${x.status}${x.deletedAt ? ',deleted' : ''}]`).join('  ')}`);
    }
  }

  console.log('\nDone. Now re-run: node backend/scripts/migrate-tenant-unique-indexes.js --apply');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
