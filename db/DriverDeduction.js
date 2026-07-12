const mongoose = require('mongoose');

// Covers both additions (city hours, bonuses) and deductions (advance, fine, insurance)
const DEDUCTION_TYPES = ['city_hours', 'advance', 'fine', 'insurance', 'other'];
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
  date: { type: Date, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

driverDeductionSchema.index({ tenantId: 1, driver: 1, date: -1 });

const DriverDeduction = mongoose.model('driver_deductions', driverDeductionSchema);
module.exports = DriverDeduction;
