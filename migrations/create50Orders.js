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

// Indian locations with distances (in KM)
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

    // Get company
    const company = await Company.findOne({ name: 'Cross Miles Carrier Inc' }).lean();
    if (!company) {
      console.log('Company not found');
      process.exit(1);
    }
    const tenantId = company.tenantId || company._id.toString();
    console.log('Using company:', company.name);

    // Get or create customer
    let customer = await Customer.findOne({ tenantId }).lean();
    if (!customer) {
      customer = await Customer.create({
        tenantId,
        company: company._id,
        name: 'Test Customer Corp',
        email: 'testcustomer@example.com',
        phone: '+91 9876543000',
        address: '123 Business Park, Sector 62',
        city: 'Delhi',
        state: 'Delhi',
        country: 'India',
        zipcode: '110001'
      });
      customer = customer.toObject ? customer.toObject() : customer;
      console.log('Created customer');
    }

    // Get owner operators
    const ownerOperators = await OwnerOperator.find({ tenantId }).limit(12).lean();
    console.log('Found', ownerOperators.length, 'owner operators');

    // Get their trucks
    const ownerOperatorIds = ownerOperators.map(oo => oo._id);
    const trucks = await Truck.find({
      tenantId,
      ownerOperator: { $in: ownerOperatorIds }
    }).limit(30).lean();
    console.log('Found', trucks.length, 'owner operated trucks');

    // Get or create drivers
    let drivers = await User.find({
      tenantId,
      role: 0,
      $or: [
        { permissions: 'driver' },
        { is_driver: true }
      ]
    }).limit(20).lean();

    if (drivers.length < 5) {
      // Create driver profiles
      const driverEmails = ['driver1@test.com', 'driver2@test.com', 'driver3@test.com', 'driver4@test.com', 'driver5@test.com'];
      for (let i = 0; i < driverEmails.length; i++) {
        const existingDriver = await User.findOne({ email: driverEmails[i], tenantId });
        if (!existingDriver) {
          const driver = await User.create({
            tenantId,
            company: company._id,
            name: `Test Driver ${i + 1}`,
            email: driverEmails[i],
            password: 'password123',
            role: 0,
            permissions: ['driver'],
            is_driver: true,
            corporateID: `DRV${1000 + i}`
          });
          drivers.push(driver.toObject ? driver.toObject() : driver);
        } else {
          drivers.push(existingDriver.toObject ? existingDriver.toObject() : existingDriver);
        }
      }
    }
    console.log('Using', drivers.length, 'drivers');

    // Get admin user for created_by field
    const adminUser = await User.findOne({ tenantId, is_admin: 1 }).lean();
    if (!adminUser) {
      console.log('No admin user found');
      process.exit(1);
    }
    console.log('Using admin user:', adminUser.name);

    // Get max serial number
    const lastOrder = await Order.findOne({ tenantId }).sort({ serial_no: -1 }).lean();
    let serialBase = (lastOrder?.serial_no || 1000) + 1;

    // Create 50 orders
    console.log('\nCreating 50 orders...');
    const ordersCreated = [];

    for (let i = 0; i < 50; i++) {
      const orderNum = serialBase + i;
      const isOwnerTruck = trucks.length > 0 && Math.random() > 0.2;
      const ownerTruck = isOwnerTruck ? trucks[Math.floor(Math.random() * trucks.length)] : null;
      const ownerOp = ownerTruck ? ownerOperators.find(oo => oo._id.toString() === ownerTruck.ownerOperator?.toString()) : null;
      
      // Determine driver scenario
      const scenario = Math.random();
      let driverAssignmentMode = 'company_driver';
      let assignedDrivers = [];
      let driverAssignmentStatus = 'company_driver_unassigned';

      if (ownerTruck && ownerOp) {
        if (scenario < 0.4) {
          // Owner driver - no company driver
          driverAssignmentMode = 'owner_driver';
          driverAssignmentStatus = 'owner_operator_driver';
        } else if (scenario < 0.7 && drivers.length > 0) {
          // Company driver assigned
          const numDrivers = Math.random() > 0.5 && drivers.length > 1 ? 2 : 1;
          assignedDrivers = drivers.slice(0, numDrivers).map(d => d._id);
          driverAssignmentStatus = 'company_driver_assigned';
        }
      } else if (drivers.length > 0 && Math.random() > 0.3) {
        // Regular truck with company driver
        const numDrivers = Math.random() > 0.6 && drivers.length > 1 ? 2 : 1;
        assignedDrivers = drivers.slice(0, numDrivers).map(d => d._id);
        driverAssignmentStatus = 'company_driver_assigned';
      }

      // Generate locations
      const startLoc = indianLocations[Math.floor(Math.random() * indianLocations.length)];
      let endLoc;
      do {
        endLoc = indianLocations[Math.floor(Math.random() * indianLocations.length)];
      } while (endLoc.city === startLoc.city);

      const distanceKm = Math.abs(endLoc.distance - startLoc.distance);
      const distanceMiles = Math.round(distanceKm * 0.621371);

      // Amounts
      const totalAmount = Math.round((1500 + Math.random() * 3500) * 100) / 100;
      const settleAmount = ownerTruck ? Math.round((totalAmount * (0.7 + Math.random() * 0.2)) * 100) / 100 : 0;
      const ownerProfit = settleAmount > 0 ? totalAmount - settleAmount : 0;

      // Order status
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

      // Dates
      const daysAgo = Math.floor(Math.random() * 90);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysAgo);

      const orderData = {
        company_name: company.name || 'Cross Miles Carrier Inc',
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
      };

      const order = await Order.create(orderData);
      ordersCreated.push(order);
      console.log(`Created order ${orderNum} (${orderStatus}) - Owner: ${ownerTruck ? 'Yes' : 'No'}, Drivers: ${assignedDrivers.length}`);

      // Create trips for some orders (especially those with multiple drivers or completed)
      if (assignedDrivers.length > 1 || orderStatus === 'delivered' || orderStatus === 'completed') {
        const numTrips = assignedDrivers.length > 1 ? assignedDrivers.length : (Math.random() > 0.5 ? 2 : 1);
        
        for (let t = 0; t < numTrips; t++) {
          const tripDrivers = assignedDrivers.length > t ? [assignedDrivers[t]] : [];
          const tripDriver = tripDrivers.length > 0 ? tripDrivers[0] : null;
          
          const tripDistanceKm = Math.round(distanceKm / numTrips);
          const tripMiles = Math.round(tripDistanceKm * 0.621371);

          await Trip.create({
            tenantId,
            order: order._id,
            trip_no: t + 1,
            start_stop_index: 0,
            end_stop_index: 1,
            driver: tripDriver,
            drivers: tripDrivers,
            truck: ownerTruck ? ownerTruck._id : null,
            start_location: `${startLoc.city}, ${startLoc.state}`,
            end_location: `${endLoc.city}, ${endLoc.state}`,
            miles: tripMiles,
            totalDistance: tripMiles,
            total_km: tripDistanceKm,
            distance_unit: 'mi',
            rate_per_mile: 1.5 + Math.random(),
            total_driver_pay: Math.round(tripMiles * (1.5 + Math.random()) * 100) / 100,
            status: orderStatus === 'completed' ? 'delivered' : (orderStatus === 'delivered' ? 'delivered' : 'en-route'),
            createdAt: new Date(startDate.getTime() + t * 24 * 60 * 60 * 1000)
          });
        }
        console.log(`  -> Created ${numTrips} trip(s)`);
      }
    }

    console.log(`\n✓ Successfully created ${ordersCreated.length} orders!`);
    console.log('Order breakdown:');
    console.log('  - With owner operated trucks:', ordersCreated.filter(o => o.isOwnerOperatedTruck).length);
    console.log('  - With multiple drivers:', ordersCreated.filter(o => o.drivers?.length > 1).length);
    console.log('  - Total trips created:', await Trip.countDocuments({ tenantId: tenantId }));

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

seed();
