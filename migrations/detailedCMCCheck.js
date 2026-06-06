require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = "mongodb+srv://cmc:BoYb7a9nu6telXYD@cluster0.8l1eszr.mongodb.net/carrier";

async function detailedCheck() {
  console.log('=== DETAILED CMC DATABASE CHECK ===\n');
  console.log('MongoDB:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  // Get all orders from all tenants
  const allOrders = await Order.find({})
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  console.log(`Total orders found: ${allOrders.length}\n`);

  // Group by tenant
  const byTenant = {};
  allOrders.forEach(o => {
    if (!byTenant[o.tenantId]) byTenant[o.tenantId] = [];
    byTenant[o.tenantId].push(o);
  });

  // Check each tenant
  for (const [tenantId, orders] of Object.entries(byTenant)) {
    console.log(`\n=== TENANT: ${tenantId} ===`);
    console.log(`Total orders: ${orders.length}`);

    // Find orders around March 26, 2026
    const march26 = orders.filter(o => {
      const d = new Date(o.createdAt);
      return d >= new Date('2026-03-25') && d <= new Date('2026-03-27');
    });

    if (march26.length > 0) {
      console.log(`\n⚠️  FOUND ${march26.length} orders around March 26, 2026!`);
      march26.forEach(o => {
        console.log(`  #${o.serial_no} - ${o.createdAt}`);
      });
    }

    // Show recent orders
    console.log(`\n10 Most Recent Orders:`);
    orders.slice(0, 10).forEach((o, i) => {
      console.log(`  ${i+1}. #${o.serial_no} - ${new Date(o.createdAt).toISOString()} - ${o.order_status || 'unknown'}`);
    });

    // Show oldest orders
    console.log(`\n5 Oldest Orders:`);
    orders.slice(-5).reverse().forEach((o, i) => {
      console.log(`  ${i+1}. #${o.serial_no} - ${new Date(o.createdAt).toISOString()}`);
    });
  }

  await mongoose.disconnect();
  console.log('\n✓ Check complete!');
}

detailedCheck().catch(console.error);
