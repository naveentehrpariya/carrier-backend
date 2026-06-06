require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const User = require('../db/Users');
const Order = require('../db/Order');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function debugTenantIssue() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB\n');

    // Get users with cross-miles-carrier-inc tenant
    const users = await User.find({ tenantId: 'cross-miles-carrier-inc' }).lean();
    console.log('=== Users in cross-miles-carrier-inc ===');
    users.forEach((u, i) => {
      console.log(`${i+1}. ${u.name} (${u.email})`);
      console.log(`   - _id: ${u._id}`);
      console.log(`   - tenantId: ${u.tenantId}`);
      console.log(`   - role: ${u.role}, is_admin: ${u.is_admin}`);
      console.log('');
    });

    // Check if orders have created_by field
    const orders = await Order.find({ tenantId: 'cross-miles-carrier-inc' }).limit(5).lean();
    console.log('=== Orders without created_by ===');
    orders.forEach((o, i) => {
      console.log(`Order ${o.serial_no}: created_by = ${o.created_by || 'NULL'}`);
    });

    // Count orders by created_by
    const ordersWithCreator = await Order.countDocuments({ tenantId: 'cross-miles-carrier-inc', created_by: { $exists: true, $ne: null } });
    const ordersWithoutCreator = await Order.countDocuments({ tenantId: 'cross-miles-carrier-inc', $or: [{ created_by: null }, { created_by: { $exists: false } }] });

    console.log(`\nOrders with created_by: ${ordersWithCreator}`);
    console.log(`Orders without created_by: ${ordersWithoutCreator}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

debugTenantIssue();
