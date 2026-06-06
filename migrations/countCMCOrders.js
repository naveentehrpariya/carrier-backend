const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = "mongodb+srv://cmc:BoYb7a9nu6telXYD@cluster0.8l1eszr.mongodb.net/carrier";

async function countOrders() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenants = await Order.distinct('tenantId');
  console.log('\n=== CMC DATABASE ORDER COUNT ===\n');
  console.log('Total tenants:', tenants.length);

  let grandTotal = 0;
  for (const tenantId of tenants) {
    const count = await Order.countDocuments({ tenantId });
    grandTotal += count;
    console.log(`Tenant: ${tenantId} - Orders: ${count}`);
  }

  const total = await Order.countDocuments({});
  console.log(`\nGrand Total Orders: ${total}`);

  await mongoose.disconnect();
}

countOrders().catch(console.error);
