#!/usr/bin/env node
/**
 * Cheque uniqueness moved from {tenantId, chequeNo} to
 * {tenantId, bankAccount, chequeNo} — two cheque books from two banks
 * legitimately carry the same pre-printed numbers.
 *
 * Mongoose never drops removed indexes (see the stale-index rule in
 * CLAUDE.md), so any environment that already ran the earlier build keeps the
 * old per-tenant unique index and would reject valid per-account numbers.
 * This drops the old index and lets the new one build.
 *
 *   node backend/scripts/migrate-cheque-account-index.js          # dry run
 *   node backend/scripts/migrate-cheque-account-index.js --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const OLD_INDEX = 'tenantId_1_chequeNo_1';

(async () => {
  const url = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!url) { console.error('No DB url in env.'); process.exit(2); }
  await mongoose.connect(url);
  const col = mongoose.connection.collection('payment_cheques');

  const indexes = await col.indexes().catch(() => []);
  const has = indexes.some((i) => i.name === OLD_INDEX);
  console.log(`payment_cheques indexes: ${indexes.map((i) => i.name).join(', ') || '(none)'}`);

  if (!has) {
    console.log(`Old index ${OLD_INDEX} not present — nothing to do.`);
  } else if (!APPLY) {
    console.log(`DRY RUN: would drop ${OLD_INDEX}. Re-run with --apply.`);
  } else {
    await col.dropIndex(OLD_INDEX);
    console.log(`Dropped ${OLD_INDEX}.`);
    // Let the new compound index build now rather than on next boot.
    const PaymentCheque = require('../db/PaymentCheque');
    await PaymentCheque.syncIndexes();
    console.log('Synced new indexes:', (await col.indexes()).map((i) => i.name).join(', '));
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
