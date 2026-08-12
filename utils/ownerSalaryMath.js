// Owner-operator payslip arithmetic — ONE definition, used by every write path
// (generate, adjustment CRUD, payment, statement, PDF).
//
// Before this file the same six lines were copy-pasted into five handlers and had already
// drifted: four of them marked a payslip `paid` whenever `dueAmount === 0`, with no
// `finalPayable > 0` guard, so a deduction that zeroed the payslip reported it as PAID
// without a cent being sent.

const { convertAmount, normalizeCurrency } = require('./fx');
const { round2, EPSILON, computePayslipTotals } = require('./payslipMath');

const ADJUSTMENT_CATEGORIES = {
  addition: [
    { value: 'bonus', label: 'Bonus' },
    { value: 'reimbursement', label: 'Reimbursement' },
    { value: 'fuel_credit', label: 'Fuel Credit' },
    { value: 'detention', label: 'Detention / Layover' },
    { value: 'escrow_return', label: 'Escrow Return' },
    { value: 'other', label: 'Other' },
  ],
  deduction: [
    { value: 'advance', label: 'Advance' },
    { value: 'fuel', label: 'Fuel' },
    { value: 'insurance', label: 'Insurance' },
    { value: 'escrow', label: 'Escrow Hold' },
    { value: 'repair', label: 'Repair / Maintenance' },
    { value: 'lease', label: 'Lease / Truck Payment' },
    { value: 'permit', label: 'Permits & Licensing' },
    { value: 'ifta', label: 'IFTA / Fuel Tax' },
    { value: 'damage', label: 'Damage / Claim' },
    { value: 'fine', label: 'Fine / Violation' },
    { value: 'other', label: 'Other' },
  ],
};

const ADJUSTMENT_CATEGORY_VALUES = Array.from(
  new Set([...ADJUSTMENT_CATEGORIES.addition, ...ADJUSTMENT_CATEGORIES.deduction].map((c) => c.value))
);

function categoryLabel(kind, value) {
  const list = ADJUSTMENT_CATEGORIES[kind] || [];
  const hit = list.find((c) => c.value === value);
  if (hit) return hit.label;
  const any = [...ADJUSTMENT_CATEGORIES.addition, ...ADJUSTMENT_CATEGORIES.deduction].find((c) => c.value === value);
  return any ? any.label : 'Other';
}

function isValidCategory(kind, value) {
  return (ADJUSTMENT_CATEGORIES[kind] || []).some((c) => c.value === value);
}

// Convert one ledger row into the payslip currency.
// Prefers the stored snapshot when the row was already converted into THIS currency —
// re-converting a stored value at today's map is how a CA$602.67 deduction lands as
// CA$601.05 (the stored monthly pairs are not exact reciprocals).
function convertAdjustment(row, targetCurrency, fxMap) {
  const target = normalizeCurrency(targetCurrency, 'USD');
  const source = normalizeCurrency(row?.currency, target);
  const snapshotCurrency = normalizeCurrency(row?.salaryCurrency, '');
  if (snapshotCurrency === target && Number(row?.amountInSalaryCurrency || 0) > 0) {
    return { value: round2(row.amountInSalaryCurrency), rate: Number(row.fxRate || 1), source, target };
  }
  const conv = convertAmount(Number(row?.amount || 0), source, target, fxMap);
  return { value: round2(conv.value), rate: Number(conv.rate || 1), source, target };
}

// Sum a month's ledger into { addition, deduction } in the payslip currency, and return
// each row decorated with its converted value so the UI/PDF print the same number the
// total was built from.
function sumAdjustments(rows, targetCurrency, fxMap) {
  const target = normalizeCurrency(targetCurrency, 'USD');
  let addition = 0;
  let deduction = 0;
  const decorated = (rows || []).map((row) => {
    const conv = convertAdjustment(row, target, fxMap);
    if (row?.kind === 'addition') addition += conv.value;
    else deduction += conv.value;
    return {
      ...(row?.toObject ? row.toObject() : row),
      convertedAmount: conv.value,
      convertedCurrency: target,
      appliedFxRate: conv.rate,
      categoryLabel: categoryLabel(row?.kind, row?.category),
    };
  });
  return { addition: round2(addition), deduction: round2(deduction), rows: decorated };
}

// The payslip identity. Every caller must go through this — it is the only place that
// decides what "paid" means.
//
//   finalPayable = base − driverPay + prevDue − prevOwed + additions − deductions
//
// A NEGATIVE finalPayable is a real state, not an error: deductions (escrow, damage, a
// lease payment in a light month) can exceed what the owner earned. The old code clamped
// `dueAmount` to 0 and then read that as "paid", so the company silently forgave the
// balance. It is now surfaced as `owedAmount` and carried into the next month.
function computeSalaryTotals(input) {
  const totalDriverDeduction = round2(input?.totalDriverDeduction);
  // Driver cost is a deduction like any other as far as the balance is concerned; it is
  // kept as its own column because the statement prints it on its own line.
  const totals = computePayslipTotals({
    basePayable: input?.basePayable,
    previousDueAdded: input?.previousDueAdded,
    previousOwedDeducted: input?.previousOwedDeducted,
    additions: input?.manualAddition,
    deductions: round2(input?.manualDeduction) + totalDriverDeduction,
    paidAmount: input?.paidAmount,
  });
  return {
    ...totals,
    totalDriverDeduction,
    manualAddition: totals.additions,
    manualDeduction: round2(totals.deductions - totalDriverDeduction),
  };
}

// `basePayable` on a legacy payslip may be absent — fall back the same way every handler
// used to, in one place.
function resolveBasePayable(salary) {
  if (salary?.basePayable != null) return round2(salary.basePayable);
  if (salary?.totalSettleAmount != null) return round2(salary.totalSettleAmount);
  return round2(Number(salary?.totalOwnerProfit || 0) - Number(salary?.totalDriverDeduction || 0));
}

// Recompute a payslip document from its ledger and assign the derived columns.
// Mutates `salary` (a mongoose doc or a plain object) and returns the totals.
function applyLedgerToSalary(salary, ledgerRows, fxMap) {
  const currency = normalizeCurrency(salary?.currency, 'USD');
  const sums = sumAdjustments(ledgerRows, currency, fxMap);
  const totals = computeSalaryTotals({
    basePayable: resolveBasePayable(salary),
    totalDriverDeduction: salary?.totalDriverDeduction,
    previousDueAdded: salary?.previousDueAdded,
    previousOwedDeducted: salary?.previousOwedDeducted,
    manualAddition: sums.addition,
    manualDeduction: sums.deduction,
    paidAmount: salary?.paidAmount,
  });

  salary.basePayable = totals.basePayable;
  salary.manualAddition = totals.manualAddition;
  salary.manualDeduction = totals.manualDeduction;
  salary.finalPayable = totals.finalPayable;
  salary.dueAmount = totals.dueAmount;
  salary.owedAmount = totals.owedAmount;
  salary.overpaidAmount = totals.overpaidAmount;
  salary.paymentStatus = totals.paymentStatus;

  return { totals, adjustments: sums.rows };
}

module.exports = {
  round2,
  EPSILON,
  ADJUSTMENT_CATEGORIES,
  ADJUSTMENT_CATEGORY_VALUES,
  categoryLabel,
  isValidCategory,
  convertAdjustment,
  sumAdjustments,
  computeSalaryTotals,
  resolveBasePayable,
  applyLedgerToSalary,
};
