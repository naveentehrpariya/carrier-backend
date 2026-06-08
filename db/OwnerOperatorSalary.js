const mongoose = require('mongoose');

const orderBreakdownSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', required: true },
    serial_no: { type: Number, default: null },
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
    manualDeduction: { type: Number, default: 0 },
    manualAddition: { type: Number, default: 0 },
    finalPayable: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    dueAmount: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending', index: true },
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
