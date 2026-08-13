/**
 * Audit orders whose owner settlement was inflated by the legacy settle-pot FX bug.
 *
 * The bug (fixed in utils/ownerSettlement.js#resolveSettlePot): a LEGACY order predates
 * `input_settle_amount` and keeps its settlement pot in the base column (`settle_amount`, USD).
 * The moment an admin typed a per-leg amount in Trip Planning, that base number was read as if it
 * were already the order's input currency and then multiplied by `fx_to_usd` on the way back to
 * base — so the pot, and every owner leg paid out of it, grew by the whole FX rate.
 *
 *   settle_amount 1400 USD, input CAD, fx 1.4, one typed leg
 *     buggy : pot 1400 "CAD" -> legs 400 + 1000 -> order.settle_amount rewritten to 1960 USD
 *     fixed : pot 1000 CAD   -> legs 400 +  600 -> order.settle_amount stays        1400 USD
 *
 * The original pot was OVERWRITTEN in place, so it cannot be recomputed from the order alone.
 * Where the append-only activity log covers the order, this script recovers the pre-split value
 * from the oldest logged `settle_amount` change and reports the real gap. Where it does not, the
 * order is reported as "original unknown" with the FX evidence, for manual review.
 *
 * READ-ONLY. Nothing is written, no money moves. Decide per order what to correct by hand.
 *
 * Usage:
 *   node backend/scripts/audit-legacy-settle-fx-inflation.js
 *   node backend/scripts/audit-legacy-settle-fx-inflation.js --tenant cross-miles-carrier-inc-trucking
 *   node backend/scripts/audit-legacy-settle-fx-inflation.js --min-gap 5     # only gaps over $5
 *   node backend/scripts/audit-legacy-settle-fx-inflation.js --json          # machine-readable
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const ActivityLog = require('../db/ActivityLog');
const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');
const { tripOwnerId } = require('../utils/ownerSettlement');

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
};

const TENANT = argValue('--tenant', null);
const MIN_GAP = Number(argValue('--min-gap', 0.5));
const AS_JSON = process.argv.includes('--json');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hasOverride = (t) => t?.settle_amount !== null && t?.settle_amount !== undefined
  && Number.isFinite(Number(t.settle_amount));

// The pre-split settlement pot, recovered from the append-only activity log: the OLDEST logged
// change that touched settle_amount still carries the value the order had before trip planning
// rewrote it.
async function originalSettleFromLog(tenantId, orderId) {
  const rows = await ActivityLog.find({
    tenantId,
    resourceId: String(orderId),
    changedFields: 'settle_amount',
  })
    .sort({ seq: 1, createdAt: 1 })
    .select('before after createdAt seq')
    .lean();
  for (const row of rows) {
    const val = row?.before?.settle_amount;
    if (val !== null && val !== undefined && Number.isFinite(Number(val))) {
      return { value: Number(val), at: row.createdAt, seq: row.seq };
    }
  }
  return null;
}

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) {
    console.error('No DB_URL_OFFICE / MONGODB_URI in env');
    process.exit(1);
  }
  await mongoose.connect(uri);

  // Candidates: legacy pot (no input_settle_amount), real settle, and an FX that is not 1:1 —
  // an order typed in the base currency cannot be inflated by this bug.
  const filter = {
    order_type: 'regular',
    settle_amount: { $gt: 0 },
    fx_to_usd: { $gt: 0, $ne: 1 },
    $and: [
      { $or: [{ input_settle_amount: { $lte: 0 } }, { input_settle_amount: null }, { input_settle_amount: { $exists: false } }] },
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
    ],
  };
  if (TENANT) filter.tenantId = TENANT;

  const orders = await Order.find(filter)
    .select('_id serial_no tenantId settle_amount input_settle_amount input_currency revenue_currency fx_to_usd total_amount isMixedOwner ownerOperator ownerOperators createdAt')
    .lean();

  if (!AS_JSON) {
    console.log(`Connected. READ-ONLY audit${TENANT ? ` — tenant ${TENANT}` : ''}`);
    console.log(`${orders.length} legacy order(s) with a non-1 FX and a settlement to check\n`);
  }

  const affected = [];
  let unknownOriginal = 0;

  for (const order of orders) {
    const trips = await Trip.find({ tenantId: order.tenantId, order: order._id, deletedAt: null })
      .select('_id trip_no truck settle_amount totalDistance miles total_km')
      .lean();
    const typed = trips.filter(hasOverride);
    if (typed.length === 0) continue; // no typed leg amount ⇒ the bug never fired on this order

    const truckIds = [...new Set(trips.map((t) => t.truck).filter(Boolean).map(String))];
    const truckMap = new Map();
    if (truckIds.length) {
      const trucks = await Truck.find({ _id: { $in: truckIds }, tenantId: order.tenantId })
        .select('ownerOperated ownerOperator').lean();
      trucks.forEach((t) => truckMap.set(String(t._id), t));
    }
    const ownerLegs = trips.filter((t) => tripOwnerId(t, truckMap));
    if (ownerLegs.length === 0) continue; // nobody was paid out of the pot

    const fx = Number(order.fx_to_usd);
    const storedBase = money(order.settle_amount);
    const legSum = money(trips.reduce((a, t) => a + (hasOverride(t) ? Math.max(Number(t.settle_amount), 0) : 0), 0));

    const original = await originalSettleFromLog(order.tenantId, order._id);
    // What the order SHOULD carry: the pre-split pot, unchanged — the fixed code converts it into
    // the input currency to split, then straight back to base, so the total never moves.
    const correctBase = original ? money(original.value) : null;
    const gap = correctBase === null ? null : money(storedBase - correctBase);

    // Independent corroboration: under the bug the stored base ends up ~fx times the pot.
    const inflationRatio = correctBase && correctBase > 0 ? storedBase / correctBase : null;
    const looksInflated = inflationRatio !== null
      ? Math.abs(inflationRatio - fx) < 0.02
      : Math.abs(storedBase - money(legSum * fx)) < 0.05; // legs already frozen at the buggy split

    if (correctBase === null) unknownOriginal += 1;
    if (gap !== null && gap <= MIN_GAP && !looksInflated) continue;
    if (gap === null && !looksInflated) continue;

    const settlementRows = await OwnerOperatorFinancialRecord.find({
      tenantId: order.tenantId, order: order._id, type: 'SETTLEMENT',
    }).select('ownerOperator amount paymentStatus').lean();

    affected.push({
      tenantId: order.tenantId,
      orderId: String(order._id),
      serial_no: order.serial_no,
      createdAt: order.createdAt,
      input_currency: (order.input_currency || '').toUpperCase() || null,
      fx_to_usd: fx,
      stored_settle_base: storedBase,
      original_settle_base: correctBase,
      overpaid_base: gap,
      inflation_ratio: inflationRatio === null ? null : Math.round(inflationRatio * 1000) / 1000,
      typed_leg_total: legSum,
      legs: trips.map((t) => ({
        trip_no: t.trip_no,
        owner: tripOwnerId(t, truckMap),
        settle_amount: hasOverride(t) ? money(t.settle_amount) : null,
      })),
      owner_settlement_rows: settlementRows.map((r) => ({
        owner: String(r.ownerOperator), amount: money(r.amount), paid: r.paymentStatus,
      })),
      already_paid: settlementRows.some((r) => r.paymentStatus === 'paid'),
      note: correctBase === null
        ? 'original pot not in the activity log — verify by hand before changing anything'
        : null,
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ scanned: orders.length, affected }, null, 2));
  } else {
    if (affected.length === 0) {
      console.log('No order shows the legacy settle-pot FX inflation. Nothing to correct.');
    } else {
      console.log(`${affected.length} order(s) affected (${unknownOriginal} with no recoverable original):\n`);
      for (const a of affected) {
        console.log(`  #${a.serial_no}  ${a.tenantId}  ${a.input_currency || '?'} @ fx ${a.fx_to_usd}`);
        console.log(`     stored settle : ${a.stored_settle_base} USD`);
        console.log(`     original pot  : ${a.original_settle_base === null ? 'UNKNOWN (not in audit log)' : `${a.original_settle_base} USD`}`);
        if (a.overpaid_base !== null) console.log(`     OVERPAID BY   : ${a.overpaid_base} USD  (ratio ${a.inflation_ratio} vs fx ${a.fx_to_usd})`);
        console.log(`     typed legs    : ${a.typed_leg_total} ${a.input_currency || ''} across ${a.legs.length} leg(s)`);
        console.log(`     owner rows    : ${a.owner_settlement_rows.map((r) => `${r.amount} (${r.paid})`).join(', ') || 'none'}`);
        if (a.already_paid) console.log('     ⚠ already marked PAID — correcting this moves money that was handed over');
        if (a.note) console.log(`     note          : ${a.note}`);
        console.log('');
      }
      const total = affected.reduce((s, a) => s + (a.overpaid_base || 0), 0);
      console.log(`Total recoverable overpayment across orders with a known original: ${money(total)} USD`);
      console.log('\nNothing was written. Re-run with --json to feed a correction by hand.');
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('Audit failed:', err.message);
  try { await mongoose.disconnect(); } catch (e) {}
  process.exit(1);
});
