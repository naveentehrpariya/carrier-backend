const mongoose = require('mongoose');

// One recorded payment against a driver's payslip.
//
// The driver payslip used to hold a single `paidAmount` number: no date, no reference, no
// way to see that "3,000" was two transfers a fortnight apart, and no way to reverse a
// typo without editing the total by hand. The owner-operator side has had per-payment rows
// all along; this brings the driver side to the same footing.
//
// `paidAmount` on DriverSalary stays the running total and is kept in step by the
// controller — this collection is the record of HOW it got there.
const driverPaymentSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies', default: null },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    salary: { type: mongoose.Schema.Types.ObjectId, ref: 'driversalaries', required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true, min: 2000, max: 9999 },

    // Converted into the payslip's currency — what the balance is settled in.
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    // The exact typed figure and its currency, kept beside the converted one (same rule as
    // an order's input_total_amount): never store only the converted number.
    inputAmount: { type: Number, default: 0 },
    inputCurrency: { type: String, default: 'USD' },
    fxRate: { type: Number, default: 1 },

    date: { type: Date, default: null },
    notes: { type: String, default: '' },
    method: { type: String, default: '' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
  },
  { timestamps: true }
);

driverPaymentSchema.index({ tenantId: 1, driver: 1, year: 1, month: 1 });

module.exports = mongoose.model('driver_payments', driverPaymentSchema);
