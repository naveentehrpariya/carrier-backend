const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function checkOrder1119() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  
  const order = await Order.findOne({ serial_no: 1119 }).lean();
  
  console.log('=== Order #1119 Full Details ===\n');
  console.log('Basic Info:');
  console.log('  _id:', order._id);
  console.log('  serial_no:', order.serial_no);
  console.log('  customer_order_no:', order.customer_order_no);
  console.log('  tenantId:', order.tenantId);
  console.log('  company:', order.company);
  console.log('  company_name:', order.company_name);
  
  console.log('\nOrder Type & Status:');
  console.log('  order_type:', order.order_type);
  console.log('  order_status:', order.order_status);
  
  console.log('\nOwner Operator Fields:');
  console.log('  isOwnerOperatedTruck:', order.isOwnerOperatedTruck);
  console.log('  ownerOperator:', order.ownerOperator);
  console.log('  settle_amount:', order.settle_amount);
  console.log('  owner_profit:', order.owner_profit);
  console.log('  driver_assignment_mode:', order.driver_assignment_mode);
  console.log('  driver_assignment_status:', order.driver_assignment_status);
  
  console.log('\nDrivers:');
  console.log('  driver:', order.driver);
  console.log('  drivers:', order.drivers);
  
  console.log('\nTruck:');
  console.log('  truck:', order.truck);
  console.log('  trailer:', order.trailer);
  
  console.log('\nCustomer:');
  console.log('  customer:', order.customer);
  
  console.log('\nAmounts:');
  console.log('  total_amount:', order.total_amount);
  console.log('  carrier_amount:', order.carrier_amount);
  console.log('  revenue_items:', order.revenue_items?.length || 0, 'items');
  
  console.log('\nShipping:');
  console.log('  shipping_details:', order.shipping_details?.length || 0, 'items');
  
  console.log('\nDates:');
  console.log('  createdAt:', order.createdAt);
  console.log('  created_by:', order.created_by);
  
  console.log('\nDeleted:');
  console.log('  deletedAt:', order.deletedAt);
  
  // Now compare with seed order
  const seedOrder = await Order.findOne({ serial_no: 1050 }).lean();
  
  console.log('\n\n=== Comparison with Seed Order #1050 ===\n');
  console.log('Seed Order Fields:');
  console.log('  _id:', seedOrder._id);
  console.log('  serial_no:', seedOrder.serial_no);
  console.log('  tenantId:', seedOrder.tenantId);
  console.log('  company:', seedOrder.company);
  console.log('  company_name:', seedOrder.company_name);
  console.log('  order_type:', seedOrder.order_type);
  console.log('  order_status:', seedOrder.order_status);
  console.log('  isOwnerOperatedTruck:', seedOrder.isOwnerOperatedTruck);
  console.log('  ownerOperator:', seedOrder.ownerOperator);
  console.log('  settle_amount:', seedOrder.settle_amount);
  console.log('  driver_assignment_mode:', seedOrder.driver_assignment_mode);
  console.log('  driver:', seedOrder.driver);
  console.log('  drivers:', seedOrder.drivers);
  console.log('  truck:', seedOrder.truck);
  console.log('  created_by:', seedOrder.created_by);
  console.log('  deletedAt:', seedOrder.deletedAt);
  
  await mongoose.disconnect();
}

checkOrder1119().catch(console.error);
