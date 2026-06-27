const mongoose = require('mongoose');

/**
 * One row per subscription purchase/renewal/upgrade/change for a tenant.
 * Drives the tenant-admin billing history and the super-admin per-tenant history view.
 * Payment is mocked for now (paymentRef stores the fake transaction id).
 */
const subscriptionHistorySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },

  action: {
    type: String,
    enum: ['buy', 'renew', 'upgrade', 'downgrade', 'cancel', 'admin_assign'],
    required: true
  },

  // Plan snapshot at purchase time
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'subscription_plans' },
  planSlug: { type: String },
  planName: { type: String },

  billingCycle: { type: String, enum: ['monthly', 'quarterly', 'yearly'], default: 'monthly' },

  // Money (mock). amount is what was "charged" after discount.
  amount: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },
  discountPct: { type: Number, default: 0 },

  startDate: { type: Date, default: Date.now },
  endDate: { type: Date },

  // Mock payment details
  paymentStatus: { type: String, enum: ['paid', 'free', 'failed'], default: 'paid' },
  paymentRef: { type: String },

  // Who performed it (tenant admin user id, or super admin)
  performedBy: { type: mongoose.Schema.Types.ObjectId },
  performedByName: { type: String },
  note: { type: String },

  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

subscriptionHistorySchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('subscription_history', subscriptionHistorySchema);
