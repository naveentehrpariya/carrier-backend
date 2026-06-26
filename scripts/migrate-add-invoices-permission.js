/**
 * Backfill the `invoices` permission (download customer invoices).
 *
 * USAGE:
 *   node scripts/migrate-add-invoices-permission.js            # DRY RUN (no writes)
 *   node scripts/migrate-add-invoices-permission.js --apply    # backup, then migrate
 *
 * Rule (per product decision): grant `invoices` by default to EVERYONE EXCEPT plain
 * staff/dispatchers and drivers. Staff must be granted the permission explicitly by an
 * admin. Concretely, a user RECEIVES `invoices` when any of these is true:
 *   - is_admin === 1 or role === 3 (admin)
 *   - permissions include 'subadmin'
 *   - permissions include 'accounting'
 * Drivers (role 0 / 'driver' permission) and plain staff are skipped.
 * Idempotent — users that already have `invoices` are left unchanged.
 */
require('dotenv').config();
const connectDB = require('../db/config');
const User = require('../db/Users');
const { backupCollections } = require('./_backupHelper');

function shouldGrant(user) {
  if (user.is_admin === 1 || Number(user.role) === 3) return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  if (perms.includes('driver') || Number(user.role) === 0) return false; // drivers never
  return perms.includes('subadmin') || perms.includes('accounting');
}

async function migrate() {
  try {
    const apply = process.argv.includes('--apply');
    await connectDB();
    console.log('Connected to MongoDB');
    console.log(apply
      ? '\n🔧 APPLY MODE — will back up then write changes\n'
      : '\n🔍 DRY RUN — no changes will be written (use --apply to migrate)\n');

    if (apply) {
      console.log('Creating backup of users (permissions) before migration...');
      await backupCollections('invoices-permission-backup', [
        { collection: 'users', projection: { _id: 1, role: 1, is_admin: 1, permissions: 1 } },
      ]);
    }

    const users = await User.find({}, null, { includeInactive: true }).lean();
    console.log(`Found ${users.length} users to process.\n`);

    const summary = { granted: 0, skippedStaff: 0, alreadyHad: 0 };

    for (const user of users) {
      const perms = Array.isArray(user.permissions) ? user.permissions : [];
      if (perms.includes('invoices')) { summary.alreadyHad++; continue; }

      if (!shouldGrant(user)) {
        summary.skippedStaff++;
        if (!apply) console.log(`  [DRY] SKIP  ${user.email || user._id}  role=${user.role} is_admin=${user.is_admin}  perms=[${perms.join(', ')}]`);
        continue;
      }

      if (apply) {
        await User.updateOne({ _id: user._id }, { $addToSet: { permissions: 'invoices' } });
      } else {
        console.log(`  [DRY] GRANT ${user.email || user._id}  role=${user.role} is_admin=${user.is_admin}  perms=[${perms.join(', ')}] → +invoices`);
      }
      summary.granted++;
    }

    console.log('\n--- Summary ---');
    console.log(`  Granted invoices : ${summary.granted}`);
    console.log(`  Skipped (staff)  : ${summary.skippedStaff}`);
    console.log(`  Already had it   : ${summary.alreadyHad}`);
    console.log(`  Total            : ${users.length}`);

    console.log(apply
      ? `\n✅ Successfully granted invoices to ${summary.granted} users.`
      : `\n🔍 Dry run complete. Run with --apply to write changes.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
