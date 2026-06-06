require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const Company = require('../db/Company');
const Customer = require('../db/Customer');
const User = require('../db/Users');

const MONGODB_URI = "mongodb+srv://naveenfp:naveenfp@cluster0.5c8ne.mongodb.net/carrier";

console.log('=== ADD MORE SPECIFIC ORDERS IN MAY 2026 ===');

const indianLocations = [
  { city: 'Delhi', state: 'Delhi', distance: 0 },
  { city: 'Mumbai', state: 'Maharashtra', distance: 1155 },
  { city: 'Bangalore', state: 'Karnataka', distance: 2150 },
  { city: 'Chennai', state: 'Tamil Nadu', distance: 2180 },
  { city: 'Kolkata', state: 'West Bengal', distance: 1490 }
];

async function seedMayOrders() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  // 1. Get Company & Admin
  const company = await Company.findOne({ tenantId }).lean();
  const adminUser = await User.findOne({ tenantId, is_admin: 1 }).lean();
  
  // 2. Find specific entities
  let customer = await Customer.findOne({ tenantId, name: /Abhilkshay/i }).lean();
  let driver = await User.findOne({ tenantId, name: /Ramu/i }).lean();
  let truck = await Truck.findOne({ tenantId, make: /Truck 555/i }).lean();
  
  let trailer = null;
  try {
    trailer = await mongoose.model('trailers').findOne({ tenantId, plateNumber: /TR-12/i }).lean();
  } catch (e) {
    try {
      trailer = await mongoose.model('Trailer').findOne({ tenantId, plateNumber: /TR-12/i }).lean();
    } catch(err) {}
  }

  if (!customer || !truck) {
    console.log('Critical missing data. Exiting.');
    process.exit(1);
  }

  const lastOrder = await Order.findOne({ tenantId }).sort({ serial_no: -1 }).lean();
  let serialBase = (lastOrder?.serial_no || 1000) + 1;

  console.log(`\nCreating 50 specific orders for MAY 2026 starting from serial_no: ${serialBase}...`);
  const ordersCreated = [];

  for (let i = 0; i < 50; i++) {
    const orderNum = serialBase + i;
    
    // 50% chance to assign Ramu, 50% chance unassigned
    const isAssigned = Math.random() > 0.5;
    
    let driverAssignmentMode = 'company_driver';
    let driverAssignmentStatus = isAssigned ? 'company_driver_assigned' : 'company_driver_unassigned';
    let assignedDrivers = isAssigned && driver ? [driver._id] : [];
    let primaryDriver = isAssigned && driver ? driver._id : null;

    if (truck.ownerOperated) {
       driverAssignmentMode = 'owner_driver';
       driverAssignmentStatus = isAssigned ? 'owner_operator_driver' : 'company_driver_unassigned';
    }

    const startLoc = indianLocations[Math.floor(Math.random() * indianLocations.length)];
    let endLoc;
    do {
      endLoc = indianLocations[Math.floor(Math.random() * indianLocations.length)];
    } while (endLoc.city === startLoc.city);

    const distanceKm = Math.abs(endLoc.distance - startLoc.distance);
    const distanceMiles = Math.round(distanceKm * 0.621371) || 100;

    const totalAmount = Math.round((2000 + Math.random() * 3000) * 100) / 100;
    const settleAmount = Math.round((totalAmount * 0.8) * 100) / 100;

    // Random Date in May 2026
    const randomDay = Math.floor(Math.random() * 31) + 1;
    const randomHour = Math.floor(Math.random() * 12) + 8; // 8 AM to 8 PM
    const randomMinute = Math.floor(Math.random() * 60);
    // Month is 0-indexed, so 4 = May
    const createdAt = new Date(Date.UTC(2026, 4, randomDay, randomHour, randomMinute, 0));

    const order = await Order.create({
      company_name: company.name,
      serial_no: orderNum,
      customer_order_no: `CUST-${orderNum}`,
      tenantId,
      company: company._id,
      customer: customer._id,
      order_type: 'regular',
      order_status: isAssigned ? 'intransit' : 'added',
      isOwnerOperatedTruck: !!truck.ownerOperated,
      ownerOperator: truck.ownerOperator || null,
      truck: truck._id,
      trailer: trailer ? trailer._id : null,
      driver_assignment_mode: driverAssignmentMode,
      driver_assignment_status: driverAssignmentStatus,
      drivers: assignedDrivers,
      driver: primaryDriver,
      total_amount: totalAmount,
      settle_amount: settleAmount,
      owner_profit: totalAmount - settleAmount,
      totalDistanceInKM: distanceKm,
      totalDistance: distanceMiles,
      
      // Payment Statuses = Completed
      customer_payment_status: 'completed',
      carrier_payment_status: 'completed',
      carrier_final_payment_status: 'completed',
      customer_final_payment_status: 'completed',
      
      shipping_details: [
        {
          stop_type: 'pickup',
          address: `Pickup Hub, ${startLoc.city}`,
          city: startLoc.city,
          state: startLoc.state,
          country: 'India',
          date: createdAt
        },
        {
          stop_type: 'delivery',
          address: `Delivery Point, ${endLoc.city}`,
          city: endLoc.city,
          state: endLoc.state,
          country: 'India',
          date: new Date(createdAt.getTime() + 2 * 24 * 60 * 60 * 1000)
        }
      ],
      createdAt: createdAt,
      created_by: adminUser._id
    });

    ordersCreated.push(order);

    if (isAssigned) {
      await Trip.create({
        tenantId,
        order: order._id,
        trip_no: 1,
        start_stop_index: 0,
        end_stop_index: 1,
        driver: primaryDriver,
        drivers: assignedDrivers,
        truck: truck._id,
        trailer: trailer ? trailer._id : null,
        start_location: startLoc.city,
        end_location: endLoc.city,
        miles: distanceMiles,
        totalDistance: distanceMiles,
        total_km: distanceKm,
        distance_unit: 'mi',
        rate_per_mile: 2.0,
        total_driver_pay: Math.round(distanceMiles * 2.0 * 100) / 100,
        status: 'en-route',
        createdAt: createdAt
      });
    }
  }

  console.log(`\n✓ Successfully created ${ordersCreated.length} more orders for MAY 2026!`);
  console.log(`  - Assigned to Driver Ramu: ${ordersCreated.filter(o => o.drivers?.length > 0).length}`);
  console.log(`  - Unassigned Drivers: ${ordersCreated.filter(o => !o.drivers || o.drivers.length === 0).length}`);
  console.log(`  - Truck Used: ${truck.make} ${truck.model}`);

  await mongoose.disconnect();
}

seedMayOrders().catch(console.error);
