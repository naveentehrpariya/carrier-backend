require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const Trailer = require('../db/Trailer'); // Assuming Trailer model exists
const Company = require('../db/Company');
const Customer = require('../db/Customer');
const User = require('../db/Users');

const MONGODB_URI = "mongodb+srv://naveenfp:naveenfp@cluster0.5c8ne.mongodb.net/carrier";

console.log('=== ADD SPECIFIC ORDERS ===');
console.log('MongoDB:', MONGODB_URI);

const indianLocations = [
  { city: 'Delhi', state: 'Delhi', distance: 0 },
  { city: 'Mumbai', state: 'Maharashtra', distance: 1155 },
  { city: 'Bangalore', state: 'Karnataka', distance: 2150 },
  { city: 'Chennai', state: 'Tamil Nadu', distance: 2180 },
  { city: 'Kolkata', state: 'West Bengal', distance: 1490 }
];

async function seedSpecificOrders() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  // 1. Get Company
  const company = await Company.findOne({ tenantId }).lean();
  if (!company) {
    console.log('Company not found');
    process.exit(1);
  }

  // 2. Get Admin User
  const adminUser = await User.findOne({ tenantId, is_admin: 1 }).lean();
  
  // 3. Find Customer "Abhilkshay"
  let customer = await Customer.findOne({ tenantId, email: 'abhi@internetbusinesssolutionsindia.com' }).lean();
  if (!customer) {
    console.log('Customer Abhilkshay not found! Looking by name...');
    customer = await Customer.findOne({ tenantId, name: /Abhilkshay/i }).lean();
  }
  console.log('Customer:', customer ? customer.name : 'NOT FOUND');

  // 4. Find Driver "Ramu"
  let driver = await User.findOne({ tenantId, email: 'ramu@internetbusinesssolutionsindia.com' }).lean();
  if (!driver) {
    console.log('Driver Ramu not found! Looking by name...');
    driver = await User.findOne({ tenantId, name: /Ramu/i }).lean();
  }
  console.log('Driver:', driver ? driver.name : 'NOT FOUND');

  // 5. Find Truck "Truck 555"
  let truck = await Truck.findOne({ tenantId, make: /Truck 555/i }).lean();
  if (!truck) {
    console.log('Truck 555 not found! Looking by model VZI3...');
    truck = await Truck.findOne({ tenantId, model: /VZI3/i }).lean();
  }
  console.log('Truck:', truck ? `${truck.make} ${truck.model}` : 'NOT FOUND');

  // 6. Find Trailer "TR-12"
  let trailer = null;
  try {
    trailer = await mongoose.model('trailers').findOne({ tenantId, plateNumber: /TR-12/i }).lean();
  } catch (e) {
    try {
      trailer = await mongoose.model('Trailer').findOne({ tenantId, plateNumber: /TR-12/i }).lean();
    } catch(err) {
      console.log('Could not find Trailer model');
    }
  }
  console.log('Trailer:', trailer ? trailer.plateNumber : 'NOT FOUND (Will proceed without if needed)');

  if (!customer || !truck) {
    console.log('Critical missing data. Exiting.');
    process.exit(1);
  }

  const lastOrder = await Order.findOne({ tenantId }).sort({ serial_no: -1 }).lean();
  let serialBase = (lastOrder?.serial_no || 1000) + 1;

  console.log(`\nCreating 50 specific orders starting from serial_no: ${serialBase}...`);
  const ordersCreated = [];

  for (let i = 0; i < 50; i++) {
    const orderNum = serialBase + i;
    
    // 50% chance to assign Ramu, 50% chance unassigned
    const isAssigned = Math.random() > 0.5;
    
    let driverAssignmentMode = 'company_driver';
    let driverAssignmentStatus = isAssigned ? 'company_driver_assigned' : 'company_driver_unassigned';
    let assignedDrivers = isAssigned && driver ? [driver._id] : [];
    let primaryDriver = isAssigned && driver ? driver._id : null;

    // If truck is owner operated
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

    const order = await Order.create({
      company_name: company.name,
      serial_no: orderNum,
      customer_order_no: `CUST-${orderNum}`,
      tenantId,
      company: company._id,
      customer: customer._id,
      order_type: 'regular',
      order_status: isAssigned ? 'intransit' : 'added', // Intransit if driver assigned
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
          date: new Date()
        },
        {
          stop_type: 'delivery',
          address: `Delivery Point, ${endLoc.city}`,
          city: endLoc.city,
          state: endLoc.state,
          country: 'India',
          date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
        }
      ],
      createdAt: new Date(),
      created_by: adminUser._id
    });

    ordersCreated.push(order);

    // Create Trip if assigned
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
        createdAt: new Date()
      });
    }
  }

  console.log(`\n✓ Successfully created ${ordersCreated.length} specific orders!`);
  console.log(`  - Assigned to Driver Ramu: ${ordersCreated.filter(o => o.drivers?.length > 0).length}`);
  console.log(`  - Unassigned Drivers: ${ordersCreated.filter(o => !o.drivers || o.drivers.length === 0).length}`);
  console.log(`  - Truck Used: ${truck.make} ${truck.model}`);
  console.log(`  - Trailer Used: ${trailer ? trailer.plateNumber : 'None'}`);
  console.log(`  - Payment Status: ALL COMPLETED`);

  await mongoose.disconnect();
}

seedSpecificOrders().catch(console.error);
