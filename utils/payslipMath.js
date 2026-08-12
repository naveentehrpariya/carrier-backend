// The one definition of what a payslip's balance means — owner operator AND driver.
//
// Both payrolls had grown their own copy of these six lines, and both copies were wrong in
// their own way: the owner's marked a deduction-zeroed payslip `paid`, the driver's clamped
// an overpayment down and reported success. Neither modelled a payslip whose deductions
// exceed its earnings, which is an ordinary month in trucking (escrow, a lease payment, a
// damage claim), not an error.

// Money is compared and stored at 2dp. A raw float subtraction leaves 1e-13 residue that
// makes `dueAmount === 0` false and keeps a fully-paid payslip `partial` forever.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Anything under half a cent is zero for status purposes.
const EPSILON = 0.005;

/**
 * @param {object} input
 * @param {number} input.basePayable          what the period earned, before carry-forward
 * @param {number} input.previousDueAdded     unpaid balance carried IN from last period
 * @param {number} input.previousOwedDeducted negative balance carried IN from last period
 * @param {number} input.additions            itemized additions, in the payslip currency
 * @param {number} input.deductions           itemized deductions, in the payslip currency
 * @param {number} input.paidAmount           paid to date, in the payslip currency
 */
function computePayslipTotals(input) {
  const basePayable = round2(input?.basePayable);
  const previousDueAdded = round2(input?.previousDueAdded);
  const previousOwedDeducted = round2(input?.previousOwedDeducted);
  const additions = round2(input?.additions);
  const deductions = round2(input?.deductions);
  const paidAmount = round2(input?.paidAmount);

  const finalPayable = round2(
    basePayable + previousDueAdded - previousOwedDeducted + additions - deductions
  );

  // A NEGATIVE payslip is a real state: the worker owes the company. Clamping it to zero
  // and reading that as "paid" silently forgave the balance at period end.
  const owedAmount = finalPayable < -EPSILON ? round2(-finalPayable) : 0;
  const payableFloor = Math.max(finalPayable, 0);
  // Paid can exceed a payable that a later deduction reduced. That excess is money to claw
  // back, so it is reported rather than hidden by a clamp.
  const overpaidAmount = paidAmount - payableFloor > EPSILON ? round2(paidAmount - payableFloor) : 0;
  const dueAmount = round2(Math.max(payableFloor - paidAmount, 0));

  let paymentStatus;
  if (owedAmount > 0) paymentStatus = 'owed';
  else if (finalPayable <= EPSILON && paidAmount <= EPSILON) paymentStatus = 'pending';
  else if (dueAmount <= EPSILON && finalPayable > EPSILON) paymentStatus = 'paid';
  else if (paidAmount > EPSILON) paymentStatus = 'partial';
  else paymentStatus = 'pending';

  return {
    basePayable,
    previousDueAdded,
    previousOwedDeducted,
    additions,
    deductions,
    finalPayable,
    paidAmount,
    dueAmount,
    owedAmount,
    overpaidAmount,
    paymentStatus,
  };
}

// The immediately previous period only — a skipped month must not resurrect an old balance.
function previousMonthOf(month, year) {
  return {
    month: Number(month) === 1 ? 12 : Number(month) - 1,
    year: Number(month) === 1 ? Number(year) - 1 : Number(year),
  };
}

module.exports = { round2, EPSILON, computePayslipTotals, previousMonthOf };
