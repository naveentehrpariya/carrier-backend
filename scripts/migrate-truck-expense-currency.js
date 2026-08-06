/**
 * Backfill `currency` on truck expenses.
 *
 * Truck expenses used to be stored as a bare number and rendered as USD, then converted to the
 * header currency. Reports now convert each expense from the currency it was entered in, so
 * legacy rows are stamped 'USD' — exactly how they were already being displayed. No amount moves.
 *
 * Usage:
 *   node backend/scripts/migrate-truck-expense-currency.js          # dry run
 *   node backend/scripts/migrate-truck-expense-currency.js --apply  # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const TruckExpense = require('../db/TruckExpense');

const APPLY = process.argv.includes('--apply');

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) {
    console.error('No DB_URL_OFFICE / MONGODB_URI in env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const filter = { $or: [{ currency: { $exists: false } }, { currency: null }, { currency: '' }] };
  const count = await TruckExpense.countDocuments(filter);
  console.log(`Truck expenses missing currency: ${count}`);

  if (count && APPLY) {
    const res = await TruckExpense.updateMany(filter, { $set: { currency: 'USD' } });
    console.log(`Updated: ${res.modifiedCount}`);
  } else if (count) {
    console.log('Dry run — re-run with --apply to write.');
  }

  await mongoose.disconnect();
  console.log('Done.');
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
