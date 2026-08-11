const crypto = require('crypto');
const ActivityLog = require('../db/ActivityLog');
const AuditChainState = require('../db/AuditChainState');
const { resolveRequestLocation } = require('./geoLocation');
const { diffDocs, snapshotDoc, describeDiff } = require('./auditDiff');

/**
 * Audit trail writer.
 *
 * Two entry points:
 *   logActivity(req, {...})  - unchanged signature used by ~80 existing call
 *                              sites. Records that something happened.
 *   logChange(req, {...})    - records WHAT changed: before/after values for the
 *                              model's audited fields, plus the integrity chain.
 *
 * Both are fire-and-forget: a failure here is logged to the console and
 * swallowed. An audit write must never be the reason a dispatcher cannot save
 * an order.
 */

/**
 * How many times to retry the compare-and-set when two processes race for the
 * chain head. Generous on purpose: an entry that loses every attempt is written
 * outside the chain, which is a hole in the evidence, not just a slow write.
 */
const CHAIN_CAS_RETRIES = 40;

/* ------------------------------------------------------------------ *
 * Hashing
 * ------------------------------------------------------------------ */

/**
 * Deterministic JSON: object keys sorted at every level, so two runs over the
 * same data always produce the same string. Mongo does not guarantee key order,
 * and an unsorted stringify would make verification fail on untouched rows.
 */
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * An empty object and an absent field are the same thing to a reader, and Mongo
 * does not reliably preserve the difference — a `details: {}` written at hash
 * time comes back as `undefined`. Collapsing both to null keeps the hash stable
 * across the write/read round trip; without this every entry failed verification.
 */
function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return value;
}

/**
 * The exact bytes an entry commits to.
 *
 * EVERY meaningful field is here on purpose. An earlier version hashed only the
 * structured change (action, model, before/after) and left `description` out —
 * which meant the one line a human actually reads in the trail could be rewritten
 * to say anything while the chain still verified as intact. A field that is shown
 * to a reader but not signed is worse than no signature at all.
 *
 * Adding or removing a field here invalidates every existing hash, so it must be
 * paired with a re-chain migration.
 */
function chainPayload(entry) {
  return [
    entry.tenantId,
    entry.seq,
    entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt),
    entry.userId ? String(entry.userId) : '',
    entry.userName || '',
    entry.userEmail || '',
    entry.onBehalfOf?.userId ? String(entry.onBehalfOf.userId) : '',
    entry.onBehalfOf?.type || '',
    entry.action,
    entry.module,
    entry.model || '',
    entry.resourceId || '',
    entry.resourceName || '',
    entry.description || '',
    canonicalize(emptyToNull(entry.changedFields)),
    canonicalize(emptyToNull(entry.before)),
    canonicalize(emptyToNull(entry.after)),
    canonicalize(emptyToNull(entry.details)),
    entry.critical ? '1' : '0',
    entry.ipAddress || '',
    // Only the rendered label, not the whole location subdocument — a scalar
    // cannot pick up the empty-object round-trip problem above.
    entry.location?.label || '',
    entry.source || '',
    entry.prevHash || '',
  ].join('|');
}

function computeHash(entry) {
  return crypto.createHash('sha256').update(chainPayload(entry)).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Chain slot allocation
 * ------------------------------------------------------------------ */

/**
 * Per-tenant in-process serialization of chain-head reservation.
 *
 * A hash chain is inherently sequential: entry N's hash depends on entry N-1's.
 * Letting every request race for the head turns that into O(n²) compare-and-set
 * retries — at 25 concurrent writes more than half of them exhausted their
 * retries and fell out of the chain entirely, which is a hole in the evidence.
 *
 * Requests within one process now queue behind each other, so they contend zero
 * times. The compare-and-set below is still required, and is what keeps the chain
 * correct when a SECOND app instance writes at the same moment — a case this lock
 * cannot see.
 */
const chainLocks = new Map();

function withTenantChainLock(tenantId, fn) {
  const prev = chainLocks.get(tenantId) || Promise.resolve();
  // `.then(fn, fn)` so one rejected reservation does not poison the queue.
  const next = prev.then(fn, fn);
  // Swallow rejections on the stored tail; the caller still sees the real result.
  const tail = next.catch(() => {});
  chainLocks.set(tenantId, tail);
  tail.then(() => {
    // Drop the entry once this is the last waiter, so the map cannot grow
    // without bound across many tenants.
    if (chainLocks.get(tenantId) === tail) chainLocks.delete(tenantId);
  });
  return next;
}

/**
 * Reserve the next position in a tenant's chain.
 *
 * Compare-and-set on { tenantId, nextSeq } — if another writer advanced the head
 * between our read and our write, the update matches nothing and we retry with
 * the new head. This is what makes the chain safe across concurrent requests and
 * across multiple app instances.
 *
 * @returns {Promise<{seq: number, prevHash: string, hash: string}|null>}
 *          null when a slot could not be reserved; the entry is still written,
 *          marked `unchained`, so no event is ever lost.
 */
function reserveChainSlot(tenantId, entryDraft) {
  return withTenantChainLock(tenantId, () => reserveChainSlotUnlocked(tenantId, entryDraft));
}

async function reserveChainSlotUnlocked(tenantId, entryDraft) {
  for (let attempt = 0; attempt < CHAIN_CAS_RETRIES; attempt += 1) {
    // Read (or create) the current head.
    let state = await AuditChainState.findOne({ tenantId }).lean();
    if (!state) {
      try {
        state = (await AuditChainState.create({ tenantId, nextSeq: 1, lastHash: '' })).toObject();
      } catch (err) {
        // Unique index race — another writer created it first; re-read.
        state = await AuditChainState.findOne({ tenantId }).lean();
        if (!state) continue;
      }
    }

    const seq = state.nextSeq;
    const prevHash = state.lastHash || '';
    const hash = computeHash({ ...entryDraft, tenantId, seq, prevHash });

    const claimed = await AuditChainState.findOneAndUpdate(
      { tenantId, nextSeq: seq },              // still the head we read?
      { $set: { nextSeq: seq + 1, lastHash: hash } },
      { new: true },
    );

    if (claimed) return { seq, prevHash, hash };

    // Lost the race against another process — back off briefly so both writers do
    // not retry in lockstep, then rebuild on top of the new head.
    await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));
  }

  console.error(`[ActivityLogger] Chain slot contention for tenant ${tenantId}; entry written unchained.`);
  return null;
}

/* ------------------------------------------------------------------ *
 * Request context
 * ------------------------------------------------------------------ */

/**
 * Who is really acting.
 *
 * During emulation `req.user` is the emulated account — the right owner for the
 * data — but blaming an edit on them would be wrong. The driver of the session
 * is recorded separately in `onBehalfOf`.
 */
function resolveActor(req) {
  const user = req?.user;
  const actor = {
    userId: user?._id || user?.id || null,
    userName: user?.name || 'System',
    userEmail: user?.email || '',
    userRole: Number.isFinite(Number(user?.role)) ? Number(user.role) : null,
    onBehalfOf: {
      userId: null, userName: '', userEmail: '', type: null,
    },
  };

  if (req?.isEmulatingEmployee) {
    actor.onBehalfOf = {
      userId: req.originalAdminId || null,
      userName: req.originalAdmin?.name || 'Tenant admin',
      userEmail: req.originalAdmin?.email || '',
      type: 'employee_emulation',
    };
  } else if (req?.isEmulating) {
    // Only actual emulation goes in onBehalfOf. `isSuperAdminUser` alone just means
    // a platform admin is logged in as themselves — labelling that "emulation"
    // would put a second name on every entry they write and make the field
    // meaningless where it matters.
    const sa = req.superAdmin || {};
    actor.onBehalfOf = {
      userId: sa._id || sa.id || null,
      userName: sa.name || 'Super admin',
      userEmail: sa.email || '',
      type: 'tenant_emulation',
    };
  }

  return actor;
}

function resolveTenantId(req, override) {
  return override || req?.tenantId || req?.user?.tenantId || null;
}

/* ------------------------------------------------------------------ *
 * Core writer
 * ------------------------------------------------------------------ */

async function writeEntry(req, payload) {
  const tenantId = resolveTenantId(req, payload.tenantId);
  if (!tenantId) return null; // Never log without a tenant context.

  const { ip, location } = resolveRequestLocation(req);
  const actor = resolveActor(req);
  const createdAt = new Date();

  const draft = {
    tenantId,
    createdAt,
    userId: actor.userId,
    userName: actor.userName,
    userEmail: actor.userEmail,
    userRole: actor.userRole,
    onBehalfOf: actor.onBehalfOf,
    action: payload.action,
    module: payload.module,
    model: payload.model || '',
    resourceId: payload.resourceId ? String(payload.resourceId) : null,
    resourceName: payload.resourceName || '',
    description: payload.description,
    changedFields: payload.changedFields || [],
    before: payload.before ?? null,
    after: payload.after ?? null,
    details: payload.details || {},
    critical: Boolean(payload.critical),
    ipAddress: ip || '',
    location: location || {},
    userAgent: req?.headers?.['user-agent'] || '',
    method: req?.method || '',
    path: req?.originalUrl || req?.url || '',
    source: payload.source || (req ? 'api' : 'system'),
  };

  const slot = await reserveChainSlot(tenantId, draft);

  try {
    return await ActivityLog.create({
      ...draft,
      seq: slot ? slot.seq : null,
      prevHash: slot ? slot.prevHash : '',
      hash: slot ? slot.hash : '',
      chainStatus: slot ? 'chained' : 'unchained',
    });
  } catch (err) {
    // The slot was already claimed, so this seq is now missing and /verify will
    // report it as a gap — correctly, since the event really was not recorded.
    // Name the seq loudly so an operator investigating a reported gap can match
    // it against this line instead of assuming tampering.
    if (slot) {
      console.error(
        `[ActivityLogger] Entry write FAILED after reserving chain slot #${slot.seq} ` +
        `for tenant ${tenantId} (${payload.action}/${payload.module}): ${err.message}. ` +
        'This seq will show as a gap in the integrity check.'
      );
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Record that something happened. Unchanged signature — every existing call site
 * keeps working and now additionally gets location, actor identity and the
 * integrity chain for free.
 *
 * @param {Object} req
 * @param {Object} options
 * @param {string} options.action       CREATE | UPDATE | DELETE | ... (see model enum)
 * @param {string} options.module       order | customer | carrier | employee | ...
 * @param {string} options.description  Human-readable summary
 * @param {string} [options.resourceId]
 * @param {string} [options.resourceName]
 * @param {Object} [options.details]
 * @param {string} [options.tenantId]   Override (scripts / system jobs)
 */
async function logActivity(req, options = {}) {
  try {
    return await writeEntry(req, options);
  } catch (err) {
    console.error('[ActivityLogger] Failed to write log:', err.message);
    return null;
  }
}

/**
 * Record WHAT changed.
 *
 * Pass the document as it was before the write and as it is after; the audited
 * field whitelist for `model` decides what is compared and stored.
 *
 * @param {Object} req
 * @param {Object} options
 * @param {string} options.model        Key into auditDiff.AUDIT_FIELDS, e.g. 'Order'
 * @param {string} options.module       Feed grouping, e.g. 'order'
 * @param {Object} [options.before]     Document before the write (omit on CREATE)
 * @param {Object} [options.after]      Document after the write (omit on DELETE)
 * @param {string} [options.action]     Defaults from which of before/after is present
 * @param {string} [options.description] Defaults to a rendered diff sentence
 * @param {string[]} [options.fields]   Override the whitelist
 * @param {boolean} [options.critical]  Force the critical flag
 * @param {boolean} [options.logUnchanged] Write an entry even when nothing changed
 * @returns {Promise<Object|null>} the created entry, or null when skipped/failed
 */
async function logChange(req, options = {}) {
  try {
    const {
      model, module, before, after, fields,
      resourceId, resourceName, details, tenantId,
      logUnchanged = false, source,
    } = options;

    const action = options.action || (!before ? 'CREATE' : (!after ? 'DELETE' : 'UPDATE'));

    let changedFields = [];
    let beforeVals = null;
    let afterVals = null;

    if (before && after) {
      const diff = diffDocs(before, after, model, { fields });
      changedFields = diff.changedFields;
      beforeVals = diff.before;
      afterVals = diff.after;

      // Nothing audited moved. Writing an entry per no-op save would bury the
      // real edits, so skip unless the caller explicitly wants the record.
      if (!changedFields.length && !logUnchanged) return null;
    } else if (after) {
      afterVals = snapshotDoc(after, model, { fields });
    } else if (before) {
      beforeVals = snapshotDoc(before, model, { fields });
    }

    const description = options.description
      || (before && after
        ? `${model} updated — ${describeDiff({ changedFields, before: beforeVals, after: afterVals })}`
        : `${model} ${action.toLowerCase()}d`);

    const doc = after || before || {};
    return await writeEntry(req, {
      action,
      module: module || String(model || '').toLowerCase(),
      model,
      description,
      resourceId: resourceId ?? doc._id ?? doc.id ?? null,
      resourceName: resourceName || '',
      changedFields,
      before: beforeVals,
      after: afterVals,
      details,
      tenantId,
      source,
      critical: options.critical ?? isCriticalChange(model, changedFields, before),
    });
  } catch (err) {
    console.error('[ActivityLogger] Failed to write change log:', err.message);
    return null;
  }
}

/**
 * Changes that rewrite numbers already reported or already paid.
 *
 * These are the edits worth an admin's attention: an FX rate or driver rate
 * change retroactively moves every figure derived from it, and touching money on
 * an order that is already paid, or on a generated payslip, moves money that has
 * already been reconciled.
 */
const CRITICAL_MODELS = new Set(['ConversionRate', 'DriverProfile']);
const CRITICAL_FIELDS = new Set([
  'total_amount', 'input_total_amount', 'carrier_amount', 'input_carrier_amount',
  'settle_amount', 'totalDistance', 'fx_to_usd', 'input_currency', 'revenue_currency',
  'rate_per_mile', 'rate_currency', 'total_driver_pay',
  'paidAmount', 'finalPayable', 'manualDeduction', 'manualAddition',
  'permissions', 'role', 'is_admin', 'isTenantAdmin',
]);

function isCriticalChange(model, changedFields = [], before = null) {
  if (CRITICAL_MODELS.has(model)) return true;
  if (!changedFields.length) return false;

  const touchesMoney = changedFields.some((f) => CRITICAL_FIELDS.has(f));
  if (!touchesMoney) return false;

  // Money moving on a record that is still open is ordinary editing.
  // Money moving after it was paid or locked is what needs flagging.
  if (model === 'Order') {
    const settled = before?.is_locked
      || before?.customer_payment_status === 'paid'
      || before?.carrier_payment_status === 'paid'
      || before?.payment_status === 'paid';
    return Boolean(settled);
  }
  if (model === 'DriverSalary' || model === 'OwnerOperatorSalary') {
    return Number(before?.paidAmount) > 0 || before?.paymentStatus === 'paid';
  }
  return true;
}

module.exports = {
  logActivity,
  logChange,
  // exported for the verify endpoint and the backfill migration
  computeHash,
  chainPayload,
  canonicalize,
  resolveActor,
};
