/**
 * Field-level change capture for the audit trail.
 *
 * The audit log used to record only "an order was updated". That answers
 * nothing when a report disagrees with a payslip — the question is always
 * "which number changed, from what, to what, and who typed it". This module
 * produces that diff.
 *
 * DELIBERATELY A WHITELIST, NOT A FULL SNAPSHOT.
 * Storing whole documents would (a) bloat the collection on every save,
 * (b) bury the money fields under churn like `updatedAt`, and (c) copy
 * personal data into a second collection that we then have to protect.
 * Only fields that move money, change access, or change how a number is
 * interpreted are recorded.
 */

const REDACT_KEYS = [
  'password', 'newPassword', 'oldPassword', 'confirmPassword',
  'token', 'accessToken', 'refreshToken', 'jwt', 'secret', 'apiKey',
  'api_key', 'clientSecret', 'privateKey', 'cvv', 'cardNumber', 'card_number',
  'otp', 'resetToken', 'passwordResetToken',
];

/** Values longer than this are truncated — a diff is evidence, not a backup. */
const MAX_VALUE_CHARS = 2000;

/**
 * Per-model audited field paths.
 *
 * Rule for adding a field: does changing it silently change money, access, or
 * the meaning of an existing number? If yes, it belongs here.
 */
const AUDIT_FIELDS = {
  Order: [
    'order_type', 'status', 'is_locked',
    'serial_no', 'customer_order_no',
    // money as typed + money as stored
    'input_currency', 'input_total_amount', 'input_carrier_amount',
    'total_amount', 'carrier_amount', 'settle_amount',
    'revenue_currency', 'fx_to_usd',
    'revenue_items', 'carrier_revenue_items',
    // distance feeds driver pay -> owner settlement -> truck gross
    'totalDistance', 'distance_source', 'route_crosses_border', 'route_summary',
    // who the money goes to
    'customer', 'carrier', 'truck', 'trailer', 'drivers',
    'ownerOperator', 'ownerOperators', 'isMixedOwner',
    // payment state
    'payment_status', 'customer_payment_status', 'carrier_payment_status',
    'paid_amount', 'carrier_paid_amount',
    'commission', 'added_by',
    'shipping_details',
  ],
  Trip: [
    'miles', 'totalDistance', 'total_km',
    'rate_per_mile', 'rate_currency', 'total_driver_pay',
    'settle_amount',
    'truck', 'trailer', 'drivers', 'carrier',
    'start_stop_index', 'end_stop_index',
    'deletedAt',
  ],
  DriverProfile: [
    'ratePerMile', 'ratePerMileSolo', 'ratePerMileTeam',
    'cityHoursRate', 'rateCurrency',
  ],
  DriverSalary: [
    'basePayable', 'previousDueAdded', 'previousOwedDeducted',
    'manualDeduction', 'manualAddition',
    'finalPayable', 'paidAmount', 'dueAmount', 'owedAmount', 'overpaidAmount', 'paymentStatus',
    'soloRate', 'teamRate', 'cityRate', 'rateCurrency', 'currency',
    'totalMiles', 'totalTripPay', 'deductionTotal', 'additionTotal',
  ],
  DriverDeduction: [
    'amount', 'currency', 'type', 'direction', 'date', 'note', 'description',
    'reference', 'recurring', 'autoSource', 'truckExpense', 'deletedAt',
  ],
  // One recorded payment against a driver payslip.
  DriverPayment: [
    'amount', 'currency', 'inputAmount', 'inputCurrency', 'fxRate', 'date', 'notes', 'method',
  ],
  OwnerOperatorFinancialRecord: [
    'amount', 'settle_amount', 'deduction', 'status', 'currency', 'order',
  ],
  OwnerOperatorSalary: [
    'basePayable', 'finalPayable', 'paidAmount', 'dueAmount',
    'manualDeduction', 'manualAddition', 'paymentStatus', 'currency',
    'previousDueAdded', 'previousOwedDeducted', 'owedAmount', 'overpaidAmount',
  ],
  // One typed line of an owner's monthly additions/deductions. Every field here either
  // moves money or explains why it moved.
  OwnerAdjustment: [
    'kind', 'category', 'amount', 'currency', 'amountInSalaryCurrency',
    'salaryCurrency', 'fxRate', 'date', 'notes', 'reference', 'recurring', 'deletedAt',
  ],
  // `paid_by`/`driver` decide whether a driver gets reimbursed for this receipt, so they
  // move money exactly like the amount does.
  TruckExpense: ['amount', 'currency', 'category', 'type', 'date', 'truck', 'description', 'paid_by', 'driver', 'deletedAt'],
  // An FX row rewrites every historical report that converts through it.
  ConversionRate: ['rate', 'source', 'target', 'month', 'year'],
  Users: [
    'permissions', 'role', 'is_admin', 'isTenantAdmin',
    'allowedModules', 'email', 'company', 'status', 'deletedAt',
  ],
  Company: [
    'name', 'order_prefix', 'route_country_policy', 'currency',
    'address', 'email', 'phone',
  ],
  Tenant: ['status', 'subscription', 'name', 'subdomain', 'isActive'],
  Customer: [
    'company_name', 'email', 'phone', 'assigned_to', 'company',
    'address', 'deletedAt',
  ],
  Carrier: [
    'company_name', 'mc_number', 'email', 'phone', 'company', 'deletedAt',
  ],
  Truck: ['truck_no', 'ownerOperated', 'ownerOperator', 'company', 'deletedAt'],
  Trailer: ['trailer_no', 'company', 'deletedAt'],
  OwnerOperator: [
    'name', 'companyName', 'email', 'phone', 'commission', 'deletedAt',
  ],
  SubscriptionPlan: [
    'name', 'slug', 'monthlyPrice', 'currency', 'discounts',
    'maxOrders', 'maxUsers', 'modules', 'isActive',
  ],
};

/** Models whose changes are always worth recording even if not listed above. */
function auditedFieldsFor(model) {
  return AUDIT_FIELDS[model] || null;
}

function isRedacted(key) {
  const lower = String(key).toLowerCase();
  return REDACT_KEYS.some((k) => lower === k.toLowerCase() || lower.includes(k.toLowerCase()));
}

/**
 * Reduce a Mongoose value to something stable and comparable.
 * ObjectId -> string, Date -> ISO, subdocs -> plain objects.
 */
function normalizeValue(value) {
  if (value === undefined || value === null) return null;

  // ObjectId (and anything else that stringifies to a 24-char hex id)
  if (typeof value === 'object' && typeof value.toHexString === 'function') {
    return value.toHexString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === 'object') {
    // Mongoose subdocument / lean object
    const src = typeof value.toObject === 'function' ? value.toObject() : value;
    const out = {};
    for (const key of Object.keys(src)) {
      if (key === '__v') continue;
      out[key] = isRedacted(key) ? '[redacted]' : normalizeValue(src[key]);
    }
    return out;
  }
  if (typeof value === 'number') {
    // Kill float noise: 1234.5600000000001 and 1234.56 are the same money.
    return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
  }
  return value;
}

/** Read a possibly-dotted path off a document. */
function getPath(doc, path) {
  if (!doc) return undefined;
  if (!path.includes('.')) {
    return typeof doc.get === 'function' ? doc.get(path) : doc[path];
  }
  return path.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), doc);
}

/**
 * Treat null / undefined / '' as the same absence, so "field was never set" and
 * "field cleared to empty string" do not show up as a change every save.
 */
function isBlank(v) {
  return v === null || v === undefined || v === '';
}

function valuesEqual(a, b) {
  if (isBlank(a) && isBlank(b)) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** Keep the diff small — full arrays of stops/line-items get summarized. */
function truncateValue(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > MAX_VALUE_CHARS) {
      return `${value.slice(0, MAX_VALUE_CHARS)}… [truncated]`;
    }
    return value;
  }
  const json = JSON.stringify(value);
  if (json && json.length > MAX_VALUE_CHARS) {
    return {
      _truncated: true,
      _size: json.length,
      _preview: `${json.slice(0, MAX_VALUE_CHARS)}…`,
    };
  }
  return value;
}

/**
 * Compare two versions of a document over the model's audited fields.
 *
 * @param {Object} before  document before the write (lean or hydrated)
 * @param {Object} after   document after the write
 * @param {string} model   key into AUDIT_FIELDS
 * @param {Object} [opts]
 * @param {string[]} [opts.fields]  override the whitelist
 * @returns {{changedFields: string[], before: Object, after: Object}}
 */
function diffDocs(before, after, model, opts = {}) {
  const fields = opts.fields || auditedFieldsFor(model);
  const changedFields = [];
  const beforeOut = {};
  const afterOut = {};

  // No whitelist for this model: compare only the keys present in `after`,
  // so an unknown model still produces something useful instead of nothing.
  const keys = fields || Object.keys(after || {}).filter((k) => !k.startsWith('_') && k !== '__v');

  for (const path of keys) {
    if (isRedacted(path)) continue;

    const rawBefore = normalizeValue(getPath(before, path));
    const rawAfter = normalizeValue(getPath(after, path));

    // Field absent on both sides — nothing to say about it.
    if (rawBefore === undefined && rawAfter === undefined) continue;
    if (valuesEqual(rawBefore, rawAfter)) continue;

    changedFields.push(path);
    beforeOut[path] = truncateValue(rawBefore);
    afterOut[path] = truncateValue(rawAfter);
  }

  return { changedFields, before: beforeOut, after: afterOut };
}

/**
 * Snapshot the audited fields of a single document — used on CREATE (no
 * "before" exists) and on DELETE (no "after" exists).
 */
function snapshotDoc(doc, model, opts = {}) {
  const fields = opts.fields || auditedFieldsFor(model);
  const out = {};
  if (!doc) return out;

  const keys = fields || Object.keys(doc).filter((k) => !k.startsWith('_') && k !== '__v');
  for (const path of keys) {
    if (isRedacted(path)) continue;
    const value = normalizeValue(getPath(doc, path));
    if (value === undefined || value === null) continue;
    out[path] = truncateValue(value);
  }
  return out;
}

/**
 * Human sentence for a diff: "total_amount 1850 → 1250, settle_amount 900 → 700".
 * Used as the log description when the caller does not supply one.
 */
function describeDiff(diff, limit = 4) {
  if (!diff || !diff.changedFields?.length) return 'No audited fields changed';
  const parts = diff.changedFields.slice(0, limit).map((f) => {
    const b = summarizeForText(diff.before[f]);
    const a = summarizeForText(diff.after[f]);
    return `${f}: ${b} → ${a}`;
  });
  const extra = diff.changedFields.length - parts.length;
  return parts.join(', ') + (extra > 0 ? ` (+${extra} more)` : '');
}

function summarizeForText(value) {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'object') return value._truncated ? '[large value]' : '[object]';
  const str = String(value);
  return str.length > 60 ? `${str.slice(0, 60)}…` : str;
}

module.exports = {
  AUDIT_FIELDS,
  REDACT_KEYS,
  auditedFieldsFor,
  diffDocs,
  snapshotDoc,
  describeDiff,
  normalizeValue,
  isRedacted,
};
