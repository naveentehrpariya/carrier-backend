require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const User = require('../db/Users');
const Order = require('../db/Order');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function checkUsersTenant() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB\n');

    // Get all users
    const users = await User.find().lean();
    console.log('=== All Users ===');
    users.forEach((u, i) => {
      console.log(`${i+1}. ${u.name} (${u.email})`);
      console.log(`   - tenantId: ${u.tenantId}`);
      console.log(`   - role: ${u.role}, is_admin: ${u.is_admin}`);
      console.log('');
    });

    // Check orders tenantId
    const orders = await Order.find().limit(3).lean();
    console.log('=== Sample Orders TenantId ===');
    orders.forEach((o, i) => {
      console.log(`Order ${i+1}: ${o.serial_no} - tenantId: ${o.tenantId}`);
    });

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

checkUsersTenant();
