const mongoose = require('mongoose');
const { ADJUSTMENT_CATEGORY_VALUES } = require('../utils/ownerSalaryMath');

// One typed line of an owner operator's monthly additions/deductions.
//
// This collection is the SOURCE OF TRUTH. `OwnerOperatorSalary.manualAddition` /
// `.manualDeduction` are derived columns recomputed from these rows on every write
// (see utils/ownerSalaryMath.js#applyLedgerToSalary) — never typed directly. The old
// behaviour let a scalar be overwritten while the itemized rows stayed put, so a
// statement could show a deduction that no line item explained.
//
// `amount` + `currency` are the EXACT typed values (same rule as an order's
// `input_total_amount`). `amountInSalaryCurrency` is the converted snapshot at the
// month's FX, so the payslip never re-converts and drifts.
const ownerAdjustmentSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies', default: null },
    ownerOperator: { type: mongoose.Schema.Types.ObjectId, ref: 'owneroperators', required: true, index: true },
    // The payslip this row settles on. Nullable on purpose: a row may be entered before
    // the month's payslip is generated, and gets linked when it is.
    salary: { type: mongoose.Schema.Types.ObjectId, ref: 'owneroperatorsalaries', default: null, index: true },
    month: { type: Number, required: true, min: 1, max: 12, index: true },
    year: { type: Number, required: true, min: 2000, max: 9999, index: true },

    kind: { type: String, enum: ['addition', 'deduction'], required: true, index: true },
    category: { type: String, enum: ADJUSTMENT_CATEGORY_VALUES, default: 'other', index: true },

    // Exact typed amount and the currency it was typed in.
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    // Converted snapshot in the payslip's currency + the rate used (audit).
    amountInSalaryCurrency: { type: Number, default: 0 },
    salaryCurrency: { type: String, default: 'USD' },
    fxRate: { type: Number, default: 1 },

    date: { type: Date, default: null },
    notes: { type: String, default: '' },
    reference: { type: String, default: '' },

    // Repeats into the next month when that month's payslip is generated.
    recurring: { type: Boolean, default: false },
    // Set on a copy so the same template is never cloned twice into one month.
    recurringSourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'owneradjustments', default: null, index: true },

    attachmentUrl: { type: String, default: '' },
    attachmentName: { type: String, default: '' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    // Soft delete, like the rest of the app. A hard delete would silently rewrite a
    // payslip a client already received with no trace of what was removed.
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

ownerAdjustmentSchema.index({ tenantId: 1, ownerOperator: 1, year: 1, month: 1, deletedAt: 1 });
ownerAdjustmentSchema.index({ tenantId: 1, salary: 1 });

module.exports = mongoose.model('owneradjustments', ownerAdjustmentSchema);
