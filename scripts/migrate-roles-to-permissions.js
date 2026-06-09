/**
 * USAGE:
 *   node scripts/migrate-roles-to-permissions.js            # DRY RUN (no writes)
 *   node scripts/migrate-roles-to-permissions.js --apply    # backup, then migrate
 *
 * Permission rules:
 *   Admin (is_admin=1 or role=3) → ALL permissions
 *   Staff/Dispatcher (role=1)    → customers + carriers (view all) + regular + outsourcing
 *   Accounting (role=2)          → accounting only
 *   Driver (role=0)              → driver only
 */
require('dotenv').config();
const connectDB = require('../db/config');
const User = require('../db/Users');
const { backupCollections } = require('./_backupHelper');

// customers/carriers = read-only view; customers_write/carriers_write = create/edit/delete
const ALL_ADMIN_PERMISSIONS  = ['regular', 'outsourcing', 'accounting', 'customers', 'customers_write', 'carriers', 'carriers_write', 'employees', 'subadmin'];
const STAFF_PERMISSIONS      = ['regular', 'outsourcing', 'customers', 'carriers'];
const ACCOUNTING_PERMISSIONS = ['accounting', 'customers', 'carriers'];
const DRIVER_PERMISSIONS     = ['driver'];

function resolvePermissions(user) {
  // Admin: full access
  if (user.is_admin === 1 || Number(user.role) === 3) {
    return ALL_ADMIN_PERMISSIONS;
  }

  const role = Number(user.role);

  switch (role) {
    case 0:
      return DRIVER_PERMISSIONS;

    case 1:
      // Staff/Dispatcher: see all carriers + assigned customers by default
      return STAFF_PERMISSIONS;

    case 2:
      return ACCOUNTING_PERMISSIONS;

    default: {
      // User was created with new system — migrate old permission names
      if (Array.isArray(user.permissions) && user.permissions.length > 0) {
        let perms = user.permissions.map(p => {
          if (p === 'orders' || p === 'fleet') return 'regular';
          if (p === 'payments') return 'accounting';
          if (p === 'admin') return null; // drop legacy 'admin' string
          return p;
        }).filter(Boolean);

        if (user.permissions.includes('orders') && !perms.includes('outsourcing')) {
          perms.push('outsourcing');
        }
        return [...new Set(perms)];
      }
      // No role, no permissions — give basic staff access as safe default
      return STAFF_PERMISSIONS;
    }
  }
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
      console.log('Creating backup of users (role/permissions) before migration...');
      await backupCollections('roles-backup', [
        { collection: 'users', projection: { _id: 1, role: 1, is_admin: 1, permissions: 1, allowedModules: 1, modulesCustomized: 1 } },
      ]);
    }

    const users = await User.find({}, null, { includeInactive: true }).lean();
    console.log(`Found ${users.length} users to process.\n`);

    const summary = { admin: 0, staff: 0, accounting: 0, driver: 0, other: 0 };
    let updatedCount = 0;

    for (const user of users) {
      let permissions = resolvePermissions(user);

      // Merge any allowedModules into permissions (keeps backward compat)
      if (Array.isArray(user.allowedModules)) {
        user.allowedModules.forEach(mod => {
          if (!permissions.includes(mod)) permissions.push(mod);
        });
      }

      const updateData = { $set: { permissions } };

      // Ensure is_admin flag is set for role-3 users
      if (Number(user.role) === 3) {
        updateData.$set.is_admin = 1;
      }

      if (apply) {
        await User.updateOne({ _id: user._id }, updateData);
      } else {
        console.log(`  [DRY] ${user.email || user._id}  role=${user.role} is_admin=${user.is_admin}  → [${permissions.join(', ')}]`);
      }

      // Tally for summary
      if (user.is_admin === 1 || Number(user.role) === 3) summary.admin++;
      else if (Number(user.role) === 1) summary.staff++;
      else if (Number(user.role) === 2) summary.accounting++;
      else if (Number(user.role) === 0) summary.driver++;
      else summary.other++;

      updatedCount++;
    }

    console.log('\n--- Summary ---');
    console.log(`  Admin      : ${summary.admin}`);
    console.log(`  Staff      : ${summary.staff}`);
    console.log(`  Accounting : ${summary.accounting}`);
    console.log(`  Driver     : ${summary.driver}`);
    console.log(`  Other      : ${summary.other}`);
    console.log(`  Total      : ${updatedCount}`);

    if (apply) {
      console.log(`\n✅ Successfully migrated ${updatedCount} users.`);
    } else {
      console.log(`\n🔍 Dry run complete. Run with --apply to write changes.`);
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
