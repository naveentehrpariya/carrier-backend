require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = "mongodb+srv://cmc:BoYb7a9nu6telXYD@cluster0.8l1eszr.mongodb.net/carrier";

async function checkMarch26OrdersCMC() {
  console.log('=== CHECK MARCH 26, 2026 ORDERS - CMC DATABASE ===');
  console.log('Using MongoDB URI:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  // March 26, 2026 9:58:08 PM IST = March 26, 2026 16:28:08 UTC
  const startOfDay = new Date('2026-03-26T00:00:00.000Z');
  const endOfDay = new Date('2026-03-27T00:00:00.000Z');

  console.log(`Day range: ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);

  const march26Orders = await Order.find({
    tenantId,
    createdAt: {
      $gte: startOfDay,
      $lt: endOfDay
    }
  }).sort({ createdAt: 1 }).lean();

  console.log(`\nFound ${march26Orders.length} orders created on March 26, 2026`);

  if (march26Orders.length > 0) {
    march26Orders.slice(0, 20).forEach((o, i) => {
      console.log(`  ${i+1}. #${o.serial_no} - ${o.createdAt.toISOString()}`);
    });
  }

  // Also show all tenants and their order counts
  console.log('\n\n=== ALL TENANTS ===');
  const tenants = await Order.distinct('tenantId');
  for (const tenant of tenants) {
    const count = await Order.countDocuments({ tenantId: tenant });
    console.log(`  ${tenant}: ${count} orders`);
  }

  await mongoose.disconnect();
  console.log('\n✓ Check complete!');
}

checkMarch26OrdersCMC().catch(console.error);
