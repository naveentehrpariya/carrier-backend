require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = "mongodb+srv://naveenfp:naveenfp@cluster0.5c8ne.mongodb.net/carrier";

async function checkMarch26Orders() {
  console.log('=== CHECK MARCH 26, 2026 ORDERS ===');
  console.log('Using MongoDB URI:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  // March 26, 2026 9:58:08 PM IST = March 26, 2026 16:28:08 UTC
  const targetDate = new Date('2026-03-26T16:28:08.000Z');
  const startOfDay = new Date('2026-03-26T00:00:00.000Z');
  const endOfDay = new Date('2026-03-27T00:00:00.000Z');

  console.log(`Looking for orders around: ${targetDate.toISOString()}`);
  console.log(`Day range: ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);

  // Find orders created on March 26, 2026
  const march26Orders = await Order.find({
    tenantId,
    createdAt: {
      $gte: startOfDay,
      $lt: endOfDay
    }
  }).sort({ createdAt: 1 }).lean();

  console.log(`\nFound ${march26Orders.length} orders created on March 26, 2026`);

  if (march26Orders.length > 0) {
    console.log('\nFirst 10 orders:');
    march26Orders.slice(0, 10).forEach((o, i) => {
      console.log(`  ${i+1}. #${o.serial_no} - ${o.createdAt.toISOString()}`);
    });

    if (march26Orders.length > 10) {
      console.log(`  ... and ${march26Orders.length - 10} more`);
    }

    // Check for same timestamp
    const byTimestamp = {};
    march26Orders.forEach(o => {
      const ts = o.createdAt.toISOString();
      if (!byTimestamp[ts]) byTimestamp[ts] = [];
      byTimestamp[ts].push(o.serial_no);
    });

    console.log('\nOrders grouped by exact timestamp:');
    Object.entries(byTimestamp).slice(0, 5).forEach(([ts, serials]) => {
      console.log(`  ${ts}: ${serials.length} orders - ${serials.slice(0, 3).join(', ')}${serials.length > 3 ? '...' : ''}`);
    });
  }

  // Also check all orders sorted by date
  const allOrders = await Order.find({ tenantId })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('serial_no createdAt')
    .lean();

  console.log('\n\n20 most recent orders:');
  allOrders.forEach(o => {
    console.log(`  #${o.serial_no} - ${o.createdAt.toISOString()}`);
  });

  await mongoose.disconnect();
  console.log('\n✓ Check complete!');
}

checkMarch26Orders().catch(console.error);
