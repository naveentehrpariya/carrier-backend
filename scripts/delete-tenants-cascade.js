// Cascade-delete tenants and ALL their tenant-scoped data.
// Usage:
//   node scripts/delete-tenants-cascade.js                 # dry-run (counts only)
//   node scripts/delete-tenants-cascade.js --apply         # actually delete
//
// Target tenants resolved by tenantId slug OR name (case-insensitive).
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../db/config');

const TARGETS = ['tehrpariya-web', 'blue-dart'];
const APPLY = process.argv.includes('--apply');

const Tenant = require('../db/Tenant');

// Every model that carries a tenantId (verified via grep over db/*.js).
const SCOPED_MODELS = [
  'ActivityLog', 'Carrier', 'Charges', 'Commudity', 'Company', 'ConversionRate',
  'Customer', 'DriverDeduction', 'DriverProfile', 'EmployeeDoc', 'EmptyMoveNote',
  'Equipment', 'Files', 'FleetDoc', 'IgnoredEmptyMove', 'Notification', 'Order',
  'OwnerOperator', 'OwnerOperatorFinancialRecord', 'OwnerOperatorFxRate',
  'OwnerOperatorSalary', 'PaymentLogs', 'SubscriptionHistory', 'Trailer', 'Trip',
  'Truck', 'TruckExpense', 'Users',
];

(async () => {
  await connectDB();

  // Resolve target tenants
  const tenants = await Tenant.find({
    $or: [
      { tenantId: { $in: TARGETS } },
      { name: { $in: TARGETS.map((t) => new RegExp(`^${t}$`, 'i')) } },
    ],
  });

  if (!tenants.length) {
    console.log('❌ No matching tenants found for:', TARGETS.join(', '));
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\n${APPLY ? '🔴 APPLY MODE — DELETING' : '🟡 DRY RUN — no changes'}\n`);
  console.log('Matched tenants:');
  tenants.forEach((t) => console.log(`  - ${t.name}  (slug: ${t.tenantId}, _id: ${t._id})`));
  const slugs = tenants.map((t) => t.tenantId);
  console.log('\nSlugs targeted:', slugs.join(', '), '\n');

  let grandTotal = 0;
  for (const name of SCOPED_MODELS) {
    let Model;
    try {
      Model = require(`../db/${name}`);
    } catch (e) {
      console.log(`  ! skip ${name} (model load failed)`);
      continue;
    }
    const filter = { tenantId: { $in: slugs } };
    const count = await Model.countDocuments(filter);
    grandTotal += count;
    if (count === 0) continue;
    if (APPLY) {
      const res = await Model.deleteMany(filter);
      console.log(`  x ${name.padEnd(30)} deleted ${res.deletedCount}`);
    } else {
      console.log(`  • ${name.padEnd(30)} ${count}`);
    }
  }

  console.log(`\nTotal scoped docs: ${grandTotal}`);

  if (APPLY) {
    const tRes = await Tenant.deleteMany({ _id: { $in: tenants.map((t) => t._id) } });
    console.log(`Tenant docs deleted: ${tRes.deletedCount}`);
    console.log('\n✅ Done. NOTE: Backblaze B2 file blobs are NOT removed by this script.');
  } else {
    console.log('\nRe-run with --apply to delete.');
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
