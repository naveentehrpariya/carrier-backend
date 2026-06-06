require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const Company = require('../db/Company');
const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function seed() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("Connected to MongoDB");

  const company = await Company.findOne().lean();
  if (!company) throw new Error("No company found");
  const tenantId = company.tenantId || company._id.toString();

  const owners = await OwnerOperator.find({ tenantId }).lean();
  if (!owners.length) throw new Error("No OwnerOperators found");

  const trucks = await Truck.find({ tenantId, ownership: 'owner_operator' }).lean();
  if (!trucks.length) throw new Error("No Owner Operated trucks found");

  const drivers = await DriverProfile.find({ tenantId }).lean();
  
  const locs = [
    { city: "Delhi", location: "New Delhi, Delhi" },
    { city: "Mumbai", location: "Mumbai, Maharashtra" },
    { city: "Bangalore", location: "Bangalore, Karnataka" },
    { city: "Chennai", location: "Chennai, Tamil Nadu" },
    { city: "Kolkata", location: "Kolkata, West Bengal" },
    { city: "Jaipur", location: "Jaipur, Rajasthan" },
    { city: "Ahmedabad", location: "Ahmedabad, Gujarat" },
    { city: "Pune", location: "Pune, Maharashtra" },
    { city: "Lucknow", location: "Lucknow, Uttar Pradesh" },
    { city: "Hyderabad", location: "Hyderabad, Telangana" }
  ];

  function getRnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  console.log("Starting to seed 50 orders...");
  let maxOrder = await Order.findOne({ tenantId }).sort({ serial_no: -1 }).lean();
  let serialBase = maxOrder && maxOrder.serial_no ? parseInt(maxOrder.serial_no) : 9000;
  
  for (let i = 0; i < 50; i++) {
    serialBase++;
    const truck = getRnd(trucks);
    const owner = owners.find(o => String(o._id) === String(truck.ownerOperator)) || getRnd(owners);
    
    const scenario = Math.random();
    let assignedDrivers = [];
    let driverAssignmentMode = 'company_driver';
    
    if (scenario < 0.3) {
      driverAssignmentMode = 'owner_driver';
    } else if (scenario < 0.7 && drivers.length > 0) {
      assignedDrivers = [getRnd(drivers)._id];
    } else if (drivers.length > 1) {
      assignedDrivers = [drivers[0]._id, drivers[1]._id];
    }
    
    const l1 = getRnd(locs);
    let l2 = getRnd(locs);
    while (l1.city === l2.city) l2 = getRnd(locs);
    
    const totalDist = Math.floor(Math.random() * 800) + 200;
    const settleAmt = totalDist * 1.5;
    const totalAmt = settleAmt + 500;
    
    const sOffset = Math.random() * 90 * 24 * 60 * 60 * 1000;
    const sDate = new Date(Date.now() - sOffset);
    const eDate = new Date(sDate.getTime() + (Math.random() * 3 + 1) * 24 * 60 * 60 * 1000);

    const orderData = {
      tenantId, company: company._id, serial_no: serialBase, customer_order_no: `CUST-${serialBase}`,
      order_type: 'regular', order_status: 'delivered', isOwnerOperatedTruck: true, ownerOperator: owner._id,
      truck: truck._id, driver_assignment_mode: driverAssignmentMode,
      driver_assignment_status: driverAssignmentMode === 'owner_driver' ? 'owner_operator_driver' : (assignedDrivers.length ? 'company_driver_assigned' : 'company_driver_unassigned'),
      drivers: assignedDrivers, driver: assignedDrivers.length ? assignedDrivers[0] : null,
      total_amount: totalAmt, settle_amount: settleAmt, owner_profit: settleAmt * 0.8,
      input_total_amount: totalAmt, input_settle_amount: settleAmt, totalDistance: totalDist,
      revenue_currency: 'cad', amount_currency: 'cad', input_currency: 'cad', fx_to_cad: 1,
      shipping_details: [{ locations: [
        { type: 'pickup', location: l1.location, city: l1.city, date: sDate.toISOString() },
        { type: 'delivery', location: l2.location, city: l2.city, date: eDate.toISOString() }
      ]}],
      created_by: company.added_by || null, createdAt: sDate, orderCreatedAt: sDate,
    };

    const order = await Order.create(orderData);
    
    await Trip.create({
      tenantId, order: order._id, trip_no: 1, start_stop_index: 0, end_stop_index: 1,
      driver: orderData.driver, drivers: orderData.drivers, truck: orderData.truck,
      start_location: l1.location, end_location: l2.location, miles: totalDist,
      totalDistance: totalDist, distance_unit: 'mi', created_by: orderData.created_by, createdAt: sDate
    });
    
    if (Math.random() < 0.2) {
      let l3 = getRnd(locs);
      const trip2Date = new Date(eDate.getTime() + (Math.random() * 2 + 1) * 24 * 60 * 60 * 1000);
      await Trip.create({
        tenantId, order: order._id, trip_no: 2, start_stop_index: 1, end_stop_index: 2,
        driver: orderData.driver, drivers: orderData.drivers, truck: orderData.truck,
        start_location: l2.location, end_location: l3.location, miles: totalDist / 2,
        totalDistance: totalDist / 2, distance_unit: 'mi', created_by: orderData.created_by, createdAt: eDate
      });
      order.shipping_details[0].locations.push({
        type: 'delivery', location: l3.location, city: l3.city, date: trip2Date.toISOString()
      });
      order.markModified('shipping_details');
      await order.save();
    }

    await OwnerOperatorFinancialRecord.create({
      tenantId, company: company._id, ownerOperator: owner._id, order: order._id,
      type: 'ORDER_PROFIT', amount: orderData.owner_profit, currency: 'CAD',
      month: sDate.getMonth() + 1, year: sDate.getFullYear(),
      notes: `Order #${serialBase} Profit`, createdAt: sDate,
    });
  }

  console.log("Seeding complete! 50 orders created successfully.");
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
