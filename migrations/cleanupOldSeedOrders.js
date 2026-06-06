require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function cleanupOldSeedOrders() {
  console.log('=== CLEANUP OLD SEED ORDERS ===');
  console.log('Using MongoDB URI:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  // Find orders with serial_no 1001-1050
  const oldOrders = await Order.find({ 
    tenantId, 
    serial_no: { $gte: 1001, $lte: 1050 } 
  }).lean();

  console.log(`Found ${oldOrders.length} old seed orders (serial_no 1001-1050)`);

  if (oldOrders.length > 0) {
    const orderIds = oldOrders.map(o => o._id);
    
    // Delete trips for these orders
    const deletedTrips = await Trip.deleteMany({ order: { $in: orderIds } });
    console.log(`Deleted ${deletedTrips.deletedCount} trips`);
    
    // Delete orders
    const deletedOrders = await Order.deleteMany({ 
      tenantId, 
      serial_no: { $gte: 1001, $lte: 1050 } 
    });
    console.log(`Deleted ${deletedOrders.deletedCount} orders`);
  }

  // Verify remaining orders
  const remainingOrders = await Order.countDocuments({ tenantId });
  const remainingOrderNums = await Order.find({ tenantId })
    .sort({ serial_no: -1 })
    .limit(5)
    .select('serial_no')
    .lean();
  
  console.log(`\nRemaining orders: ${remainingOrders}`);
  console.log('Top 5 order numbers:', remainingOrderNums.map(o => o.serial_no).join(', '));

  await mongoose.disconnect();
  console.log('\n✓ Cleanup complete!');
}

cleanupOldSeedOrders().catch(console.error);
