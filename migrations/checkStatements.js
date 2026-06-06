require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const OwnerOperator = require('../db/OwnerOperator');
// Assuming the model is OwnerOperatorFinancialRecord or similar
// Let's first check what models exist related to statements
const fs = require('fs');
const path = require('path');

const modelsDir = path.join(__dirname, '../db');
const models = fs.readdirSync(modelsDir).filter(f => f.endsWith('.js'));
console.log('Available models:', models);

const MONGODB_URI = "mongodb+srv://naveenfp:naveenfp@cluster0.5c8ne.mongodb.net/carrier";

async function checkStatements() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

  const tenantId = 'cross-miles-carrier-inc';
  
  // Find CMC Trucks
  const oo = await OwnerOperator.findOne({ tenantId, fullName: /CMC Trucks/i }).lean();
  if (!oo) {
    console.log('CMC Trucks not found');
    process.exit(1);
  }
  console.log('Found CMC Trucks:', oo._id, oo.fullName);

  // Let's try to dynamically load the statement model
  let StatementModel;
  if (models.includes('OwnerOperatorFinancialRecord.js')) {
    StatementModel = require('../db/OwnerOperatorFinancialRecord');
  } else if (models.includes('OwnerOperatorStatement.js')) {
    StatementModel = require('../db/OwnerOperatorStatement');
  } else if (models.includes('Payslip.js')) {
    StatementModel = require('../db/Payslip');
  } else {
    // try to find by string matching
    const statementFile = models.find(m => m.toLowerCase().includes('statement') || m.toLowerCase().includes('financial'));
    if (statementFile) {
        StatementModel = require('../db/' + statementFile.replace('.js', ''));
    }
  }

  if (StatementModel) {
    console.log('Using statement model:', StatementModel.modelName);
    const statements = await StatementModel.find({ tenantId, ownerOperator: oo._id }).sort({ createdAt: -1 }).lean();
    console.log(`Found ${statements.length} statements for CMC Trucks:`);
    statements.forEach(s => {
      console.log(`\nStatement ID: ${s._id}`);
      console.log(`Date Range: ${s.startDate} to ${s.endDate}`);
      console.log(`Total Amount: ${s.totalAmount}`);
      console.log(`Paid Amount: ${s.paidAmount || s.paid_amount || s.amount_paid}`);
      console.log(`Balance/Due: ${s.balance || s.due_amount || s.remaining_amount}`);
      console.log(`Previous Balance: ${s.previous_balance || s.previousBalance || s.carry_forward || 'NOT SET'}`);
      console.log(`Status: ${s.status}`);
    });
  } else {
    console.log('Could not determine the exact Statement model.');
  }

  await mongoose.disconnect();
}

checkStatements().catch(console.error);
