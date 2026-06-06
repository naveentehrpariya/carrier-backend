const mongoose = require('mongoose');
const Order = require('../db/Order');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function testDirectQuery() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  
  const tenantId = 'cross-miles-carrier-inc';
  
  console.log('=== Testing Direct Queries ===\n');
  
  // Query 1: Basic tenantId filter
  const q1 = await Order.countDocuments({ tenantId });
  console.log('Query 1 (tenantId only):', q1, 'orders');
  
  // Query 2: With deletedAt filter
  const q2 = await Order.countDocuments({
    tenantId,
    $or: [
      { deletedAt: null },
      { deletedAt: '' },
      { deletedAt: { $exists: false } }
    ]
  });
  console.log('Query 2 (with deletedAt filter):', q2, 'orders');
  
  // Query 3: With company filter (like backend does)
  const q3 = await Order.countDocuments({
    tenantId,
    $or: [
      { deletedAt: null },
      { deletedAt: '' },
      { deletedAt: { $exists: false } }
    ],
    $and: [
      {
        $or: [
          { company: '68dffa19d8b26df9ed2c0e33' },
          { company: null },
          { company: { $exists: false } }
        ]
      }
    ]
  });
  console.log('Query 3 (with company filter):', q3, 'orders');
  
  // Query 4: Without company filter (what should work)
  const q4 = await Order.countDocuments({
    tenantId,
    $or: [
      { deletedAt: null },
      { deletedAt: '' },
      { deletedAt: { $exists: false } }
    ]
  });
  console.log('Query 4 (without company filter):', q4, 'orders');
  
  console.log('\n=== Conclusion ===');
  if (q1 === 50 && q2 === 50 && q3 === 50 && q4 === 50) {
    console.log('✓ All queries return 50 orders - Database is correct!');
    console.log('Issue is in API layer or authentication');
  } else {
    console.log('✗ Query mismatch detected');
    console.log('Some queries are returning fewer results');
  }
  
  await mongoose.disconnect();
}

testDirectQuery().catch(console.error);
