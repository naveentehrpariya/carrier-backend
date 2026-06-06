require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = "mongodb+srv://cmc:BoYb7a9nu6telXYD@cluster0.8l1eszr.mongodb.net/carrier";

async function checkCMCOrders() {
  console.log('=== CMC DATABASE CHECK ===');
  console.log('Using MongoDB URI:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenants = await Order.distinct('tenantId');
  console.log('\nTenants found:', tenants);

  for (const tenantId of tenants) {
    console.log(`\n=== Tenant: ${tenantId} ===`);
    
    const totalOrders = await Order.countDocuments({ tenantId });
    console.log(`Total orders: ${totalOrders}`);

    const recentOrders = await Order.find({ tenantId })
      .sort({ serial_no: -1 })
      .limit(10)
      .select('serial_no createdAt order_status')
      .lean();

    console.log(`\nRecent orders (last 10 by serial_no):`);
    recentOrders.forEach(o => {
      console.log(`  #${o.serial_no} - ${o.createdAt.toISOString()} - ${o.order_status}`);
    });

    // Check for seeder-style order numbers (1001-1050, 1120-1169)
    const seedOrders = await Order.countDocuments({
      tenantId,
      serial_no: { 
        $or: [
          { $gte: 1001, $lte: 1050 },
          { $gte: 1120, $lte: 1169 }
        ]
      }
    });
    console.log(`\nSeeder-style orders found (1001-1050 or 1120-1169): ${seedOrders}`);
  }

  await mongoose.disconnect();
  console.log('\n✓ Check complete!');
}

checkCMCOrders().catch(console.error);
