const mongoose = require('mongoose');
const Order = require('../db/Order');
const Company = require('../db/Company');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function checkSeedOrders() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  
  const tenantId = 'cross-miles-carrier-inc';
  
  // Get a seed order
  const order = await Order.findOne({ tenantId, serial_no: 1050 }).lean();
  
  if (!order) {
    console.log('Order #1050 not found!');
    await mongoose.disconnect();
    return;
  }
  
  console.log('=== Seed Order #1050 Full Details ===\n');
  
  // Print all fields
  for (const [key, value] of Object.entries(order)) {
    if (value !== null && value !== undefined) {
      if (typeof value === 'object') {
        console.log(`${key}:`, JSON.stringify(value).substring(0, 100));
      } else {
        console.log(`${key}:`, value);
      }
    } else {
      console.log(`${key}: NULL`);
    }
  }
  
  // Check required fields for Order model
  console.log('\n\n=== Required Field Check ===');
  console.log('customer:', order.customer ? '✓ EXISTS' : '✗ MISSING');
  console.log('company_name:', order.company_name ? '✓ EXISTS: ' + order.company_name : '✗ MISSING');
  console.log('total_amount:', order.total_amount !== undefined ? '✓ EXISTS: ' + order.total_amount : '✗ MISSING');
  console.log('tenantId:', order.tenantId ? '✓ EXISTS: ' + order.tenantId : '✗ MISSING');
  
  // Check Company
  const company = await Company.findOne({ tenantId }).lean();
  console.log('\n=== Company Details ===');
  console.log('Company exists:', company ? '✓ YES' : '✗ NO');
  if (company) {
    console.log('  _id:', company._id);
    console.log('  name:', company.name);
  }
  
  await mongoose.disconnect();
}

checkSeedOrders().catch(console.error);
