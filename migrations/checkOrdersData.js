require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const OwnerOperator = require('../db/OwnerOperator');
const Truck = require('../db/Truck');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function checkData() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB\n');

    const tenantId = 'cross-miles-carrier-inc';

    console.log('=== Checking Orders ===');
    const orders = await Order.find({ tenantId }).lean();
    console.log(`Total Orders: ${orders.length}`);
    
    if (orders.length > 0) {
      console.log('\nSample Order (first one):');
      console.log({
        serial_no: orders[0].serial_no,
        customer_order_no: orders[0].customer_order_no,
        order_type: orders[0].order_type,
        order_status: orders[0].order_status,
        company_name: orders[0].company_name,
        tenantId: orders[0].tenantId,
        isOwnerOperatedTruck: orders[0].isOwnerOperatedTruck,
        total_amount: orders[0].total_amount,
        settle_amount: orders[0].settle_amount,
        driver_assignment_mode: orders[0].driver_assignment_mode,
        driver_assignment_status: orders[0].driver_assignment_status
      });
    }

    console.log('\n=== Checking Owner Operators ===');
    const ownerOps = await OwnerOperator.find({ tenantId }).lean();
    console.log(`Total Owner Operators: ${ownerOps.length}`);

    console.log('\n=== Checking Trucks ===');
    const trucks = await Truck.find({ tenantId, ownerOperated: true }).lean();
    console.log(`Total Owner Operated Trucks: ${trucks.length}`);

    console.log('\n=== Checking Trips ===');
    const trips = await Trip.find({ tenantId }).lean();
    console.log(`Total Trips: ${trips.length}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

checkData();
