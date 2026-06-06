require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const OwnerOperator = require('../db/OwnerOperator');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function verifyAllData() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB\n');

    const tenantId = 'cross-miles-carrier-inc';

    // Count all data
    const orderCount = await Order.countDocuments({ tenantId });
    const tripCount = await Trip.countDocuments({ tenantId });
    const ownerOpCount = await OwnerOperator.countDocuments({ tenantId });

    console.log('=== DATABASE VERIFICATION ===');
    console.log(`Tenant: ${tenantId}`);
    console.log(`Orders: ${orderCount}`);
    console.log(`Trips: ${tripCount}`);
    console.log(`Owner Operators: ${ownerOpCount}`);

    // Get sample orders
    const orders = await Order.find({ tenantId })
      .sort({ serial_no: -1 })
      .limit(5)
      .lean();

    console.log('\n=== SAMPLE ORDERS (Top 5) ===');
    orders.forEach((o, i) => {
      console.log(`\nOrder #${o.serial_no}:`);
      console.log(`  Status: ${o.order_status}`);
      console.log(`  Type: ${o.order_type}`);
      console.log(`  Owner Truck: ${o.isOwnerOperatedTruck ? 'Yes' : 'No'}`);
      console.log(`  Amount: $${o.total_amount}`);
      console.log(`  Settle: $${o.settle_amount}`);
      console.log(`  Driver Mode: ${o.driver_assignment_mode}`);
      console.log(`  Created: ${o.createdAt}`);
    });

    // Get owner operator orders breakdown
    const ownerOrders = await Order.countDocuments({ tenantId, isOwnerOperatedTruck: true });
    const regularOrders = await Order.countDocuments({ tenantId, isOwnerOperatedTruck: false });

    console.log('\n=== ORDER BREAKDOWN ===');
    console.log(`Owner Operated: ${ownerOrders}`);
    console.log(`Regular: ${regularOrders}`);

    // Check orders by status
    const statusBreakdown = await Order.aggregate([
      { $match: { tenantId } },
      { $group: { _id: '$order_status', count: { $sum: 1 } } }
    ]);

    console.log('\n=== STATUS BREAKDOWN ===');
    statusBreakdown.forEach(s => {
      console.log(`${s._id}: ${s.count}`);
    });

    console.log('\n=== CONCLUSION ===');
    if (orderCount > 0) {
      console.log('✓ Data exists in database');
      console.log('✓ Orders are ready to be displayed');
      console.log('\nFrontend issue - Check browser console for tenant context logs');
    } else {
      console.log('✗ No orders found - Run seed script again');
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

verifyAllData();
