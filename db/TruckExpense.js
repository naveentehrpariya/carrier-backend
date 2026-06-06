const mongoose = require('mongoose');

const EXPENSE_TYPES = ['fuel', 'toll', 'service', 'insurance', 'parking', 'other'];
const PAID_BY = ['driver', 'owner'];

const truckExpenseSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
  truck: { type: mongoose.Schema.Types.ObjectId, ref: 'trucks', required: true, index: true },
  type: { type: String, enum: EXPENSE_TYPES, required: true },
  amount: { type: Number, required: true, min: 0 },
  paid_by: { type: String, enum: PAID_BY, default: 'owner' },
  description: { type: String, default: '' },
  date: { type: Date, required: true },
  // Month/year used to de-duplicate auto-generated fixed expenses
  fixedMonth: { type: Number, default: null },  // 0-11
  fixedYear: { type: Number, default: null },
  isFixed: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

truckExpenseSchema.index({ tenantId: 1, truck: 1, date: -1 });
truckExpenseSchema.index({ tenantId: 1, truck: 1, fixedMonth: 1, fixedYear: 1, type: 1 });

const TruckExpense = mongoose.model('truck_expenses', truckExpenseSchema);
module.exports = TruckExpense;
