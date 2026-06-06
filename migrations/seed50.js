const fs = require('fs');
const content = `require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const Company = require('../db/Company');
const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/carrier';

async function seed() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to MongoDB');

  const company = await Company.findOne().lean();
  if (!company) throw new Error('No company found');
  const tenantId = company.tenantId || company._id.toString();

  // Create an Owner Operator if none exist
  let owner = await OwnerOperator.findOne({ tenantId }).lean();
  if (!owner) {
    console.log("Creating default Owner Operator...");
    owner = await OwnerOperator.create({
      tenantId, company: company._id, fullName: "Dummy Owner", email: "dummy@owner.com", status: "active", currency: "CAD", created_by: company.added_by
    });
  }

  // Create a Truck if none exist
  let truck = await Truck.findOne({ tenantId, ownership: 'owner_operator' }).lean();
  if (!truck) {
    console.log("Creating default Truck...");
    truck = await Truck.create({
      tenantId, company: company._id, unitNumber: "TRK-01", plateNumber: "PL-01", ownership: "owner_operator", ownerOperator: owner._id, status: "active", created_by: company.added_by
    });
  }

  const owners = await OwnerOperator.find({ tenantId }).lean();
  const trucks = await Truck.find({ tenantId, ownership: 'owner_operator' }).lean();
  const drivers = await DriverProfile.find({ tenantId }).lean();
  
  const indianLocations = [
    { city: 'Delhi', location: 'New Delhi, Delhi' },
    { city: 'Mumbai', location: 'Mumbai, Maharashtra' },
    { city: 'Bangalore', location: 'Bangalore, Karnataka' },
    { city: 'Chennai', location: 'Chennai, Tamil Nadu' },
    { city: 'Kolkata', location: 'Kolkata, West Bengal' },
    { city: 'Jaipur', location: 'Jaipur, Rajasthan' },
    { city: 'Ahmedabad', location: 'Ahmedabad, Gujarat' },
    { city: 'Pune', location: 'Pune, Maharashtra' }
  ];

  function getRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  console.log('Starting to seed 50 orders...');
  
  let maxOrder = await Order.findOne({ tenantId }).sort({ serial_no: -1 }).lean();
  let serialBase = maxOrder && maxOrder.serial_no ? parseInt(maxOrder.serial_no) : 9000;
  
  for (let i = 0; i < 50; i++) {
    serialBase++;
    const rTruck = getRandom(trucks);
    const rOwner = owners.find(o => String(o._id) === String(rTruck.ownerOperator)) || getRandom(owners);
    const scenario = Math.random();
    let assignedDrivers = [];
    let driverAssignmentMode = 'company_driver';
    
    if (scenario < 0.3) {
      driverAssignmentMode = 'owner_driver';
    } else if (scenario < 0.7 && drivers.length > 0) {
      assignedDrivers = [getRandom(drivers)._id];
    } else if (drivers.length > 1) {
      assignedDrivers = [drivers[0]._id, drivers[1]._id];
    }
    
    const loc1 = getRandom(indianLocations);
    let loc2 = getRandom(indianLocations);
    while (loc1.city === loc2.city) loc2 = getRandom(indianLocations);
    
    const totalDistance = Math.floor(Math.random() * 800) + 200;
    const settleAmount = totalDistance * 1.5;
    const totalAmount = settleAmount + 500;
    
    const startOffset = Math.random() * 90 * 24 * 60 * 60 * 1000;
    const startDate = new Date(Date.now() - startOffset);
    const endDate = new Date(startDate.getTime() + (Math.random() * 3 + 1) * 24 * 60 * 60 * 1000);

    const orderData = {
      tenantId, company: company._id, serial_no: serialBase, customer_order_no: 'CUST-' + serialBase,
      order_type: 'regular', order_status: 'delivered', isOwnerOperatedTruck: true, ownerOperator: rOwner._id,
      truck: rTruck._id, driver_assignment_mode: driverAssignmentMode,
      driver_assignment_status: driverAssignmentMode === 'owner_driver' ? 'owner_operator_driver' : (assignedDrivers.length ? 'company_driver_assigned' : 'company_driver_unassigned'),
      drivers: assignedDrivers, driver: assignedDrivers.length ? assignedDrivers[0] : null,
      total_amount: totalAmount, settle_amount: settleAmount, owner_profit: settleAmount * 0.8,
      input_total_amount: totalAmount, input_settle_amount: settleAmount, totalDistance: totalDistance,
      revenue_currency: 'cad', amount_currency: 'cad', input_currency: 'cad', fx_to_cad: 1,
      shipping_details: [{ locations: [
        { type: 'pickup', location: loc1.location, city: loc1.city, date: startDate.toISOString() },
        { type: 'delivery', location: loc2.location, city: loc2.city, date: endDate.toISOString() }
      ]}],
      created_by: company.added_by || null, createdAt: startDate, orderCreatedAt: startDate,
    };

    const order = await Order.create(orderData);
    
    await Trip.create({
      tenantId, order: order._id, trip_no: 1, start_stop_index: 0, end_stop_index: 1,
      driver: orderData.driver, drivers: orderData.drivers, truck: orderData.truck,
      start_location: loc1.location, end_location: loc2.location, miles: totalDistance,
      totalDistance: totalDistance, distance_unit: 'mi', created_by: orderData.created_by, createdAt: startDate
    });
    
    if (Math.random() < 0.2) {
      let loc3 = getRandom(indianLocations);
      const trip2Date = new Date(endDate.getTime() + (Math.random() * 2 + 1) * 24 * 60 * 60 * 1000);
      await Trip.create({
        tenantId, order: order._id, trip_no: 2, start_stop_index: 1, end_stop_index: 2,
        driver: orderData.driver, drivers: orderData.drivers, truck: orderData.truck,
        start_location: loc2.location, end_location: loc3.location, miles: totalDistance / 2,
        totalDistance: totalDistance / 2, distance_unit: 'mi', created_by: orderData.created_by, createdAt: endDate
      });
      order.shipping_details[0].locations.push({
        type: 'delivery', location: loc3.location, city: loc3.city, date: trip2Date.toISOString()
      });
      order.markModified('shipping_details');
      await order.save();
    }

    await OwnerOperatorFinancialRecord.create({
      tenantId, company: company._id, ownerOperator: rOwner._id, order: order._id,
      type: 'ORDER_PROFIT', amount: orderData.owner_profit, currency: 'CAD',
      month: startDate.getMonth() + 1, year: startDate.getFullYear(),
      notes: 'Order #' + serialBase + ' Profit', createdAt: startDate,
    });
  }

  console.log('Seeding complete! 50 orders created successfully.');
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
`;
fs.writeFileSync(__dirname + '/seed_script.js', content);
