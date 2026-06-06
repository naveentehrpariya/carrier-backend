const mongoose = require('mongoose');
const Order = require('../db/Order');
const Company = require('../db/Company');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function fixSeedOrdersCompany() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  
  const tenantId = 'cross-miles-carrier-inc';
  
  // Get the correct company ID from Company model
  const company = await Company.findOne({ tenantId }).lean();
  if (!company) {
    console.log('Company not found for tenant:', tenantId);
    process.exit(1);
  }
  console.log('Correct Company ID:', company._id);
  console.log('Company Name:', company.name);
  
  // Find all seed orders (serial_no 1001-1050) with wrong company ID
  const wrongCompanyId = '68dffa19d8b26df9ed2c0e33';
  const ordersToUpdate = await Order.countDocuments({
    tenantId,
    serial_no: { $gte: 1001, $lte: 1050 },
    company: wrongCompanyId
  });
  
  console.log('Seed orders to update:', ordersToUpdate);
  
  // Update seed orders with correct company ID
  const result = await Order.updateMany(
    {
      tenantId,
      serial_no: { $gte: 1001, $lte: 1050 },
      company: wrongCompanyId
    },
    {
      $set: {
        company: company._id,
        company_name: company.name
      }
    }
  );
  
  console.log('Updated orders:', result.modifiedCount);
  
  // Verify
  const updatedOrders = await Order.findOne({ tenantId, serial_no: 1050 }).lean();
  console.log('\nVerification - Order #1050:');
  console.log('  company:', updatedOrders.company);
  console.log('  company_name:', updatedOrders.company_name);
  
  await mongoose.disconnect();
  console.log('\n✓ Seed orders company field fixed!');
}

fixSeedOrdersCompany().catch(console.error);
