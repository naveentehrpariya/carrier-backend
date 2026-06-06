require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const OwnerOperator = require('../db/OwnerOperator');
const OwnerOperatorSalary = require('../db/OwnerOperatorSalary');

const MONGODB_URI = "mongodb+srv://naveenfp:naveenfp@cluster0.5c8ne.mongodb.net/carrier";

async function checkDue() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const tenantId = 'cross-miles-carrier-inc';
  
  const oo = await OwnerOperator.findOne({ tenantId, fullName: /CMC Trucks/i }).lean();
  if (!oo) {
    console.log('Owner Operator not found');
    process.exit(1);
  }

  console.log(`Checking salaries for ${oo.fullName}...`);

  const salaries = await OwnerOperatorSalary.find({ tenantId, ownerOperator: oo._id })
    .sort({ year: 1, month: 1 })
    .lean();

  if (salaries.length === 0) {
    console.log('No salaries generated yet.');
  }

  salaries.forEach(s => {
    console.log(`\nMonth: ${s.month}/${s.year} (Generated: ${s.generatedAt})`);
    console.log(`  Base Payable: ${s.basePayable}`);
    console.log(`  Prev Due Added: ${s.previousDueAdded}`);
    console.log(`  Manual Add/Ded: +${s.manualAddition} / -${s.manualDeduction}`);
    console.log(`  Final Payable: ${s.finalPayable}`);
    console.log(`  Paid Amount: ${s.paidAmount}`);
    console.log(`  DUE AMOUNT: ${s.dueAmount}`);
    console.log(`  Payment Status: ${s.paymentStatus}`);
  });

  // Test the query used in backend
  const range = { month: 6, year: 2026 }; // June 2026
  const previousSalary = await OwnerOperatorSalary.findOne({
    tenantId,
    ownerOperator: oo._id,
    $or: [
      { year: { $lt: range.year } },
      { year: range.year, month: { $lt: range.month } },
    ],
  })
  .sort({ year: -1, month: -1 })
  .select('month year currency dueAmount')
  .lean();

  console.log('\nQuery for previous salary (from June 2026 perspective):');
  if (previousSalary) {
    console.log(`  Found Month: ${previousSalary.month}/${previousSalary.year}`);
    console.log(`  Due Amount to carry forward: ${previousSalary.dueAmount}`);
  } else {
    console.log('  No previous salary found.');
  }

  await mongoose.disconnect();
}

checkDue().catch(console.error);
