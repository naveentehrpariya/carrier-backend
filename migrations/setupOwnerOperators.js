require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const OwnerOperator = require('../db/OwnerOperator');
const Truck = require('../db/Truck');
const Company = require('../db/Company');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

const ownerOperatorData = [
  {
    fullName: 'Rajesh Kumar',
    email: 'rajesh.kumar@carrier.com',
    phone: '+91 9876543001',
    address: '123 Transport Nagar, Delhi',
    licenseNumber: 'DL-OO-001',
    truckDetails: {
      make: 'Tata',
      model: 'Ultra 1518',
      year: 2022,
      plateNumber: 'DL-01-AB-1234',
      unitNumber: 'OO-RK-101',
      type: 'Truck'
    }
  },
  {
    fullName: 'Mohan Singh',
    email: 'mohan.singh@carrier.com',
    phone: '+91 9876543002',
    address: '456 Trucking Zone, Mumbai',
    licenseNumber: 'MH-OO-002',
    truckDetails: {
      make: 'Ashok Leyland',
      model: 'Dost',
      year: 2021,
      plateNumber: 'MH-02-CD-5678',
      unitNumber: 'OO-MS-102',
      type: 'Truck'
    }
  },
  {
    fullName: 'Suresh Patel',
    email: 'suresh.patel@carrier.com',
    phone: '+91 9876543003',
    address: '789 Logistics Park, Bangalore',
    licenseNumber: 'KA-OO-003',
    truckDetails: {
      make: 'Mahindra',
      model: 'Bolero Pickup',
      year: 2023,
      plateNumber: 'KA-03-EF-9012',
      unitNumber: 'OO-SP-103',
      type: 'Truck'
    }
  },
  {
    fullName: 'Anil Verma',
    email: 'anil.verma@carrier.com',
    phone: '+91 9876543004',
    address: '321 Freight Hub, Chennai',
    licenseNumber: 'TN-OO-004',
    truckDetails: {
      make: 'Tata',
      model: 'Ace Gold',
      year: 2022,
      plateNumber: 'TN-04-GH-3456',
      unitNumber: 'OO-AV-104',
      type: 'Mini Truck'
    }
  },
  {
    fullName: 'Vijay Sharma',
    email: 'vijay.sharma@carrier.com',
    phone: '+91 9876543005',
    address: '654 Cargo Center, Kolkata',
    licenseNumber: 'WB-OO-005',
    truckDetails: {
      make: 'Ashok Leyland',
      model: 'Partner',
      year: 2021,
      plateNumber: 'WB-05-IJ-7890',
      unitNumber: 'OO-VS-105',
      type: 'Truck'
    }
  },
  {
    fullName: 'Dharmendra Yadav',
    email: 'dharmendra.yadav@carrier.com',
    phone: '+91 9876543006',
    address: '987 Transport Hub, Jaipur',
    licenseNumber: 'RJ-OO-006',
    truckDetails: {
      make: 'Tata',
      model: 'Ultra 2518',
      year: 2023,
      plateNumber: 'RJ-06-KL-1234',
      unitNumber: 'OO-DY-106',
      type: 'Heavy Truck'
    }
  },
  {
    fullName: 'Ramesh Gupta',
    email: 'ramesh.gupta@carrier.com',
    phone: '+91 9876543007',
    address: '147 Freight Zone, Ahmedabad',
    licenseNumber: 'GJ-OO-007',
    truckDetails: {
      make: 'Mahindra',
      model: 'Jeeto',
      year: 2022,
      plateNumber: 'GJ-07-MN-5678',
      unitNumber: 'OO-RG-107',
      type: 'Mini Truck'
    }
  },
  {
    fullName: 'Sanjay Pawar',
    email: 'sanjay.pawar@carrier.com',
    phone: '+91 9876543008',
    address: '258 Logistics Park, Pune',
    licenseNumber: 'MH-OO-008',
    truckDetails: {
      make: 'Tata',
      model: 'Ultra 2515',
      year: 2021,
      plateNumber: 'MH-08-OP-9012',
      unitNumber: 'OO-SP2-108',
      type: 'Truck'
    }
  },
  {
    fullName: 'Ajay Kumar',
    email: 'ajay.kumar@carrier.com',
    phone: '+91 9876543009',
    address: '369 Transport Nagar, Lucknow',
    licenseNumber: 'UP-OO-009',
    truckDetails: {
      make: 'Ashok Leyland',
      model: 'Dost Plus',
      year: 2023,
      plateNumber: 'UP-09-QR-3456',
      unitNumber: 'OO-AK-109',
      type: 'Truck'
    }
  },
  {
    fullName: 'Pranav Reddy',
    email: 'pranav.reddy@carrier.com',
    phone: '+91 9876543010',
    address: '741 Freight Hub, Hyderabad',
    licenseNumber: 'TS-OO-010',
    truckDetails: {
      make: 'Tata',
      model: 'Ultra 3518',
      year: 2022,
      plateNumber: 'TS-10-ST-7890',
      unitNumber: 'OO-PR-110',
      type: 'Heavy Truck'
    }
  },
  {
    fullName: 'Vikram Singh',
    email: 'vikram.singh@carrier.com',
    phone: '+91 9876543011',
    address: '852 Logistics Zone, Chandigarh',
    licenseNumber: 'CH-OO-011',
    truckDetails: {
      make: 'Mahindra',
      model: 'Bolero Maxitruck',
      year: 2021,
      plateNumber: 'CH-01-UV-1234',
      unitNumber: 'OO-VS2-111',
      type: 'Truck'
    }
  },
  {
    fullName: 'Arun Joshi',
    email: 'arun.joshi@carrier.com',
    phone: '+91 9876543012',
    address: '963 Transport Center, Surat',
    licenseNumber: 'GJ-OO-012',
    truckDetails: {
      make: 'Ashok Leyland',
      model: 'Ecomet',
      year: 2023,
      plateNumber: 'GJ-02-WX-5678',
      unitNumber: 'OO-AJ-112',
      type: 'Truck'
    }
  }
];

async function setupOwnerOperatorsWithTrucks() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');

    // Get company
    const company = await Company.findOne({ name: 'Cross Miles Carrier Inc' }).lean();
    if (!company) {
      console.log('Company "Cross Miles Carrier Inc" not found');
      process.exit(1);
    }
    const tenantId = company.tenantId || company._id.toString();
    console.log('Using company:', company.name, '- Tenant:', tenantId);

    // Delete existing orders and trips for this tenant
    console.log('\nDeleting existing orders and trips...');
    const deletedTrips = await Trip.deleteMany({ tenantId });
    const deletedOrders = await Order.deleteMany({ tenantId });
    console.log(`Deleted ${deletedOrders.deletedCount} orders and ${deletedTrips.deletedCount} trips`);

    // Delete existing owner operators and trucks for this tenant
    console.log('Deleting existing owner operators and trucks...');
    const deletedTrucks = await Truck.deleteMany({ tenantId, ownerOperated: true });
    const deletedOwnerOps = await OwnerOperator.deleteMany({ tenantId });
    console.log(`Deleted ${deletedOwnerOps.deletedCount} owner operators and ${deletedTrucks.deletedCount} trucks`);

    // Get existing owner operators count
    let ownerOpCounter = 1;
    let createdCount = 0;

    console.log('\nCreating owner operators with trucks...');

    for (const data of ownerOperatorData) {
      // Create owner operator with unique ownerOperatorId
      const ownerOpId = `OO-${ownerOpCounter.toString().padStart(4, '0')}`;
      
      const ownerOp = await OwnerOperator.create({
        tenantId,
        company: company._id,
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        address: data.address,
        licenseNumber: data.licenseNumber,
        ownerOperatorId: ownerOpId,
        status: 'active'
      });
      ownerOpCounter++;
      console.log(`Created Owner Operator: ${data.fullName} (${ownerOpId})`);

      // Create truck for this owner
      const truck = await Truck.create({
        tenantId,
        company: company._id,
        ownerOperator: ownerOp._id,
        ownerOperated: true,
        make: data.truckDetails.make,
        model: data.truckDetails.model,
        year: data.truckDetails.year,
        plateNumber: data.truckDetails.plateNumber,
        unitNumber: data.truckDetails.unitNumber,
        type: data.truckDetails.type,
        status: 'active',
        availability: 'available'
      });
      console.log(`  -> Created Truck: ${truck.make} ${truck.model} (${truck.plateNumber})`);

      createdCount++;
    }

    console.log(`\n✓ Successfully created ${createdCount} owner operators with trucks!`);

    // Summary
    const totalOwnerOps = await OwnerOperator.countDocuments({ tenantId });
    const totalTrucks = await Truck.countDocuments({ tenantId, ownerOperated: true });
    const totalOrders = await Order.countDocuments({ tenantId });
    const totalTrips = await Trip.countDocuments({ tenantId });

    console.log(`\nDatabase Summary for ${company.name}:`);
    console.log(`  - Owner Operators: ${totalOwnerOps}`);
    console.log(`  - Owner Operated Trucks: ${totalTrucks}`);
    console.log(`  - Orders: ${totalOrders}`);
    console.log(`  - Trips: ${totalTrips}`);

    await mongoose.disconnect();
    console.log('\n✓ Setup complete! Now run "node backend/migrations/create50Orders.js" to create 50 test orders.');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

setupOwnerOperatorsWithTrucks();
