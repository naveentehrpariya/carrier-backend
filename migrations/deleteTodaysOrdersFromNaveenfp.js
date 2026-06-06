require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');

const MONGODB_URI = "mongodb+srv://naveenfp:naveenfp@cluster0.5c8ne.mongodb.net/carrier";

async function deleteTodaysOrders() {
  console.log('=== DELETE TODAY\'S ORDERS ===');
  console.log('Using MongoDB URI:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  // Get all orders sorted by date
  const recentOrders = await Order.find({ tenantId })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('serial_no createdAt')
    .lean();

  console.log(`\nRecent orders (last 20):`);
  recentOrders.forEach(o => {
    console.log(`  #${o.serial_no} - ${o.createdAt}`);
  });

  // Delete last 50 orders (the ones we just added)
  const orderNums = recentOrders.slice(0, 50).map(o => o.serial_no);
  console.log(`\nDeleting orders: ${orderNums.join(', ')}`);

  if (orderNums.length > 0) {
    const ordersToDelete = await Order.find({ 
      tenantId, 
      serial_no: { $in: orderNums } 
    }).lean();

    const orderIds = ordersToDelete.map(o => o._id);
    
    // Delete trips
    const deletedTrips = await Trip.deleteMany({ order: { $in: orderIds } });
    console.log(`Deleted ${deletedTrips.deletedCount} trips`);

    // Delete orders
    const deletedOrders = await Order.deleteMany({ 
      tenantId, 
      serial_no: { $in: orderNums } 
    });
    console.log(`Deleted ${deletedOrders.deletedCount} orders`);
  }

  await mongoose.disconnect();
  console.log('\n✓ Today\'s seed orders deleted!');
}

deleteTodaysOrders().catch(console.error);
