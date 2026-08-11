/**
 * Backfill the audit hash chain over entries written before the chain existed.
 *
 *   node backend/scripts/migrate-activity-log-hash-chain.js            # dry run
 *   node backend/scripts/migrate-activity-log-hash-chain.js --apply
 *   node backend/scripts/migrate-activity-log-hash-chain.js --apply --tenant acme
 *
 * Existing entries get a sequence number and a hash so that, from now on,
 * deleting one of them leaves a detectable gap. They are marked `legacy`:
 * their content was never committed to a hash at write time, so their hashes
 * prove ordering from this point forward, not that the content is original.
 * `AuditChainState.genesisSeq` records where real verification begins, and
 * GET /activity-logs/verify reports the two groups separately.
 *
 * Idempotent: entries that already carry a seq are left alone. No money moves.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const ActivityLog = require('../db/ActivityLog');
const AuditChainState = require('../db/AuditChainState');
const { computeHash } = require('../utils/activityLogger');

const APPLY = process.argv.includes('--apply');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const ONLY_TENANT = tenantArg ? tenantArg.split('=')[1] : null;

const DB_URL = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;

async function main() {
  if (!DB_URL) {
    console.error('No DB_URL_OFFICE / MONGODB_URI in env.');
    process.exit(1);
  }

  await mongoose.connect(DB_URL);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}${ONLY_TENANT ? ` (tenant ${ONLY_TENANT})` : ''}`);

  const tenantFilter = ONLY_TENANT ? { tenantId: ONLY_TENANT } : {};
  const tenantIds = await ActivityLog.distinct('tenantId', tenantFilter);
  console.log(`Tenants with audit entries: ${tenantIds.length}`);

  let totalChained = 0;
  let totalSkipped = 0;

  for (const tenantId of tenantIds) {
    // Entries already carrying a seq keep it — this script never re-numbers.
    const existingMax = await ActivityLog
      .findOne({ tenantId, seq: { $ne: null } })
      .sort({ seq: -1 })
      .select('seq hash')
      .lean();

    let seq = existingMax ? existingMax.seq + 1 : 1;
    let prevHash = existingMax ? (existingMax.hash || '') : '';
    const firstBackfilledSeq = seq;

    // Oldest first, so the chain runs in the order the events actually happened.
    // _id is the tiebreaker: entries written in the same millisecond must still
    // get a stable, repeatable order.
    const pending = await ActivityLog
      .find({ tenantId, seq: null })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    if (pending.length === 0) {
      totalSkipped += 1;
      continue;
    }

    console.log(`  ${tenantId}: ${pending.length} entries to chain (starting at seq ${seq})`);

    for (const entry of pending) {
      const chained = { ...entry, seq, prevHash };
      const hash = computeHash(chained);

      if (APPLY) {
        await ActivityLog.updateOne(
          { _id: entry._id },
          { $set: { seq, prevHash, hash, chainStatus: 'legacy' } },
          // The model blocks all update paths; a maintenance script opts out explicitly.
          { auditBypass: true },
        );
      }

      prevHash = hash;
      seq += 1;
      totalChained += 1;
    }

    if (APPLY) {
      await AuditChainState.findOneAndUpdate(
        { tenantId },
        {
          $set: { nextSeq: seq, lastHash: prevHash },
          // Verification of CONTENT starts after the backfilled block. Entries
          // below this line are only proven for ordering.
          $max: { genesisSeq: firstBackfilledSeq + pending.length },
        },
        { upsert: true, new: true },
      );
    }
  }

  console.log('');
  console.log(`Entries chained : ${totalChained}`);
  console.log(`Tenants skipped : ${totalSkipped} (nothing pending)`);
  if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  try { await mongoose.disconnect(); } catch (e) { /* noop */ }
  process.exit(1);
});
