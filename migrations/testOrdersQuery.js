require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function testOrdersAPI() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB\n');

    const tenantId = 'cross-miles-carrier-inc';

    console.log('=== Testing Orders Query ===');
    console.log('Query: { tenantId: "cross-miles-carrier-inc" }');

    // Simulate the exact query from order_listing
    const queryObj = {
      $or: [
        { deletedAt: null },
        { deletedAt: '' },
        { deletedAt: { $exists: false } }
      ],
      tenantId: tenantId
    };

    const orders = await Order.find(queryObj)
      .populate(['created_by', 'customer', 'carrier', 'driver', 'drivers', 'truck', 'trailer', 'ownerOperator'])
      .sort({ serial_no: -1 })
      .limit(10)
      .lean();

    console.log(`\nFound ${orders.length} orders (showing first 10):\n`);

    orders.forEach((o, i) => {
      console.log(`${i+1}. Order #${o.serial_no}`);
      console.log(`   Type: ${o.order_type}, Status: ${o.order_status}`);
      console.log(`   Owner Truck: ${o.isOwnerOperatedTruck ? 'Yes' : 'No'}`);
      console.log(`   Total: $${o.total_amount}, Settle: $${o.settle_amount}`);
      console.log(`   Driver Mode: ${o.driver_assignment_mode}`);
      console.log(`   Created: ${o.createdAt}`);
      console.log('');
    });

    console.log('=== Summary ===');
    console.log(`Total matching orders: ${await Order.countDocuments(queryObj)}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

testOrdersAPI();
