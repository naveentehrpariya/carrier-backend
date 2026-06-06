/**
 * USAGE:
 *   node scripts/migrate-roles-to-permissions.js            # DRY RUN (no writes)
 *   node scripts/migrate-roles-to-permissions.js --apply    # backup, then migrate
 */
require('dotenv').config();
const connectDB = require('../db/config');
const User = require('../db/Users');
const { backupCollections } = require('./_backupHelper');

async function migrate() {
  try {
    const apply = process.argv.includes('--apply');
    await connectDB();
    console.log('Connected to MongoDB');
    console.log(apply ? '\n🔧 APPLY MODE — will back up then write changes\n' : '\n🔍 DRY RUN — no changes will be written (use --apply to migrate)\n');

    // Always back up the users collection BEFORE applying any change
    if (apply) {
      console.log('Creating backup of users (role/permissions) before migration...');
      await backupCollections('roles-backup', [
        { collection: 'users', projection: { _id: 1, role: 1, is_admin: 1, permissions: 1, allowedModules: 1, modulesCustomized: 1 } },
      ]);
    }

    // Use lean() to get raw MongoDB documents since we removed 'role' from the Mongoose schema
    const users = await User.find({}, null, { includeInactive: true }).lean();
    console.log(`Found ${users.length} users to migrate.`);

    let updatedCount = 0;
    for (const user of users) {
      let permissions = [];
      
      // Company admin: grant access to all modules
      if (user.is_admin === 1 || user.role === 3) {
        permissions = ['regular', 'outsourcing', 'accounting', 'customers', 'employees', 'carriers', 'subadmin'];
      } else {
        // Map role to permissions
        switch (Number(user.role)) {
          case 0:
            permissions = ['driver'];
            break;
          case 1:
            // Staff/Dispatcher: all order types + customers + carriers (no employees)
            permissions = ['regular', 'outsourcing', 'customers', 'carriers'];
            break;
          case 2:
            // Accounting: only accounting tab
            permissions = ['accounting'];
            break;
          default:
            // If they already have a permissions array from recent creation, migrate it
            if (Array.isArray(user.permissions) && user.permissions.length > 0) {
              permissions = user.permissions.map(p => {
                if (p === 'orders') return 'regular'; // Map old 'orders' to 'regular'
                if (p === 'payments') return 'accounting';
                if (p === 'fleet') return 'regular';
                return p;
              });
              // Deduplicate and ensure outsourcing is added if regular is added from orders
              if (user.permissions.includes('orders') && !permissions.includes('outsourcing')) {
                permissions.push('outsourcing');
              }
              permissions = [...new Set(permissions)];
            } else {
              permissions = ['regular', 'outsourcing']; // fallback
            }
        }
      }

      // Add allowedModules to permissions if they had them
      if (Array.isArray(user.allowedModules)) {
        user.allowedModules.forEach(mod => {
          if (!permissions.includes(mod)) permissions.push(mod);
        });
      }

      const updateData = { 
        $set: { permissions: permissions }
      };

      // Also ensure is_admin is explicitly set for admins
      if (user.role === 3) {
         updateData.$set.is_admin = 1;
      }

      if (apply) {
        await User.updateOne(
          { _id: user._id },
          updateData
        );
      }
      updatedCount++;
    }

    if (apply) {
      console.log(`\n✅ Successfully migrated ${updatedCount} users.`);
    } else {
      console.log(`\n🔍 Dry run complete — ${updatedCount} users would be migrated. Run with --apply to write.`);
    }
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
