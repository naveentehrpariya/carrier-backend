const mongoose = require('mongoose');

const EXPENSE_TYPES = ['fuel', 'toll', 'service', 'insurance', 'parking', 'other'];
const PAID_BY = ['driver', 'owner'];

const truckExpenseSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
  truck: { type: mongoose.Schema.Types.ObjectId, ref: 'trucks', required: true, index: true },
  type: { type: String, enum: EXPENSE_TYPES, required: true },
  amount: { type: Number, required: true, min: 0 },
  // Currency the amount was entered in. Legacy rows have none and are read as USD, which is how
  // they were always displayed. Reports convert from this once into the display currency.
  currency: { type: String, enum: ['USD', 'CAD', 'INR'], default: 'USD', uppercase: true },
  paid_by: { type: String, enum: PAID_BY, default: 'owner' },
  // Who fronted the money when `paid_by === 'driver'`. Required in that case: without it the
  // expense says a driver paid out of pocket but not WHICH driver, so nobody can be paid back.
  // A driver-paid expense creates a matching reimbursement line on that driver's payslip
  // (DriverDeduction, direction 'add', autoSource 'truck_expense'); the expense is still a
  // cost against the truck, because it is.
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null, index: true },
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
