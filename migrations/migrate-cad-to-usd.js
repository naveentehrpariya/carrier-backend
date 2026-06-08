/**
 * Migration: Change base currency from CAD to USD
 *
 * SAFE to run:
 *   - Renames fx_to_cad → fx_to_usd in Order documents (field rename only, value unchanged)
 *
 * DO NOT run the salary/financial sections if you have existing salary records generated
 * in CAD — those amounts are stored as CAD numbers and relabeling them as USD would
 * display wrong values. Leave existing salary records as-is; new salaries will default to USD.
 *
 * Run: node backend/migrations/migrate-cad-to-usd.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const connectDB = require('../db/config');

async function run() {
  await connectDB();
  console.log('Connected to DB. Starting CAD → USD base currency migration...\n');

  const db = mongoose.connection.db;

  // ─── SAFE: rename fx_to_cad → fx_to_usd in orders ───────────────────────────
  // This is just a field name change. The stored numeric value is unchanged.
  // The field is a reference/audit field only — it does not affect amount display.
  const renameResult = await db.collection('orders').updateMany(
    { fx_to_cad: { $exists: true } },
    { $rename: { fx_to_cad: 'fx_to_usd' } }
  );
  console.log(`[DONE] Orders: fx_to_cad renamed to fx_to_usd — ${renameResult.modifiedCount} documents`);

  // ─── INFO: existing orders are already correct ────────────────────────────────
  // Each order already has:
  //   input_currency  — the currency the user chose when entering (e.g. 'cad', 'usd', 'inr')
  //   input_total_amount — the exact amount the user typed
  //   revenue_currency  — the base currency amounts were converted to ('cad' for old orders)
  //   total_amount      — the converted base amount
  //
  // The frontend now shows input_total_amount + input_currency (exact value).
  // Old orders with input_total_amount=0 fall back to total_amount + revenue_currency.
  // Both cases display correctly — NO numeric changes needed.
  console.log('[INFO] Orders: no amount changes needed — input_currency + input_total_amount already correct');

  // ─── SKIPPED: owneroperatorsalaries ──────────────────────────────────────────
  // Salary records store amounts in the currency they were generated in (salary.currency).
  // Relabeling existing CAD salaries as USD would show wrong numbers.
  // New salary records generated after this deploy will default to USD automatically.
  console.log('[SKIP] OwnerOperatorSalary: existing records left unchanged (amounts are in their stored currency)');
  console.log('       New salaries will default to USD going forward.');

  // ─── SKIPPED: owneroperatorfinancialrecords ───────────────────────────────────
  // Same reason as salaries — amounts are stored in their recorded currency.
  console.log('[SKIP] OwnerOperatorFinancialRecord: existing records left unchanged');

  // ─── OPTIONAL: update tenant billing.currency ────────────────────────────────
  // This controls the DEFAULT payout currency shown in the salary UI for your tenant.
  // If your team wants future salary generation to default to USD, uncomment the block below.
  // If you want to keep defaulting to CAD for your existing tenant, leave it commented.
  //
  // const tenantResult = await db.collection('tenants').updateMany(
  //   { 'billing.currency': 'CAD' },
  //   { $set: { 'billing.currency': 'USD' } }
  // );
  // console.log(`[DONE] Tenant billing.currency updated: ${tenantResult.modifiedCount} documents`);
  console.log('[OPTIONAL] Tenant billing.currency: uncomment the block in this script if you want');
  console.log('           future salary generation to default to USD for existing tenants.');

  console.log('\nMigration complete.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
