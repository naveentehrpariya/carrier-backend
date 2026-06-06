require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');

const MONGODB_URI = "mongodb+srv://cmc:BoYb7a9nu6telXYD@cluster0.8l1eszr.mongodb.net/carrier";

async function deleteTodaysOrders() {
  console.log('=== DELETE TODAY\'S ORDERS ===');
  console.log('Using MongoDB URI:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  console.log(`Deleting orders created today: ${today.toISOString()} to ${tomorrow.toISOString()}`);

  // Find orders created today
  const todaysOrders = await Order.find({
    createdAt: {
      $gte: today,
      $lt: tomorrow
    }
  }).lean();

  console.log(`Found ${todaysOrders.length} orders created today`);

  if (todaysOrders.length > 0) {
    const orderIds = todaysOrders.map(o => o._id);
    console.log(`Order IDs: ${orderIds.join(', ')}`);

    // Delete trips
    const deletedTrips = await Trip.deleteMany({ order: { $in: orderIds } });
    console.log(`Deleted ${deletedTrips.deletedCount} trips`);

    // Delete orders
    const deletedOrders = await Order.deleteMany({
      createdAt: {
        $gte: today,
        $lt: tomorrow
      }
    });
    console.log(`Deleted ${deletedOrders.deletedCount} orders`);
  }

  await mongoose.disconnect();
  console.log('\n✓ Today\'s orders deleted!');
}

deleteTodaysOrders().catch(console.error);
