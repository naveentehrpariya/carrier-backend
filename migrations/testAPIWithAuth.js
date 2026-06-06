require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const User = require('../db/Users');
const jwt = require('jsonwebtoken');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function testAPIWithAuth() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB\n');

    // Get admin user
    const adminUser = await User.findOne({ tenantId: 'cross-miles-carrier-inc', is_admin: 1 }).lean();
    if (!adminUser) {
      console.log('No admin user found');
      process.exit(1);
    }
    console.log('Admin user:', adminUser.email);

    // Generate JWT token
    const token = jwt.sign(
      { id: adminUser._id, email: adminUser.email, tenantId: adminUser.tenantId },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '1h' }
    );
    console.log('Generated token:', token.substring(0, 50) + '...');

    console.log('\n=== Testing API Call (Simulated) ===');
    console.log('GET /api/order/listings');
    console.log('Headers:');
    console.log('  - Authorization: Bearer [TOKEN]');
    console.log('  - X-Tenant-ID: cross-miles-carrier-inc');
    console.log('\nQuery would be:');
    console.log('  tenantId: cross-miles-carrier-inc');
    console.log('  deletedAt: null/$exists:false');
    console.log('  created_by (for non-admin): ', adminUser._id);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

testAPIWithAuth();
