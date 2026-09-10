const mongoose = require('mongoose');

const fleetDocSchema = new mongoose.Schema({
  tenantId: { 
    type: String, 
    required: true, 
    index: true,
  },
  // `owner_operator` was written by /upload/owner-operator/doc/:id long before it was
  // an allowed value — every one of those uploads failed enum validation and 500'd.
  // Not fleet-only any more: carriers, customers and vendors hold paperwork that
  // expires too (a certificate of insurance, a tax-exemption certificate). The
  // collection name is historical — a second collection would need a migration and
  // a second copy of the alert query for no gain.
  type: { type: String, enum: ['truck', 'trailer', 'owner_operator', 'carrier', 'customer', 'vendor'], required: true, index: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String },
  mime: { type: String },
  size: { type: String },
  filename: { type: String },
  url: { type: String },
  // Typed document metadata — a doc can exist with no file at all (manual entry).
  docType: { type: String, enum: ['license', 'rc', 'insurance', 'permit', 'fitness', 'puc', 'pan', 'aadhaar', 'voter_id', 'passport', 'w9', 'authority', 'coi', 'agreement', 'noa', 'credit_app', 'tax_exempt', 'other', null], default: null },
  docTypeLabel: { type: String, default: null }, // custom label when docType === 'other'
  docNumber: { type: String, default: null },
  // What this type of document actually prints (chassis no on an RC, insurer on a
  // policy). Free-form by design: the shape belongs to the UI, the backend only
  // whitelists the keys — see docController.DOC_FIELD_KEYS.
  docFields: { type: mongoose.Schema.Types.Mixed, default: null },
  issueDate: { type: Date, default: null },
  expiryDate: { type: Date, default: null },
  added_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
  updatedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }
});

fleetDocSchema.index({ tenantId: 1, type: 1, entityId: 1, createdAt: -1 });
fleetDocSchema.index({ tenantId: 1, expiryDate: 1 });

const FleetDoc = mongoose.model('fleet_docs', fleetDocSchema);
module.exports = FleetDoc;

