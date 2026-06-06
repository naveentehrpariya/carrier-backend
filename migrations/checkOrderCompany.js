const mongoose = require('mongoose');
const Order = require('../db/Order');
const Company = require('../db/Company');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function checkOrderCompanyMismatch() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  
  const tenantId = 'cross-miles-carrier-inc';
  
  // Check seed orders
  const seedOrder = await Order.findOne({ tenantId, serial_no: 1050 }).lean();
  console.log('Seed Order #1050:');
  console.log('  tenantId:', seedOrder.tenantId);
  console.log('  company:', seedOrder.company);
  console.log('  company_name:', seedOrder.company_name);
  
  // Check existing order
  const existingOrder = await Order.findOne({ tenantId, serial_no: 1119 }).lean();
  console.log('\nExisting Order #1119:');
  console.log('  tenantId:', existingOrder.tenantId);
  console.log('  company:', existingOrder.company);
  console.log('  company_name:', existingOrder.company_name);
  
  // Check Company
  const company = await Company.findOne({ tenantId }).lean();
  console.log('\nCompany for tenant:');
  console.log('  _id:', company._id);
  console.log('  name:', company.name);
  
  // Check all orders with their company field
  const ordersWithCompany = await Order.countDocuments({ tenantId, company: { $exists: true, $ne: null } });
  const ordersWithoutCompany = await Order.countDocuments({ tenantId, $or: [{ company: null }, { company: { $exists: false } }] });
  
  console.log('\n=== Company Field Analysis ===');
  console.log('Orders WITH company field:', ordersWithCompany);
  console.log('Orders WITHOUT company field:', ordersWithoutCompany);
  
  await mongoose.disconnect();
}

checkOrderCompanyMismatch().catch(console.error);
