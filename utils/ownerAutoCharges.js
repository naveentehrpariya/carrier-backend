/**
 * The deductions an owner-operator payslip carries WITHOUT anyone typing them (client, 2026-10-06):
 *
 *  1. The fixed monthly expenses of the owner's trucks (insurance, parking — `Truck.insuranceMonthly`
 *     / `parkingMonthly`, materialized as `TruckExpense{isFixed}` rows by `ensureFixedExpenses`).
 *  2. Our driver's empty-mile pay when they drove one of this owner's trucks between loads
 *     (`utils/emptyMovePay.js` — the same moves, miles and rate as the driver's own payslip).
 *
 * Both are reviewed BEFORE the payslip is generated, and either can be taken off:
 *  - a fixed expense via `TruckExpense.excludeFromOwnerPay` (it still counts against the truck),
 *  - an empty move via `IgnoredEmptyMove` (off the driver's payslip and the logs too — one switch).
 *
 * At generate time `syncOwnerAutoCharges` writes them as ordinary `OwnerAdjustment` deduction rows
 * keyed by `autoKey`, so the totals, the statement PDF, the list and the preview all read them
 * through the one ledger that already explains every line. A line that is no longer charged is
 * soft-deleted, never left standing.
 */
const Truck = require('../db/Truck');
const TruckExpense = require('../db/TruckExpense');
const OwnerAdjustment = require('../db/OwnerAdjustment');
const { ownerEmptyMoveCharges } = require('./emptyMovePay');
const { round2 } = require('./payslipMath');

const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
const idStr = (v) => String(v?._id || v || '');

/** Every fixed expense on this owner's trucks for `month` (1-12) — excluded ones flagged, not dropped. */
async function ownerFixedExpenses(tenantId, ownerId, month, year) {
  const trucks = await Truck.find({ tenantId, ownerOperator: ownerId, ...notDeleted }).lean();
  if (!trucks.length) return [];
  // Rows only exist once someone has opened that truck's expenses for the month; payroll cannot
  // depend on that, so make sure they exist. TruckExpense.fixedMonth is 0-11.
  const { ensureFixedExpenses } = require('../controllers/truckExpenseController');
  for (const truck of trucks) {
    await ensureFixedExpenses(truck, tenantId, month - 1, year);
  }
  const numberBy = new Map(trucks.map((t) => [idStr(t._id), t.truckNumber || t.unitNumber || t.plateNumber || '']));
  const rows = await TruckExpense.find({
    tenantId, truck: { $in: trucks.map((t) => t._id) },
    isFixed: true, fixedMonth: month - 1, fixedYear: year, deletedAt: null,
  }).sort({ truck: 1, type: 1 }).lean();
  return rows.map((r) => ({
    _id: r._id,
    truck: { _id: r.truck, number: numberBy.get(idStr(r.truck)) || '' },
    type: r.type,
    amount: round2(r.amount),
    currency: r.currency || 'USD',
    date: r.date,
    excluded: !!r.excludeFromOwnerPay,
  }));
}

/** Everything the review panel shows for one owner + month. */
async function ownerAutoChargeReview(tenantId, ownerId, range) {
  const [fixedExpenses, emptyMoves] = await Promise.all([
    ownerFixedExpenses(tenantId, ownerId, range.month, range.year),
    ownerEmptyMoveCharges(tenantId, ownerId, range),
  ]);
  return { fixedExpenses, emptyMoves, itemCount: fixedExpenses.length + emptyMoves.length };
}

const typeLabel = (t) => ({ insurance: 'Insurance', parking: 'Parking' }[t] || t);

/**
 * Write the review's charged lines into the owner's ledger for the month, retract the rest.
 * Idempotent: regenerating rewrites the same rows (by autoKey), never adds a second copy.
 */
async function syncOwnerAutoCharges({ tenantId, company, ownerId, range, review, userId }) {
  const wanted = new Map();
  review.fixedExpenses.filter((f) => !f.excluded && f.amount > 0).forEach((f) => {
    wanted.set(`fixed:${idStr(f._id)}`, {
      autoSource: 'truck_fixed_expense',
      truckExpense: f._id,
      category: f.type === 'parking' ? 'parking' : (f.type === 'insurance' ? 'insurance' : 'other'),
      amount: f.amount,
      currency: f.currency,
      notes: `${typeLabel(f.type)} — truck ${f.truck.number || ''} (fixed monthly)`.replace(/\s+/g, ' ').trim(),
      reference: '',
    });
  });
  review.emptyMoves.filter((m) => !m.ignored && !m.unmeasured && m.pay > 0).forEach((m) => {
    wanted.set(`empty:${idStr(m.driver?._id)}_${m.key}`, {
      autoSource: 'empty_move',
      truckExpense: null,
      category: 'empty_miles',
      amount: m.pay,
      currency: m.currency,
      notes: `Empty miles — ${m.driver?.name || 'driver'}, truck ${m.truck?.number || ''}: #${m.after_order_serial ?? ''} → #${m.before_order_serial ?? ''} (${Number(m.driverMiles || 0).toFixed(2)} mi @ ${m.rate}/mi)`.replace(/\s+/g, ' ').trim(),
      reference: '',
    });
  });

  const existing = await OwnerAdjustment.find({
    tenantId, ownerOperator: ownerId, month: range.month, year: range.year, autoKey: { $ne: null },
  });
  const byKey = new Map(existing.map((r) => [r.autoKey, r]));
  const date = new Date(Date.UTC(range.year, range.month - 1, 1));

  for (const [autoKey, line] of wanted) {
    const row = byKey.get(autoKey);
    if (row) {
      row.set({ ...line, kind: 'deduction', deletedAt: null, updatedBy: userId || row.updatedBy });
      if (row.isModified()) await row.save();
    } else {
      await OwnerAdjustment.create({
        tenantId, company: company || null, ownerOperator: ownerId,
        month: range.month, year: range.year, kind: 'deduction', date, autoKey,
        ...line, createdBy: userId || null,
      });
    }
  }
  // Taken off in review (or no longer real) ⇒ retracted.
  const retired = existing.filter((r) => !wanted.has(r.autoKey) && !r.deletedAt);
  for (const r of retired) {
    r.deletedAt = new Date();
    r.updatedBy = userId || r.updatedBy;
    await r.save();
  }
  return { written: wanted.size, retracted: retired.length };
}

module.exports = { ownerFixedExpenses, ownerAutoChargeReview, syncOwnerAutoCharges };
