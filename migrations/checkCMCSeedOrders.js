require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = "mongodb+srv://cmc:BoYb7a9nu6telXYD@cluster0.8l1eszr.mongodb.net/carrier";

async function checkCMCSeedOrders() {
  console.log('=== CMC DATABASE - SEED ORDERS CHECK ===');
  console.log('Using MongoDB URI:', MONGODB_URI);

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  // Find orders with serial_no 1120-1169 (string or number)
  const seedOrders = await Order.find({ 
    tenantId,
    serial_no: { $in: ['1120', '1121', '1122', '1123', '1124', '1125', '1126', '1127', '1128', '1129', '1130'] }
  }).lean();

  console.log(`\nFound ${seedOrders.length} potential seed orders (serial_no 1120-1130):`);

  seedOrders.forEach(o => {
    console.log(`  #${o.serial_no} - ${o.createdAt.toISOString()}`);
    console.log(`    isOwnerOperatedTruck: ${o.isOwnerOperatedTruck}`);
    console.log(`    driver_assignment_mode: ${o.driver_assignment_mode}`);
    console.log(`    owner_profit: ${o.owner_profit}`);
  });

  // Also check for Indian cities in shipping details
  const indianCities = ['Delhi', 'Mumbai', 'Bangalore', 'Chennai', 'Kolkata', 'Jaipur', 'Ahmedabad', 'Pune', 'Lucknow', 'Hyderabad'];
  
  const allOrders = await Order.find({ tenantId }).lean();
  console.log(`\n=== Checking for Indian city orders ===`);
  
  const indianOrders = allOrders.filter(o => {
    if (o.shipping_details && o.shipping_details.length > 0) {
      const locations = JSON.stringify(o.shipping_details);
      return indianCities.some(city => locations.includes(city));
    }
    return false;
  });

  console.log(`Found ${indianOrders.length} orders with Indian cities`);
  if (indianOrders.length > 0) {
    console.log(`Sample order: #${indianOrders[0].serial_no}`);
  }

  await mongoose.disconnect();
  console.log('\n✓ Check complete!');
}

checkCMCSeedOrders().catch(console.error);
