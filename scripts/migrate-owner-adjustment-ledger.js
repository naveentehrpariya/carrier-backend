/**
 * Backfill the itemized owner-operator adjustment ledger.
 *
 *   node backend/scripts/migrate-owner-adjustment-ledger.js [--apply] [--tenant=x]
 *
 * Dry run by default (reads only; prints exactly what would change).
 *
 * What it does, per payslip:
 *  1. Turns every existing `OwnerOperatorFinancialRecord` of type ADJUSTMENT into an
 *     `OwnerAdjustment` line, and links the record back to the line via `meta.adjustmentId`.
 *  2. Where the payslip's `manualAddition` / `manualDeduction` scalar is LARGER than the
 *     line items found, writes one balancing "Legacy adjustment" line for the difference.
 *     That gap is the old bug: `updateSalaryAdjustments` set the scalar without creating a
 *     record, so the statement showed a deduction nothing explained. Money does NOT move —
 *     the line is created to match the scalar the owner was already paid against.
 *  3. Recomputes the payslip through utils/ownerSalaryMath so `paymentStatus` obeys the
 *     `finalPayable > 0` rule. A payslip zeroed by deductions and wrongly stamped `paid`
 *     becomes `pending` (or `owed` when deductions exceeded earnings).
 *
 * Idempotent: a record already carrying `meta.adjustmentId` is skipped, and the balancing
 * line is keyed by `reference: 'legacy-backfill'`.
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

  const OwnerOperatorSalary = require('../db/OwnerOperatorSalary');
  const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');
  const OwnerAdjustment = require('../db/OwnerAdjustment');
  const { getFxRatesMap } = require('../utils/fx');
  const { applyLedgerToSalary } = require('../utils/ownerSalaryMath');

  const salaryFilter = TENANT_ARG ? { tenantId: TENANT_ARG } : {};
  const salaries = await OwnerOperatorSalary.find(salaryFilter).sort({ year: 1, month: 1 });
  console.log(`Payslips to inspect: ${salaries.length}`);

  const stats = {
    payslips: 0,
    linesFromRecords: 0,
    balancingLines: 0,
    statusFixed: 0,
    owedSurfaced: 0,
    unchanged: 0,
  };

  for (const salary of salaries) {
    const tenantId = salary.tenantId;
    const currency = String(salary.currency || 'USD').toUpperCase();

    // 1. Existing itemized records for this payslip.
    const records = await OwnerOperatorFinancialRecord.find({
      tenantId,
      type: 'ADJUSTMENT',
      $or: [
        { salary: salary._id },
        { ownerOperator: salary.ownerOperator, month: salary.month, year: salary.year },
      ],
    }).lean();

    for (const rec of records) {
      if (rec?.meta?.adjustmentId) continue; // already migrated
      const kind = String(rec?.meta?.expenseType || '').toLowerCase() === 'addition' ? 'addition' : 'deduction';
      const payload = {
        tenantId,
        company: rec.company || salary.company || null,
        ownerOperator: salary.ownerOperator,
        salary: salary._id,
        month: salary.month,
        year: salary.year,
        kind,
        category: 'other',
        amount: round2(rec?.meta?.inputAmount || rec.amount),
        currency: String(rec?.meta?.inputCurrency || rec.currency || currency).toUpperCase(),
        amountInSalaryCurrency: round2(rec.amount),
        salaryCurrency: String(rec.currency || currency).toUpperCase(),
        fxRate: Number(rec?.meta?.conversionRate || 1),
        date: rec.date || rec.createdAt || null,
        notes: rec.notes || 'Migrated adjustment',
        reference: 'legacy-record',
        createdBy: rec.createdBy || null,
      };
      stats.linesFromRecords += 1;
      if (APPLY) {
        const created = await OwnerAdjustment.create(payload);
        await OwnerOperatorFinancialRecord.updateOne(
          { _id: rec._id },
          { $set: { salary: salary._id, 'meta.adjustmentId': created._id, 'meta.category': 'other' } }
        );
      }
    }

    // 2. Scalar vs line items.
    const existingLines = APPLY
      ? await OwnerAdjustment.find({
          tenantId, ownerOperator: salary.ownerOperator, month: salary.month, year: salary.year, deletedAt: null,
        }).lean()
      : [];
    const recordSum = (kind) =>
      records
        .filter((r) => (String(r?.meta?.expenseType || '').toLowerCase() === 'addition' ? 'addition' : 'deduction') === kind)
        .reduce((a, r) => a + Number(r.amount || 0), 0);

    for (const kind of ['addition', 'deduction']) {
      const scalar = round2(kind === 'addition' ? salary.manualAddition : salary.manualDeduction);
      const itemized = round2(
        APPLY
          ? existingLines.filter((l) => l.kind === kind).reduce((a, l) => a + Number(l.amountInSalaryCurrency || 0), 0)
          : recordSum(kind)
      );
      const gap = round2(scalar - itemized);
      if (gap <= 0.01) continue;
      const already = APPLY
        ? existingLines.some((l) => l.kind === kind && l.reference === 'legacy-backfill')
        : false;
      if (already) continue;
      stats.balancingLines += 1;
      console.log(
        `  [gap] ${salary.tenantId} owner=${salary.ownerOperator} ${salary.month}/${salary.year} ` +
        `${kind}: scalar ${scalar} vs items ${itemized} -> balancing line ${gap} ${currency}`
      );
      if (APPLY) {
        await OwnerAdjustment.create({
          tenantId,
          company: salary.company || null,
          ownerOperator: salary.ownerOperator,
          salary: salary._id,
          month: salary.month,
          year: salary.year,
          kind,
          category: 'other',
          amount: gap,
          currency,
          amountInSalaryCurrency: gap,
          salaryCurrency: currency,
          fxRate: 1,
          date: salary.generatedAt || salary.createdAt || null,
          notes: `Legacy ${kind} carried over from before adjustments were itemized`,
          reference: 'legacy-backfill',
          createdBy: salary.generatedBy || null,
        });
      }
    }

    // 3. Recompute status/derived columns.
    const beforeStatus = salary.paymentStatus;
    const beforeFinal = round2(salary.finalPayable);
    const fxMap = await getFxRatesMap(tenantId, salary.month, salary.year, currency);
    const ledger = APPLY
      ? await OwnerAdjustment.find({
          tenantId, ownerOperator: salary.ownerOperator, month: salary.month, year: salary.year, deletedAt: null,
        }).lean()
      : [
          ...records.map((r) => ({
            kind: String(r?.meta?.expenseType || '').toLowerCase() === 'addition' ? 'addition' : 'deduction',
            amount: r.amount,
            currency: r.currency || currency,
            amountInSalaryCurrency: r.amount,
            salaryCurrency: r.currency || currency,
            fxRate: 1,
          })),
          // Mirror the balancing lines a real run would create, so the dry run reports the
          // same status change --apply would make.
          ...['addition', 'deduction']
            .map((kind) => {
              const gap = round2((kind === 'addition' ? salary.manualAddition : salary.manualDeduction) - recordSum(kind));
              return gap > 0.01
                ? { kind, amount: gap, currency, amountInSalaryCurrency: gap, salaryCurrency: currency, fxRate: 1 }
                : null;
            })
            .filter(Boolean),
        ];

    const { totals } = applyLedgerToSalary(salary, ledger, fxMap);
    stats.payslips += 1;

    const statusChanged = beforeStatus !== totals.paymentStatus;
    const finalChanged = Math.abs(beforeFinal - totals.finalPayable) > 0.01;
    if (statusChanged) {
      stats.statusFixed += 1;
      console.log(
        `  [status] ${salary.tenantId} owner=${salary.ownerOperator} ${salary.month}/${salary.year}: ` +
        `${beforeStatus} -> ${totals.paymentStatus} (final ${beforeFinal} -> ${totals.finalPayable}, paid ${totals.paidAmount})`
      );
    }
    if (totals.owedAmount > 0) stats.owedSurfaced += 1;
    if (!statusChanged && !finalChanged) stats.unchanged += 1;

    if (APPLY) await salary.save();
  }

  console.log('\n--- Summary ---');
  console.log(`Payslips processed:        ${stats.payslips}`);
  console.log(`Lines from old records:    ${stats.linesFromRecords}`);
  console.log(`Balancing (legacy) lines:  ${stats.balancingLines}`);
  console.log(`paymentStatus corrected:   ${stats.statusFixed}`);
  console.log(`Payslips now 'owed':       ${stats.owedSurfaced}`);
  console.log(`Untouched:                 ${stats.unchanged}`);
  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
