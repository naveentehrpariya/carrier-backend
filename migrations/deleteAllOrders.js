require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');

const MONGODB_URI = "mongodb+srv://naveenfp:naveenfp@cluster0.5c8ne.mongodb.net/carrier";

async function deleteAllOrders() {
  console.log('=== DELETE ALL ORDERS ===');
  console.log('MongoDB:', MONGODB_URI);
  console.log('\n⚠️  WARNING: This will delete ALL orders and trips!\n');

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  // Count before deletion
  const orderCount = await Order.countDocuments({ tenantId });
  const tripCount = await Trip.countDocuments({ tenantId });

  console.log(`Current data:`);
  console.log(`  - Orders: ${orderCount}`);
  console.log(`  - Trips: ${tripCount}`);

  // Delete trips first
  const deletedTrips = await Trip.deleteMany({ tenantId });
  console.log(`\nDeleted trips: ${deletedTrips.deletedCount}`);

  // Delete orders
  const deletedOrders = await Order.deleteMany({ tenantId });
  console.log(`Deleted orders: ${deletedOrders.deletedCount}`);

  // Verify
  const remainingOrders = await Order.countDocuments({ tenantId });
  const remainingTrips = await Trip.countDocuments({ tenantId });

  console.log(`\n=== AFTER DELETION ===`);
  console.log(`  - Orders remaining: ${remainingOrders}`);
  console.log(`  - Trips remaining: ${remainingTrips}`);

  if (remainingOrders === 0 && remainingTrips === 0) {
    console.log(`\n✓ All orders and trips deleted successfully!`);
  } else {
    console.log(`\n⚠️  Some data still remains!`);
  }

  await mongoose.disconnect();
}

deleteAllOrders().catch(console.error);
