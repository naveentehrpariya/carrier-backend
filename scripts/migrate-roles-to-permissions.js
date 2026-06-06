require('dotenv').config();
const connectDB = require('../db/config');
const User = require('../db/Users');

async function migrate() {
  try {
    await connectDB();
    console.log('Connected to MongoDB');

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

      await User.updateOne(
        { _id: user._id },
        updateData
      );
      updatedCount++;
    }

    console.log(`Successfully migrated ${updatedCount} users.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
