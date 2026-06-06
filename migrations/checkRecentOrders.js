require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');

const MONGODB_URI = "mongodb+srv://cmc:BoYb7a9nu6telXYD@cluster0.8l1eszr.mongodb.net/carrier";

async function checkRecentOrders() {
  console.log('=== CHECK RECENT ORDERS ===');
  console.log('Using MongoDB URI:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  // Get all tenants
  const tenants = await Order.distinct('tenantId');
  console.log('Tenants found:', tenants);

  for (const tenantId of tenants) {
    console.log(`\n=== Tenant: ${tenantId} ===`);
    
    // Get orders sorted by date
    const recentOrders = await Order.find({ tenantId })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('serial_no createdAt order_status')
      .lean();
    
    console.log(`Recent orders (last 10):`);
    recentOrders.forEach(o => {
      console.log(`  #${o.serial_no} - ${o.createdAt} - ${o.order_status}`);
    });

    // Check last 7 days
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    const weekOrders = await Order.countDocuments({
      tenantId,
      createdAt: { $gte: weekAgo }
    });
    console.log(`Orders in last 7 days: ${weekOrders}`);
  }

  await mongoose.disconnect();
}

checkRecentOrders().catch(console.error);
