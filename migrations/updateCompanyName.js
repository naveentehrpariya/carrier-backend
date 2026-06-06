require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Company = require('../db/Company');
const Order = require('../db/Order');
const OwnerOperator = require('../db/OwnerOperator');
const Truck = require('../db/Truck');
const Trip = require('../db/Trip');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function updateCompanyName() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');

    // Update company name to "Cross Miles Carrier Inc"
    const result = await Company.updateOne(
      { tenantId: 'cross-miles-carrier-inc' },
      { $set: { name: 'Cross Miles Carrier Inc' } }
    );
    
    if (result.modifiedCount > 0) {
      console.log('✓ Company name updated to "Cross Miles Carrier Inc"');
    } else {
      console.log('Company not found or name already updated');
    }

    // Also update all orders' company_name field
    const ordersUpdated = await Order.updateMany(
      { tenantId: 'cross-miles-carrier-inc' },
      { $set: { company_name: 'Cross Miles Carrier Inc' } }
    );
    console.log(`✓ Updated ${ordersUpdated.modifiedCount} orders with new company name`);

    // Verify the update
    const company = await Company.findOne({ tenantId: 'cross-miles-carrier-inc' }).lean();
    console.log(`\nCurrent company name: ${company.name}`);

    await mongoose.disconnect();
    console.log('\n✓ Company name updated successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

updateCompanyName();
