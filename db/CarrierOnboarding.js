const mongoose = require('mongoose');

/**
 * One carrier setup packet sent out as a link.
 *
 * A link is single-use: once the carrier signs, the token stops working. The
 * signed PDF is rendered ONCE at submit and stored with its hash — re-rendering
 * from data later would print whatever the template says *today*, which is not
 * what the carrier signed.
 *
 * Sensitive values (full bank account, full tax id) are never stored here: only
 * the masked form. The full values travel once, in the notification email.
 */
const fileSchema = new mongoose.Schema({
  kind: { type: String, required: true },
  name: String,
  mime: String,
  size: Number,
  filename: String,
  url: String,
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const schema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies', default: null },
  token: { type: String, required: true, unique: true },
  status: {
    type: String,
    enum: ['sent', 'opened', 'in_progress', 'submitting', 'submitted', 'revoked'],
    default: 'sent',
    index: true,
  },
  // Who the link was meant for — a hint for the list, never trusted as data.
  invitedName: { type: String, default: '' },
  invitedEmail: { type: String, default: '' },
  note: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  openedAt: { type: Date, default: null },
  lastSavedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },

  // Form answers (sanitized; sensitive values masked once submitted).
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  files: { type: [fileSchema], default: [] },

  // Signature + evidence.
  signature: {
    image: { type: String, default: null }, // data:image/png;base64,…
    name: { type: String, default: '' },
    title: { type: String, default: '' },
    signedAt: { type: Date, default: null },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  brokerSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  templateVersion: { type: String, default: '' },
  submittedAt: { type: Date, default: null },

  // The signed document as it was produced. select:false — never sent in lists.
  pdf: { type: Buffer, select: false },
  pdfHash: { type: String, default: '' },
  pdfSize: { type: Number, default: 0 },

  carrier: { type: mongoose.Schema.Types.ObjectId, ref: 'carriers', default: null },
  carrierMatched: { type: Boolean, default: false }, // linked to an existing carrier, not created

  emailStatus: { type: String, enum: ['none', 'sent', 'failed', 'not_configured'], default: 'none' },
  emailError: { type: String, default: '' },
  emailSentAt: { type: Date, default: null },
  emailTo: { type: [String], default: [] },

  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null },
});

schema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('carrier_onboardings', schema);
