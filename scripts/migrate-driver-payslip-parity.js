/**
 * Bring existing driver payslips onto the shared payslip math.
 *
 *   node backend/scripts/migrate-driver-payslip-parity.js [--apply] [--tenant=x]
 *
 * Dry run by default (reads only; prints exactly what would change).
 *
 * What it does, per payslip:
 *  1. Folds the deprecated `manualAddition` / `manualDeduction` scalars into real
 *     `DriverDeduction` line items, so the payslip's total is explained by rows the driver
 *     can read. Those two fields were a second adjustment channel with nothing behind them.
 *     Money does NOT move — the line is created to match the scalar already applied.
 *  2. Recomputes `finalPayable` / `dueAmount` / `owedAmount` / `overpaidAmount` /
 *     `paymentStatus` through utils/payslipMath, which rounds to 2dp and models a payslip
 *     whose deductions exceed its earnings (previously clamped to 0 and read as settled).
 *  3. Seeds a `DriverPayment` row for any payslip that already has a `paidAmount` but no
 *     payment history, so the new payments list is not empty on day one. The row is marked
 *     as migrated and carries no date — the original date was never recorded.
 *
 * Idempotent: a folded scalar is zeroed and the created line is keyed by
 * `reference: 'legacy-backfill'`; the seeded payment is keyed by `method: 'migrated'`.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const TENANT_ARG = (process.argv.find((a) => a.startsWith('--tenant=')) || '').split('=')[1] || null;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) {
    console.error('No DB_URL_OFFICE / MONGODB_URI in env');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}${TENANT_ARG ? ` tenant=${TENANT_ARG}` : ''}`);

  const DriverSalary = require('../db/DriverSalary');
  const DriverDeduction = require('../db/DriverDeduction');
  const DriverPayment = require('../db/DriverPayment');
  const { computePayslipTotals } = require('../utils/payslipMath');

  const filter = TENANT_ARG ? { tenantId: TENANT_ARG } : {};
  const salaries = await DriverSalary.find(filter).sort({ year: 1, month: 1 });
  console.log(`Payslips to inspect: ${salaries.length}`);

  const stats = { payslips: 0, scalarsFolded: 0, statusFixed: 0, owedSurfaced: 0, paymentsSeeded: 0, unchanged: 0 };

  for (const salary of salaries) {
    const tenantId = salary.tenantId;
    const currency = String(salary.currency || 'USD').toUpperCase();
    // Mid-month date so the row lands in this payslip's window regardless of month length.
    const anchor = new Date(salary.year, salary.month - 1, 15);

    // 1. Fold the unexplained scalars into line items.
    let foldedAddition = 0;
    let foldedDeduction = 0;
    for (const [field, direction, type] of [
      ['manualAddition', 'add', 'bonus'],
      ['manualDeduction', 'deduct', 'other'],
    ]) {
      const value = round2(salary[field]);
      if (value <= 0.01) continue;
      stats.scalarsFolded += 1;
      console.log(
        `  [fold] ${tenantId} driver=${salary.driver} ${salary.month}/${salary.year} ` +
        `${field} ${value} ${currency} -> ${direction} line`
      );
      if (direction === 'add') foldedAddition += value; else foldedDeduction += value;
      if (APPLY) {
        const already = await DriverDeduction.findOne({
          tenantId, driver: salary.driver, direction, reference: 'legacy-backfill',
          date: { $gte: new Date(salary.year, salary.month - 1, 1), $lte: new Date(salary.year, salary.month, 0, 23, 59, 59, 999) },
        }).lean();
        if (!already) {
          await DriverDeduction.create({
            tenantId,
            company: salary.company || null,
            driver: salary.driver,
            type,
            direction,
            amount: value,
            // The scalar was denominated in the payslip's own currency.
            currency,
            description: `Legacy ${direction === 'add' ? 'addition' : 'deduction'} carried over from before adjustments were itemized`,
            reference: 'legacy-backfill',
            date: anchor,
            createdBy: salary.generatedBy || null,
            updatedBy: salary.generatedBy || null,
          });
        }
        salary[field] = 0;
      }
    }

    // 2. Recompute. The folded amounts join `additionTotal` (additions) and are taken off as
    //    deductions — exactly what the scalars were doing, now with rows behind them.
    const beforeStatus = salary.paymentStatus;
    const beforeFinal = round2(salary.finalPayable);
    const totals = computePayslipTotals({
      basePayable: salary.basePayable,
      previousDueAdded: salary.previousDueAdded,
      previousOwedDeducted: salary.previousOwedDeducted,
      additions: round2(salary.additionTotal) + foldedAddition,
      deductions: foldedDeduction,
      paidAmount: salary.paidAmount,
    });
    salary.finalPayable = totals.finalPayable;
    salary.paidAmount = totals.paidAmount;
    salary.dueAmount = totals.dueAmount;
    salary.owedAmount = totals.owedAmount;
    salary.overpaidAmount = totals.overpaidAmount;
    salary.paymentStatus = totals.paymentStatus;
    stats.payslips += 1;

    const statusChanged = beforeStatus !== totals.paymentStatus;
    const finalChanged = Math.abs(beforeFinal - totals.finalPayable) > 0.01;
    if (statusChanged) {
      stats.statusFixed += 1;
      console.log(
        `  [status] ${tenantId} driver=${salary.driver} ${salary.month}/${salary.year}: ` +
        `${beforeStatus} -> ${totals.paymentStatus} (final ${beforeFinal} -> ${totals.finalPayable}, paid ${totals.paidAmount})`
      );
    }
    if (totals.owedAmount > 0) stats.owedSurfaced += 1;
    if (totals.overpaidAmount > 0) {
      console.log(
        `  [overpaid] ${tenantId} driver=${salary.driver} ${salary.month}/${salary.year}: ` +
        `${totals.overpaidAmount} ${currency} paid above payable`
      );
    }
    if (!statusChanged && !finalChanged) stats.unchanged += 1;

    // 3. Seed payment history for an already-paid payslip.
    if (round2(salary.paidAmount) > 0) {
      const existingPayments = await DriverPayment.countDocuments({ tenantId, salary: salary._id });
      if (existingPayments === 0) {
        stats.paymentsSeeded += 1;
        if (APPLY) {
          await DriverPayment.create({
            tenantId,
            company: salary.company || null,
            driver: salary.driver,
            salary: salary._id,
            month: salary.month,
            year: salary.year,
            amount: round2(salary.paidAmount),
            currency,
            inputAmount: round2(salary.paidAmount),
            inputCurrency: currency,
            fxRate: 1,
            date: null,
            notes: 'Recorded before payments were itemized — original date unknown',
            method: 'migrated',
            createdBy: salary.generatedBy || null,
          });
        }
      }
    }

    if (APPLY) await salary.save();
  }

  console.log('\n--- Summary ---');
  console.log(`Payslips processed:        ${stats.payslips}`);
  console.log(`Manual scalars folded:     ${stats.scalarsFolded}`);
  console.log(`paymentStatus corrected:   ${stats.statusFixed}`);
  console.log(`Payslips now 'owed':       ${stats.owedSurfaced}`);
  console.log(`Payment rows seeded:       ${stats.paymentsSeeded}`);
  console.log(`Untouched:                 ${stats.unchanged}`);
  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
