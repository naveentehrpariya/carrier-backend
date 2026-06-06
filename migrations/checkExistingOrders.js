const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function checkExistingOrders() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  
  const tenantId = 'cross-miles-carrier-inc';
  
  // Find all orders with serial_no >= 1100
  const orders = await Order.find({ tenantId, serial_no: { $gte: 1100 } })
    .sort({ serial_no: -1 })
    .limit(10)
    .lean();
  
  console.log(`Found ${orders.length} orders with serial_no >= 1100\n`);
  
  orders.forEach((o, i) => {
    console.log(`\n=== Order #${o.serial_no} ===`);
    console.log('  _id:', o._id);
    console.log('  tenantId:', o.tenantId);
    console.log('  company:', o.company);
    console.log('  company_name:', o.company_name);
    console.log('  order_type:', o.order_type);
    console.log('  order_status:', o.order_status);
    console.log('  createdAt:', o.createdAt);
  });
  
  // Also check total orders for this tenant
  const totalOrders = await Order.countDocuments({ tenantId });
  console.log(`\n\nTotal orders for tenant ${tenantId}: ${totalOrders}`);
  
  await mongoose.disconnect();
}

checkExistingOrders().catch(console.error);
