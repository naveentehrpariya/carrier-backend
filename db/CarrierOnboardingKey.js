const mongoose = require('mongoose');

/**
 * The tenant's ONE shared carrier signup link. Anyone who opens
 * /carrier-packet/:key gets their own packet (a CarrierOnboarding with
 * source 'shared'); the key itself never expires.
 */
const schema = new mongoose.Schema({
  tenantId: { type: String, required: true, unique: true },
  key: { type: String, required: true, unique: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
  // Who receives signed packets for THIS company — set on the dashboard, not in
  // .env (one server serves many companies). Empty = the company's own email.
  notifyEmails: { type: [String], default: [] },
  notifyUpdatedAt: { type: Date, default: null },
  notifyUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('carrier_onboarding_keys', schema);
