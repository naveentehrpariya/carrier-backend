/**
 * Repair orders whose input currency was saved wrong.
 *
 * Until the AddOrder fix, the order form could send `revenue_currency: 'usd'` even when the header
 * was on CAD/INR: the amounts were typed in the header currency, but stored as if they were USD
 * (input_currency='usd', fx_to_usd=1, base amounts = typed amounts, no conversion).
 *
 * This script re-stamps the real input currency and re-derives every BASE (USD) amount from the
 * typed `input_*` values using the FX of the month the order was created in. The typed values are
 * never touched — they are what the user actually entered.
 *
 * USAGE:
 *   node scripts/fix-order-input-currency.js --serials=1004,1007 --currency=cad --tenant=<tenantId>
 *   node scripts/fix-order-input-currency.js --serials=1004,1007 --currency=cad --tenant=<tenantId> --apply
 *
 *   (dry run by default — prints the before/after of every field it would write)
 *
 * SAFETY: only touches orders that still look unconverted (input_currency 'usd' AND fx_to_usd 1).
 * An order already in the target currency, or already converted, is skipped — so re-running cannot
 * double-convert.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../db/config');
const Order = require('../db/Order');
const { backupCollections } = require('./_backupHelper');
const { ensureMonthlyFxRates } = require('../controllers/ownerOperatorController');
const { normalizeCurrency, convertAmount } = require('../utils/fx');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function run() {
  const apply = process.argv.includes('--apply');
  const serials = String(arg('serials') || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const currency = normalizeCurrency(arg('currency'), '');
  const tenantId = arg('tenant');

  if (serials.length === 0 || !currency || !tenantId) {
    console.error('Usage: node scripts/fix-order-input-currency.js --serials=1004,1007 --currency=cad --tenant=<tenantId> [--apply]');
    process.exit(1);
  }
  if (currency === 'USD') {
    console.error('Target currency is USD — nothing to convert (USD is the base currency).');
    process.exit(1);
  }

  await connectDB();
  console.log('Connected to MongoDB');
  console.log(apply ? '\n🔧 APPLY MODE — will back up then write changes\n' : '\n🔍 DRY RUN — no changes written (use --apply)\n');

  const orders = await Order.find({ tenantId, serial_no: { $in: serials } }).lean();
  if (orders.length === 0) {
    console.log('No orders matched.');
    process.exit(0);
  }

  if (apply) {
    await backupCollections('order-input-currency-backup', [
      {
        collection: 'orders',
        projection: {
          _id: 1, tenantId: 1, serial_no: 1, createdAt: 1,
          input_currency: 1, revenue_currency: 1, amount_currency: 1, fx_to_usd: 1,
          input_total_amount: 1, input_carrier_amount: 1, input_settle_amount: 1,
          total_amount: 1, carrier_amount: 1, settle_amount: 1, owner_profit: 1,
          revenue_items: 1, carrier_revenue_items: 1,
        },
      },
    ]);
  }

  let fixed = 0;
  for (const o of orders) {
    const stored = normalizeCurrency(o.input_currency || o.revenue_currency, 'USD');
    const fx = Number(o.fx_to_usd || 1);
    if (stored === currency) {
      console.log(`  #${o.serial_no}  skip — already ${currency}`);
      continue;
    }
    if (stored !== 'USD' || fx !== 1) {
      console.log(`  #${o.serial_no}  skip — looks already converted (input_currency=${stored}, fx_to_usd=${fx})`);
      continue;
    }

    const created = new Date(o.createdAt || Date.now());
    const month = created.getMonth() + 1;
    const year = created.getFullYear();
    // Month-pinned rate, auto-seeded from the FX API when the tenant has no stored row.
    const fxMap = await ensureMonthlyFxRates(tenantId, month, year, 'USD', [currency]);
    const rate = Number(convertAmount(1, currency, 'USD', fxMap).value || 0);
    if (!rate || rate === 1) {
      console.log(`  #${o.serial_no}  SKIP — no ${currency}->USD rate for ${month}/${year} (would convert 1:1 and corrupt the amount)`);
      continue;
    }

    const inputTotal = Number(o.input_total_amount || o.total_amount || 0);
    const inputCarrier = Number(o.input_carrier_amount || o.carrier_amount || 0);
    const inputSettle = Number(o.input_settle_amount || o.settle_amount || 0);
    const convertItems = (items) => (Array.isArray(items) ? items : []).map((it) => {
      const next = { ...(it || {}) };
      if (next.rate !== undefined && next.rate !== null && next.rate !== '' && Number.isFinite(Number(next.rate))) {
        next.rate = round2(Number(next.rate) * rate);
      }
      return next;
    });

    const update = {
      input_currency: currency.toLowerCase(),
      revenue_currency: 'usd',
      amount_currency: 'usd',
      fx_to_usd: rate,
      input_total_amount: inputTotal,
      input_carrier_amount: inputCarrier,
      input_settle_amount: inputSettle,
      total_amount: round2(inputTotal * rate),
      carrier_amount: round2(inputCarrier * rate),
      settle_amount: round2(inputSettle * rate),
      revenue_items: convertItems(o.revenue_items),
      carrier_revenue_items: convertItems(o.carrier_revenue_items),
    };
    update.owner_profit = round2(update.total_amount - update.settle_amount);

    console.log(`  #${o.serial_no}  ${currency}->USD @ ${rate} (${month}/${year})`);
    console.log(`      input_currency : usd -> ${update.input_currency}`);
    console.log(`      total_amount   : ${o.total_amount} -> ${update.total_amount}   (typed ${inputTotal} ${currency})`);
    console.log(`      carrier_amount : ${o.carrier_amount} -> ${update.carrier_amount}`);
    console.log(`      settle_amount  : ${o.settle_amount} -> ${update.settle_amount}`);

    if (apply) {
      await Order.updateOne({ _id: o._id, tenantId }, { $set: update });
      fixed += 1;
    }
  }

  console.log(apply ? `\n✅ Fixed ${fixed} order(s).` : `\n🔍 Dry run complete — re-run with --apply to write.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
