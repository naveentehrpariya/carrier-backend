const mongoose = require('mongoose');

// Covers both additions and deductions; `direction` decides which way the money moves, so
// this is one flat list. Brought to parity with the owner-operator ledger — five categories
// meant almost every real entry was filed as "other", which tells the driver nothing about
// why their pay changed.
const ADDITION_TYPES = ['city_hours', 'bonus', 'reimbursement', 'detention', 'escrow_return'];
const DEDUCT_TYPES = ['advance', 'fuel', 'insurance', 'escrow', 'repair', 'lease', 'permit', 'ifta', 'damage', 'fine'];
const DEDUCTION_TYPES = Array.from(new Set([...ADDITION_TYPES, ...DEDUCT_TYPES, 'other']));
// direction: 'add' = increases pay, 'deduct' = reduces pay
const DIRECTIONS = ['add', 'deduct'];

const driverDeductionSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
  type: { type: String, enum: DEDUCTION_TYPES, required: true },
  direction: { type: String, enum: DIRECTIONS, required: true },
  amount: { type: Number, required: true, min: 0 },
  // Currency `amount`/`rate` are denominated in — snapshotted from the driver's locked
  // rateCurrency at entry time so a later payslip converts it from the right base.
  // Legacy rows have no value: they were always USD, hence the default.
  currency: { type: String, enum: ['USD', 'CAD', 'INR'], default: 'USD' },
  // For city_hours: hours worked (amount = hours * rate is computed on read)
  hours: { type: Number, default: null },
  rate: { type: Number, default: null }, // rate at time of entry
  description: { type: String, default: '' },
  // Receipt / cheque / invoice number. Optional, printed on the payslip beside the reason.
  reference: { type: String, default: '' },
  date: { type: Date, required: true },

  // Repeats into the next month when that month's payslip is generated. Insurance, escrow
  // and a lease payment recur every month; retyping them is how one gets missed.
  recurring: { type: Boolean, default: false },
  // Set on a copy so the same template is never cloned twice into one month.
  recurringSourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'driver_deductions', default: null, index: true },

  // A row this system created on the driver's behalf, rather than one an admin typed.
  // `truck_expense` rows reimburse a TruckExpense the driver paid out of pocket; they are
  // kept in step with that expense and must not be edited by hand (edit the expense).
  autoSource: { type: String, enum: [null, 'truck_expense'], default: null },
  truckExpense: { type: mongoose.Schema.Types.ObjectId, ref: 'truck_expenses', default: null, index: true },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  createdAt: { type: Date, default: Date.now },
  // Bumped on every edit. The payslip snapshots these rows, so a row touched after the payslip
  // was generated is what makes that payslip out of date — without a timestamp there is no way
  // to tell, and the driver gets a statement that no longer matches the ledger.
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
  deletedAt: { type: Date, default: null }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

driverDeductionSchema.index({ tenantId: 1, driver: 1, date: -1 });
// One reimbursement row per truck expense — the guard against paying a receipt twice.
driverDeductionSchema.index({ tenantId: 1, truckExpense: 1 }, { sparse: true });

const DriverDeduction = mongoose.model('driver_deductions', driverDeductionSchema);
module.exports = DriverDeduction;
module.exports.DEDUCTION_TYPES = DEDUCTION_TYPES;
module.exports.ADDITION_TYPES = ADDITION_TYPES;
module.exports.DEDUCT_TYPES = DEDUCT_TYPES;
