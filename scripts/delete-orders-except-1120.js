/**
 * Hard delete all orders where serial_no != 1120
 * Run: node scripts/delete-orders-except-1120.js
 * Add --confirm flag to actually delete: node scripts/delete-orders-except-1120.js --confirm
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../db/Order');

const DRY_RUN = !process.argv.includes('--confirm');

async function main() {
  await mongoose.connect(process.env.DB_URL_OFFICE);
  console.log('Connected to DB');

  const toKeep = await Order.countDocuments({ serial_no: 1120 });
  const toDelete = await Order.countDocuments({ serial_no: { $ne: 1120 } });

  console.log(`\nOrders with serial_no = 1120 (KEEP): ${toKeep}`);
  console.log(`Orders with serial_no != 1120 (DELETE): ${toDelete}`);

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — kuch delete nahi hua.');
    console.log('Delete karne ke liye run karo:');
    console.log('  node scripts/delete-orders-except-1120.js --confirm\n');
  } else {
    console.log('\nDeleting...');
    const result = await Order.deleteMany({ serial_no: { $ne: 1120 } });
    console.log(`✅ Deleted: ${result.deletedCount} orders`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
