const mongoose = require('mongoose');

const orderBreakdownSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', required: true },
    serial_no: { type: Number, default: null },
    // Written by generateMonthlySalary but previously absent from this schema, so mongoose
    // stripped them on save and the payslip lost the customer's own order number and the
    // rate currency — the popup then printed a converted rate that doesn't multiply back.
    customer_order_no: { type: String, default: null },
    orderPrice: { type: Number, default: 0 },
    settleAmount: { type: Number, default: 0 },
    ownerProfit: { type: Number, default: 0 },
    driverDeduction: { type: Number, default: 0 },
    payable: { type: Number, default: 0 },
    sourceCurrency: { type: String, default: 'USD' },
    targetCurrency: { type: String, default: 'USD' },
    fxRate: { type: Number, default: 1 },
    originalOrderPrice: { type: Number, default: 0 },
    originalSettleAmount: { type: Number, default: 0 },
    originalOwnerProfit: { type: Number, default: 0 },
    originalDriverDeduction: { type: Number, default: 0 },
    originalPayable: { type: Number, default: 0 },
    driverCount: { type: Number, default: 0 },
    driverRateType: { type: String, enum: ['solo', 'team', 'mixed', 'none'], default: 'none' },
    driverMiles: { type: Number, default: 0 },
    driverAvgRate: { type: Number, default: 0 },
    // The rate the driver is actually contracted at, in the currency it was agreed in.
    // A per-unit rate is never printed live-converted (0.39 USD/mi becomes "0.55 CAD/mi",
    // which no longer multiplies back to the pay beside it).
    originalDriverAvgRate: { type: Number, default: 0 },
    driverRateCurrency: { type: String, default: 'USD' },
  },
  { _id: false }
);

const ownerOperatorSalarySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    ownerOperator: { type: mongoose.Schema.Types.ObjectId, ref: 'owneroperators', required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12, index: true },
    year: { type: Number, required: true, min: 2000, max: 9999, index: true },
    currency: { type: String, default: 'USD' },
    totalOrders: { type: Number, default: 0 },
    totalOrderValue: { type: Number, default: 0 },
    totalSettleAmount: { type: Number, default: 0 },
    totalOwnerProfit: { type: Number, default: 0 },
    totalDriverDeduction: { type: Number, default: 0 },
    basePayable: { type: Number, default: 0 },
    previousDueAdded: { type: Number, default: 0 },
    // Prior month's `owedAmount` carried in as a deduction. Without it a negative payslip
    // was silently forgiven — the balance simply disappeared at month end.
    previousOwedDeducted: { type: Number, default: 0 },
    // DERIVED from the OwnerAdjustment ledger — never typed. See utils/ownerSalaryMath.js.
    manualDeduction: { type: Number, default: 0 },
    manualAddition: { type: Number, default: 0 },
    finalPayable: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    dueAmount: { type: Number, default: 0 },
    // finalPayable < 0: deductions exceeded earnings, so the OWNER owes the company.
    owedAmount: { type: Number, default: 0 },
    // Already paid more than the (since reduced) payable. Reported, never hidden.
    overpaidAmount: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid', 'owed'], default: 'pending', index: true },
    orderBreakdown: [orderBreakdownSchema],
    generatedAt: { type: Date, default: Date.now },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    notes: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

ownerOperatorSalarySchema.index({ tenantId: 1, ownerOperator: 1, month: 1, year: 1 }, { unique: true });
ownerOperatorSalarySchema.index({ tenantId: 1, month: 1, year: 1 });

module.exports = mongoose.model('owneroperatorsalaries', ownerOperatorSalarySchema);
