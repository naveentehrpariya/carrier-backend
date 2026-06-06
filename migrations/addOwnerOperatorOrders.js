require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const OwnerOperator = require('../db/OwnerOperator');
const Company = require('../db/Company');
const Customer = require('../db/Customer');
const User = require('../db/Users');

const MONGODB_URI = "mongodb+srv://naveenfp:naveenfp@cluster0.5c8ne.mongodb.net/carrier";

console.log('=== ADD OWNER OPERATOR ORDERS (Payment Done) ===');
console.log('MongoDB:', MONGODB_URI);

const indianLocations = [
  { city: 'Delhi', state: 'Delhi', distance: 0 },
  { city: 'Mumbai', state: 'Maharashtra', distance: 1155 },
  { city: 'Bangalore', state: 'Karnataka', distance: 2150 },
  { city: 'Chennai', state: 'Tamil Nadu', distance: 2180 },
  { city: 'Kolkata', state: 'West Bengal', distance: 1490 },
  { city: 'Jaipur', state: 'Rajasthan', distance: 280 },
  { city: 'Ahmedabad', state: 'Gujarat', distance: 910 },
  { city: 'Pune', state: 'Maharashtra', distance: 1180 },
  { city: 'Lucknow', state: 'Uttar Pradesh', distance: 500 },
  { city: 'Hyderabad', state: 'Telangana', distance: 1250 },
];

async function seedOwnerOperatorOrders() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';

  const company = await Company.findOne({ tenantId }).lean();
  if (!company) {
    console.log('Company not found');
    process.exit(1);
  }
  console.log('Company:', company.name);

  let customer = await Customer.findOne({ tenantId }).lean();
  if (!customer) {
    customer = await Customer.create({
      tenantId,
      company: company._id,
      name: 'Test Customer Corp',
      email: 'test@example.com',
      phone: '+91 9876543000',
      city: 'Delhi',
      state: 'Delhi'
    });
    customer = customer.toObject ? customer.toObject() : customer;
  }

  // Get owner operators with trucks
  const ownerOperators = await OwnerOperator.find({ tenantId }).limit(12).lean();
  console.log('Owner Operators:', ownerOperators.length);

  const ownerOperatorIds = ownerOperators.map(oo => oo._id);
  const trucks = await Truck.find({ tenantId, ownerOperator: { $in: ownerOperatorIds } }).limit(30).lean();
  console.log('Owner Operated Trucks:', trucks.length);

  if (trucks.length === 0) {
    console.log('\n⚠️  No owner operated trucks found! Creating them first...');
    
    for (let i = 0; i < ownerOperators.length; i++) {
      const oo = ownerOperators[i];
      await Truck.create({
        tenantId,
        company: company._id,
        ownerOperator: oo._id,
        ownerOperated: true,
        make: ['Tata', 'Ashok Leyland', 'Mahindra'][i % 3],
        model: ['Ultra', 'Dost', 'Bolero'][i % 3],
        year: 2022 + (i % 2),
        plateNumber: `DL-${i + 1}-AB-${1000 + i}`,
        unitNumber: `OO-${1000 + i}`,
        type: 'Truck',
        status: 'active',
        availability: 'available'
      });
    }
    
    const trucks = await Truck.find({ tenantId, ownerOperator: { $in: ownerOperatorIds } }).limit(30).lean();
    console.log('Created trucks:', trucks.length);
  }

  // Get admin and staff users
  const users = await User.find({ tenantId, is_admin: { $in: [0, 1] } }).limit(20).lean();
  console.log('Available users:', users.length);

  if (users.length === 0) {
    console.log('No users found');
    process.exit(1);
  }

  const lastOrder = await Order.findOne({ tenantId }).sort({ serial_no: -1 }).lean();
  let serialBase = (lastOrder?.serial_no || 1000) + 1;

  console.log(`\nCreating 50 orders with owner operated trucks...`);
  console.log(`Starting from serial_no: ${serialBase}`);

  // Generate dates for last 3 months (April, May, June 2026)
  const recentDates = [];
  for (let month = 3; month >= 1; month--) {
    const monthName = ['', 'April', 'May', 'June'][month];
    const daysInMonth = month === 3 ? 30 : (month === 2 ? 31 : 30);
    for (let day = 1; day <= daysInMonth; day += 2) {
      const date = new Date(2026, month, day, Math.floor(Math.random() * 10) + 8, Math.floor(Math.random() * 60), 0);
      recentDates.push(date);
    }
  }

  const ordersCreated = [];

  for (let i = 0; i < 50; i++) {
    const orderNum = serialBase + i;
    
    // Always use owner operated truck
    const ownerTruck = trucks[Math.floor(Math.random() * trucks.length)];
    const ownerOp = ownerOperators.find(oo => oo._id.toString() === ownerTruck?.ownerOperator?.toString());
    
    // Randomly assign driver (owner driver or company driver)
    const scenario = Math.random();
    let driverAssignmentMode = 'owner_driver';
    let driverAssignmentStatus = 'owner_operator_driver';
    let assignedDrivers = [];

    if (scenario > 0.7 && users.length > 5) {
      // 30% chance: Company driver assigned
      driverAssignmentMode = 'company_driver';
      driverAssignmentStatus = 'company_driver_assigned';
      const driverIndex = Math.floor(Math.random() * 5); // First 5 users as drivers
      assignedDrivers = [users[driverIndex]._id];
    }

    const startLoc = indianLocations[Math.floor(Math.random() * indianLocations.length)];
    let endLoc;
    do {
      endLoc = indianLocations[Math.floor(Math.random() * indianLocations.length)];
    } while (endLoc.city === startLoc.city);

    const distanceKm = Math.abs(endLoc.distance - startLoc.distance);
    const distanceMiles = Math.round(distanceKm * 0.621371);

    const totalAmount = Math.round((2000 + Math.random() * 5000) * 100) / 100;
    const settleAmount = Math.round((totalAmount * (0.70 + Math.random() * 0.15)) * 100) / 100;
    const ownerProfit = totalAmount - settleAmount;

    // Random status (more completed orders)
    const statusOptions = ['added', 'intransit', 'delivered', 'completed'];
    const statusWeights = [0.1, 0.2, 0.3, 0.4];
    let statusRand = Math.random();
    let orderStatus = statusOptions[0];
    for (let s = 0; s < statusWeights.length; s++) {
      if (statusRand < statusWeights[s]) {
        orderStatus = statusOptions[s];
        break;
      }
      statusRand -= statusWeights[s];
    }

    // Random created_by (admin or staff)
    const createdBy = users[Math.floor(Math.random() * users.length)];

    const createdAt = recentDates[i] || new Date();

    const order = await Order.create({
      company_name: company.name,
      serial_no: orderNum,
      customer_order_no: `CUST-${orderNum}`,
      tenantId,
      company: company._id,
      customer: customer._id,
      order_type: 'regular',
      order_status: orderStatus,
      isOwnerOperatedTruck: true,
      ownerOperator: ownerTruck?.ownerOperator || null,
      truck: ownerTruck?._id || null,
      driver_assignment_mode: driverAssignmentMode,
      driver_assignment_status: driverAssignmentStatus,
      drivers: assignedDrivers,
      driver: assignedDrivers.length > 0 ? assignedDrivers[0] : null,
      total_amount: totalAmount,
      settle_amount: settleAmount,
      owner_profit: ownerProfit,
      totalDistanceInKM: distanceKm,
      totalDistance: distanceMiles,
      customer_payment_status: 'completed',
      carrier_payment_status: 'completed',
      carrier_final_payment_status: 'completed',
      customer_final_payment_status: 'completed',
      shipping_details: [
        {
          stop_type: 'pickup',
          address: `${Math.floor(Math.random() * 999) + 1}, Industrial Area`,
          city: startLoc.city,
          state: startLoc.state,
          country: 'India',
          date: createdAt
        },
        {
          stop_type: 'delivery',
          address: `${Math.floor(Math.random() * 999) + 1}, Logistics Hub`,
          city: endLoc.city,
          state: endLoc.state,
          country: 'India',
          date: new Date(createdAt.getTime() + 2 * 24 * 60 * 60 * 1000)
        }
      ],
      createdAt: createdAt,
      created_by: createdBy._id
    });

    ordersCreated.push(order);

    // Create trips for completed orders
    if (orderStatus === 'delivered' || orderStatus === 'completed') {
      const numTrips = assignedDrivers.length > 0 ? assignedDrivers.length : 1;
      
      for (let t = 0; t < numTrips; t++) {
        await Trip.create({
          tenantId,
          order: order._id,
          trip_no: t + 1,
          start_stop_index: 0,
          end_stop_index: 1,
          driver: assignedDrivers[t] || null,
          drivers: [assignedDrivers[t] || null],
          truck: ownerTruck?._id || null,
          start_location: `${startLoc.city}, ${startLoc.state}`,
          end_location: `${endLoc.city}, ${endLoc.state}`,
          miles: distanceMiles,
          totalDistance: distanceMiles,
          total_km: distanceKm,
          distance_unit: 'mi',
          rate_per_mile: 1.5 + Math.random(),
          total_driver_pay: Math.round(distanceMiles * (1.5 + Math.random()) * 100) / 100,
          status: 'delivered',
          createdAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000)
        });
      }
    }

    if ((i + 1) % 10 === 0) {
      console.log(`Created ${i + 1} orders...`);
    }
  }

  console.log(`\n✓ Successfully created ${ordersCreated.length} orders!`);
  console.log(`Serial numbers: ${serialBase} to ${serialBase + 49}`);
  console.log(`\nOrder Summary:`);
  console.log(`  - Owner operated trucks: ${ordersCreated.filter(o => o.isOwnerOperatedTruck).length}`);
  console.log(`  - Owner driver mode: ${ordersCreated.filter(o => o.driver_assignment_mode === 'owner_driver').length}`);
  console.log(`  - Company driver mode: ${ordersCreated.filter(o => o.driver_assignment_mode === 'company_driver').length}`);
  console.log(`  - Completed orders: ${ordersCreated.filter(o => o.order_status === 'completed').length}`);
  console.log(`  - Delivered orders: ${ordersCreated.filter(o => o.order_status === 'delivered').length}`);
  console.log(`  - Payment: ALL COMPLETED`);

  await mongoose.disconnect();
  console.log('\n✓ Owner operator orders with payment done added!');
}

seedOwnerOperatorOrders().catch(console.error);
