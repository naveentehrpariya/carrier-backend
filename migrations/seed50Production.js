require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const Company = require('../db/Company');
const Customer = require('../db/Customer');
const User = require('../db/Users');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

console.log('=== PRODUCTION DATABASE SEED SCRIPT ===');
console.log('Using MongoDB URI:', MONGODB_URI);

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
  { city: 'Chandigarh', state: 'Punjab', distance: 250 },
  { city: 'Surat', state: 'Gujarat', distance: 1200 },
  { city: 'Kochi', state: 'Kerala', distance: 2600 },
  { city: 'Indore', state: 'Madhya Pradesh', distance: 780 },
  { city: 'Nagpur', state: 'Maharashtra', distance: 800 },
];

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');

    const tenantId = 'cross-miles-carrier-inc';
    console.log('Using tenant:', tenantId);

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
        email: 'testcustomer@example.com',
        phone: '+91 9876543000',
        address: '123 Business Park',
        city: 'Delhi',
        state: 'Delhi',
        country: 'India',
        zipcode: '110001'
      });
      customer = customer.toObject ? customer.toObject() : customer;
    }

    const ownerOperators = await OwnerOperator.find({ tenantId }).limit(12).lean();
    const ownerOperatorIds = ownerOperators.map(oo => oo._id);
    const trucks = await Truck.find({ tenantId, ownerOperator: { $in: ownerOperatorIds } }).limit(30).lean();

    let drivers = await User.find({
      tenantId,
      role: 0,
      $or: [{ permissions: 'driver' }, { is_driver: true }]
    }).limit(20).lean();

    const adminUser = await User.findOne({ tenantId, is_admin: 1 }).lean();
    if (!adminUser) {
      console.log('No admin user found');
      process.exit(1);
    }

    const lastOrder = await Order.findOne({ tenantId }).sort({ serial_no: -1 }).lean();
    let serialBase = (lastOrder?.serial_no || 1000) + 1;

    console.log(`\nCreating 50 orders starting from ${serialBase}...`);
    const ordersCreated = [];

    for (let i = 0; i < 50; i++) {
      const orderNum = serialBase + i;
      const isOwnerTruck = trucks.length > 0 && Math.random() > 0.2;
      const ownerTruck = isOwnerTruck ? trucks[Math.floor(Math.random() * trucks.length)] : null;
      
      const scenario = Math.random();
      let driverAssignmentMode = 'company_driver';
      let assignedDrivers = [];
      let driverAssignmentStatus = 'company_driver_unassigned';

      if (ownerTruck) {
        if (scenario < 0.4) {
          driverAssignmentMode = 'owner_driver';
          driverAssignmentStatus = 'owner_operator_driver';
        } else if (scenario < 0.7 && drivers.length > 0) {
          const numDrivers = Math.random() > 0.5 && drivers.length > 1 ? 2 : 1;
          assignedDrivers = drivers.slice(0, numDrivers).map(d => d._id);
          driverAssignmentStatus = 'company_driver_assigned';
        }
      } else if (drivers.length > 0 && Math.random() > 0.3) {
        const numDrivers = Math.random() > 0.6 && drivers.length > 1 ? 2 : 1;
        assignedDrivers = drivers.slice(0, numDrivers).map(d => d._id);
        driverAssignmentStatus = 'company_driver_assigned';
      }

      const startLoc = indianLocations[Math.floor(Math.random() * indianLocations.length)];
      let endLoc;
      do {
        endLoc = indianLocations[Math.floor(Math.random() * indianLocations.length)];
      } while (endLoc.city === startLoc.city);

      const distanceKm = Math.abs(endLoc.distance - startLoc.distance);
      const distanceMiles = Math.round(distanceKm * 0.621371);

      const totalAmount = Math.round((1500 + Math.random() * 3500) * 100) / 100;
      const settleAmount = ownerTruck ? Math.round((totalAmount * (0.7 + Math.random() * 0.2)) * 100) / 100 : 0;
      const ownerProfit = totalAmount - settleAmount;

      const statusOptions = ['added', 'intransit', 'delivered', 'completed'];
      const statusWeights = [0.1, 0.2, 0.4, 0.3];
      let statusRand = Math.random();
      let orderStatus = statusOptions[0];
      for (let s = 0; s < statusWeights.length; s++) {
        if (statusRand < statusWeights[s]) {
          orderStatus = statusOptions[s];
          break;
        }
        statusRand -= statusWeights[s];
      }

      const daysAgo = Math.floor(Math.random() * 90);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysAgo);

      const order = await Order.create({
        company_name: company.name,
        serial_no: orderNum,
        customer_order_no: `CUST-${orderNum}`,
        tenantId,
        company: company._id,
        customer: customer._id,
        order_type: 'regular',
        order_status: orderStatus,
        isOwnerOperatedTruck: !!ownerTruck,
        ownerOperator: ownerTruck ? ownerTruck.ownerOperator : null,
        truck: ownerTruck ? ownerTruck._id : null,
        driver_assignment_mode: driverAssignmentMode,
        driver_assignment_status: driverAssignmentStatus,
        drivers: assignedDrivers,
        driver: assignedDrivers.length > 0 ? assignedDrivers[0] : null,
        total_amount: totalAmount,
        settle_amount: settleAmount,
        owner_profit: ownerProfit,
        totalDistanceInKM: distanceKm,
        totalDistance: distanceMiles,
        customer_payment_status: Math.random() > 0.5 ? 'completed' : 'pending',
        carrier_payment_status: Math.random() > 0.5 ? 'completed' : 'pending',
        shipping_details: [
          {
            stop_type: 'pickup',
            address: `${Math.floor(Math.random() * 999) + 1}, Industrial Area`,
            city: startLoc.city,
            state: startLoc.state,
            country: 'India',
            date: startDate
          },
          {
            stop_type: 'delivery',
            address: `${Math.floor(Math.random() * 999) + 1}, Logistics Hub`,
            city: endLoc.city,
            state: endLoc.state,
            country: 'India',
            date: new Date(startDate.getTime() + (distanceKm / 50) * 24 * 60 * 60 * 1000)
          }
        ],
        createdAt: startDate,
        created_by: adminUser._id
      });

      ordersCreated.push(order);

      if (assignedDrivers.length > 1 || orderStatus === 'delivered' || orderStatus === 'completed') {
        const numTrips = assignedDrivers.length > 1 ? assignedDrivers.length : (Math.random() > 0.5 ? 2 : 1);
        
        for (let t = 0; t < numTrips; t++) {
          const tripDrivers = assignedDrivers.length > t ? [assignedDrivers[t]] : [];
          
          await Trip.create({
            tenantId,
            order: order._id,
            trip_no: t + 1,
            start_stop_index: 0,
            end_stop_index: 1,
            driver: tripDrivers[0] || null,
            drivers: tripDrivers,
            truck: ownerTruck ? ownerTruck._id : null,
            start_location: `${startLoc.city}, ${startLoc.state}`,
            end_location: `${endLoc.city}, ${endLoc.state}`,
            miles: Math.round(distanceKm / numTrips * 0.621371),
            totalDistance: Math.round(distanceKm / numTrips * 0.621371),
            total_km: Math.round(distanceKm / numTrips),
            distance_unit: 'mi',
            rate_per_mile: 1.5 + Math.random(),
            total_driver_pay: Math.round(distanceKm / numTrips * 0.621371 * (1.5 + Math.random()) * 100) / 100,
            status: orderStatus === 'completed' ? 'delivered' : (orderStatus === 'delivered' ? 'delivered' : 'en-route'),
            createdAt: new Date(startDate.getTime() + t * 24 * 60 * 60 * 1000)
          });
        }
      }

      if ((i + 1) % 10 === 0) {
        console.log(`Created ${i + 1} orders...`);
      }
    }

    console.log(`\n✓ Successfully created ${ordersCreated.length} orders in PRODUCTION database!`);
    console.log(`  - With owner operated trucks: ${ordersCreated.filter(o => o.isOwnerOperatedTruck).length}`);
    console.log(`  - With multiple drivers: ${ordersCreated.filter(o => o.drivers?.length > 1).length}`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

seed();
