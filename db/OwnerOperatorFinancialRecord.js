const mongoose = require('mongoose');

const ownerOperatorFinancialRecordSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    ownerOperator: { type: mongoose.Schema.Types.ObjectId, ref: 'owneroperators', required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', default: null, index: true },
    salary: { type: mongoose.Schema.Types.ObjectId, ref: 'owneroperatorsalaries', default: null, index: true },
    type: {
      type: String,
      enum: ['SETTLEMENT', 'OWNER_PROFIT', 'DRIVER_DEDUCTION', 'SALARY_GENERATED', 'SALARY_PAYMENT', 'ADJUSTMENT'],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, default: 0 },
    currency: { type: String, default: 'CAD' },
    month: { type: Number, min: 1, max: 12, index: true },
    year: { type: Number, min: 2000, max: 9999, index: true },
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending' },
    notes: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  },
  {
    timestamps: true,
  }
);

ownerOperatorFinancialRecordSchema.index({ tenantId: 1, ownerOperator: 1, createdAt: -1 });
ownerOperatorFinancialRecordSchema.index({ tenantId: 1, ownerOperator: 1, month: 1, year: 1 });

module.exports = mongoose.model('owneroperatorfinancialrecords', ownerOperatorFinancialRecordSchema);
