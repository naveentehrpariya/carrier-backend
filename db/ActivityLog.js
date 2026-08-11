const mongoose = require('mongoose');

/**
 * Append-only audit trail.
 *
 * Two properties make this collection evidence rather than just a feed:
 *
 * 1. APPEND-ONLY. Every update/delete path on this model throws. Nothing in the
 *    application can rewrite or erase history, including a bug or a compromised
 *    admin session. Maintenance scripts must pass { auditBypass: true }.
 *
 * 2. HASH-CHAINED. Each entry stores the hash of the previous entry for the same
 *    tenant, and its own hash over its content + that link. Editing or deleting
 *    any row breaks every hash after it, and GET /activity-logs/verify reports
 *    exactly where the break is.
 *
 * HONEST LIMIT: someone with direct write access to MongoDB could delete a row
 * and recompute the whole chain. The chain proves the application did not tamper
 * and makes casual DB-level tampering visible; it is not a substitute for an
 * off-box copy. That is what `exportChainAnchor` is for (daily digest kept
 * outside the database).
 */

const LOCATION_FIELDS = {
  country: { type: String, default: '' },
  region: { type: String, default: '' },
  city: { type: String, default: '' },
  timezone: { type: String, default: '' },
  // [lat, lng] of the network's registered area — NOT of the person.
  coordinates: { type: [Number], default: undefined },
  // MaxMind accuracy radius in km. Blank city usually means ~1000km.
  accuracyKm: { type: Number, default: null },
  // Always true. IP geolocation is never exact; the UI must say so.
  approx: { type: Boolean, default: true },
  source: { type: String, default: '' },
  label: { type: String, default: '' },
};

const activityLogSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true,
  },

  // ---- who ----
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'users',
    index: true,
  },
  userName: { type: String, default: 'System' },
  userEmail: { type: String, default: '' },
  userRole: { type: Number, default: null },

  /**
   * Set when the acting session is an emulation. `userId` stays the account
   * whose data changed; this records who was actually driving it, so a super
   * admin's edit is never filed under the tenant user they were emulating.
   */
  onBehalfOf: {
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    userName: { type: String, default: '' },
    userEmail: { type: String, default: '' },
    type: {
      type: String,
      enum: ['tenant_emulation', 'employee_emulation', null],
      default: null,
    },
  },

  // ---- what ----
  action: {
    type: String,
    required: true,
    enum: [
      'CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'STATUS_CHANGE',
      'LOGIN', 'LOGIN_FAILED', 'LOGOUT',
      'PAYMENT', 'UPLOAD', 'EXPORT', 'DOWNLOAD', 'VIEW',
      'OTHER',
    ],
    index: true,
  },
  module: { type: String, required: true, index: true },
  /** Mongoose model name the diff was taken against (e.g. 'Order'). */
  model: { type: String, default: '' },
  resourceId: { type: String, default: null },
  resourceName: { type: String, default: '' },
  description: { type: String, required: true },

  // ---- the change itself ----
  /** Audited fields that actually moved. Empty on CREATE/DELETE snapshots. */
  changedFields: { type: [String], default: [] },
  /** Whitelisted field values before the write (or full snapshot on DELETE). */
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  /** Whitelisted field values after the write (or full snapshot on CREATE). */
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  /** Free-form extras — kept for the 80+ legacy logActivity call sites. */
  details: { type: mongoose.Schema.Types.Mixed, default: {} },

  /**
   * Marks a change that rewrites already-reported money: FX rates, driver rates,
   * amounts on a paid order, edits to a generated payslip. Surfaced to admins.
   */
  critical: { type: Boolean, default: false, index: true },

  // ---- where it came from ----
  ipAddress: { type: String, default: '' },
  location: { type: LOCATION_FIELDS, default: () => ({}) },
  userAgent: { type: String, default: '' },
  method: { type: String, default: '' },
  path: { type: String, default: '' },
  source: {
    type: String,
    enum: ['api', 'script', 'system', 'cron'],
    default: 'api',
    index: true,
  },

  // ---- integrity chain ----
  /** Monotonic per-tenant position. Gaps mean entries were removed. */
  seq: { type: Number, default: null },
  prevHash: { type: String, default: '' },
  hash: { type: String, default: '' },
  chainStatus: {
    type: String,
    enum: ['chained', 'unchained', 'legacy'],
    default: 'unchained',
    index: true,
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  // The chain hashes the stored content; silently dropping unknown keys would
  // let a hand-inserted row hash differently from how it reads.
  strict: true,
});

// Fast tenant-scoped queries
activityLogSchema.index({ tenantId: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, module: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, action: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
// Per-resource timeline ("everything that happened to order X")
activityLogSchema.index({ tenantId: 1, module: 1, resourceId: 1, createdAt: -1 });
// Chain walk + gap detection
activityLogSchema.index({ tenantId: 1, seq: 1 }, { unique: true, sparse: true });

// NO TTL INDEX, AND NO PRUNING — deliberately.
// A retention sweep would delete rows out of the middle of the chain, and a gap
// left by an expiry is indistinguishable from a gap left by someone covering
// their tracks. Authorising gaps would mean maintaining a list of "approved
// deletions", which is exactly the thing an attacker would edit. Entries are
// small (a whitelist diff, not a document copy), so the trail is kept whole.

/* ------------------------------------------------------------------ *
 * Append-only enforcement
 * ------------------------------------------------------------------ */

const MUTATING_HOOKS = [
  'updateOne', 'updateMany', 'replaceOne',
  'findOneAndUpdate', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove', 'remove',
];

function blockMutation(next) {
  // Maintenance scripts opt out explicitly, e.g.
  //   ActivityLog.updateOne(filter, patch, { auditBypass: true })
  const opts = typeof this.getOptions === 'function' ? this.getOptions() : {};
  if (opts && opts.auditBypass === true) return next();
  return next(new Error(
    'ActivityLog is append-only: audit entries cannot be modified or deleted. ' +
    'Pass { auditBypass: true } only from a maintenance script.'
  ));
}

MUTATING_HOOKS.forEach((hook) => {
  activityLogSchema.pre(hook, blockMutation);
});

// Block re-saving an already-persisted entry.
activityLogSchema.pre('save', function guardResave(next) {
  if (this.isNew) return next();
  if (this.$locals?.auditBypass === true) return next();
  return next(new Error('ActivityLog is append-only: an existing entry cannot be re-saved.'));
});

module.exports = mongoose.model('ActivityLog', activityLogSchema);
