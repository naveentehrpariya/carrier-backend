require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Company = require('../db/Company');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function checkCompanies() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB\n');

    const companies = await Company.find().lean();
    console.log('All Companies:');
    companies.forEach((c, i) => {
      console.log(`${i+1}. ${c.name} (tenantId: ${c.tenantId})`);
    });

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

checkCompanies();
