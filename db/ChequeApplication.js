const mongoose = require('mongoose');

// What a cheque actually paid for. One row per target the cheque was applied
// to — the difference between the cheque amount and the sum of these rows is
// the "unapplied" balance the register shows.
//
// Applying is not just bookkeeping: an order application marks the order's
// carrier payment, and a payslip application records a real payment row in
// that payroll (DriverPayment / OwnerOperatorFinancialRecord). The link ids
// below are what lets removing the application reverse exactly what it did —
// and nothing else.
const TARGET_TYPES = ['order_carrier', 'driver_salary', 'owner_salary'];

const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },

    cheque: { type: mongoose.Schema.Types.ObjectId, ref: 'payment_cheques', required: true, index: true },
    chequeNo: { type: String, required: true },

    targetType: { type: String, enum: TARGET_TYPES, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Human-readable snapshot ("Order #1013", "Payslip 8/2026") — survives the
    // target being renamed or deleted.
    targetLabel: { type: String, required: true, trim: true },

    // In the CHEQUE's currency. Payroll conversion happens inside the payroll
    // write and is recorded there.
    amount: { type: Number, required: true, min: [0.01, 'Amount must be greater than zero.'] },
    currency: { type: String, enum: ['USD', 'CAD', 'INR'], required: true },
    note: { type: String, trim: true, default: '' },

    // What the application wrote elsewhere, for exact reversal.
    driverPayment: { type: mongoose.Schema.Types.ObjectId, ref: 'driver_payments', default: null },
    ownerRecord: { type: mongoose.Schema.Types.ObjectId, default: null },

    createdAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    deletedAt: { type: Date },
});

schema.index({ tenantId: 1, targetType: 1, targetId: 1 });

const ChequeApplication = mongoose.model('cheque_applications', schema);
ChequeApplication.TARGET_TYPES = TARGET_TYPES;
module.exports = ChequeApplication;
