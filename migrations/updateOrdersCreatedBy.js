require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const User = require('../db/Users');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function updateOrdersCreatedBy() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');

    const tenantId = 'cross-miles-carrier-inc';

    // Get admin user
    const adminUser = await User.findOne({ tenantId, is_admin: 1 }).lean();
    if (!adminUser) {
      console.log('No admin user found');
      process.exit(1);
    }
    console.log(`Using admin user: ${adminUser.name} (${adminUser._id})`);

    // Update all orders without created_by
    const result = await Order.updateMany(
      { tenantId, created_by: { $in: [null, undefined] } },
      { $set: { created_by: adminUser._id } }
    );

    console.log(`Updated ${result.modifiedCount} orders with created_by field`);

    // Verify
    const ordersWithCreator = await Order.countDocuments({ tenantId, created_by: { $exists: true, $ne: null } });
    console.log(`\nTotal orders with created_by: ${ordersWithCreator}`);

    await mongoose.disconnect();
    console.log('\n✓ Done! Orders now have created_by field.');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

updateOrdersCreatedBy();
