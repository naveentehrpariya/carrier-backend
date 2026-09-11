'use strict';
/**
 * Fuel price sheets — upload a vendor sheet, price it with a margin profile,
 * preview it, publish a branded copy, download the PDF.
 *
 * Boundaries this controller must hold:
 *   - tenantId is HARD-REQUIRED on every query. Never `if (tenantId) q.tenantId = ...`
 *     — a falsy tenant with conditional scoping reads across tenants.
 *   - a sheet with anything in `unparsed` can be previewed but NEVER published: a line
 *     that looked like data and did not become a row is a site missing from the sheet
 *     the client sends to a customer.
 *   - the priced numbers are computed by utils/fuelMargin only, and a published output
 *     SNAPSHOTS them, so re-rendering later reproduces what the customer was sent.
 */

const fs = require('fs');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const { logChange } = require('../utils/activityLogger');
const fileupload = require('../utils/fileupload');

const FuelPriceSheet = require('../db/FuelPriceSheet');
const FuelMarginProfile = require('../db/FuelMarginProfile');
const FuelSheetOutput = require('../db/FuelSheetOutput');
const Company = require('../db/Company');
const Customer = require('../db/Customer');

const parsers = require('../utils/fuelParsers');
const { mulDivRound, SCALE: SCALE_MICRO } = require('../utils/fuelParsers/shared');
const fuelMargin = require('../utils/fuelMargin');
const { buildFuelSheetHtml } = require('../utils/fuelSheetHtml');
const { resolveCompanyLogoBase64 } = require('../utils/pdfBranding');

// Same audience as the cheque register: this is pricing that goes out to customers.
const hasFuelPricingAccess = (user) => (
  user?.is_admin === 1
  || Number(user?.role) === 3
  || user?.isTenantAdmin === true
  || user?.permissions?.includes('accounting')
  || user?.permissions?.includes('subadmin')
);
exports.hasFuelPricingAccess = hasFuelPricingAccess;

const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function deny(res) {
  return res.status(403).json({ status: false, message: 'You are not authorized to manage fuel pricing.' });
}
function tenantOf(req) {
  return req.tenantId || req.user?.tenantId || null;
}
function needTenant(req, res) {
  const tenantId = tenantOf(req);
  if (!tenantId) { res.status(400).json({ status: false, message: 'Tenant context is required.' }); return null; }
  return tenantId;
}
function validId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}
/** A request value that lands in a query must be shape-checked, never passed raw. */
function objectIdOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!validId(String(value))) return undefined; // undefined = invalid, caller 400s
  return String(value);
}
function scrubTmp(files) {
  Object.values(files || {}).flat().forEach((f) => {
    if (f && f.path) fs.unlink(f.path, () => {});
  });
}

// ---------------------------------------------------------------------------
// Vendors this app can read
// ---------------------------------------------------------------------------
exports.fuelVendors = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  return res.json({
    status: true,
    vendors: parsers.VENDORS,
    scopes: fuelMargin.SCOPES,
    modes: fuelMargin.MODES,
    directions: fuelMargin.DIRECTIONS,
    taxModes: fuelMargin.TAX_MODES,
  });
});

// ---------------------------------------------------------------------------
// Upload + parse
// ---------------------------------------------------------------------------
exports.uploadFuelSheet = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) { scrubTmp(req.files); return deny(res); }
  const tenantId = needTenant(req, res); if (!tenantId) { scrubTmp(req.files); return undefined; }

  const file = (req.files?.attachment || req.files?.file || [])[0];
  if (!file) return res.status(400).json({ status: false, message: 'Attach the vendor price sheet (PDF or XLSX).' });
  if (file.size > MAX_UPLOAD_BYTES) {
    scrubTmp(req.files);
    return res.status(400).json({ status: false, message: 'That file is larger than 25MB.' });
  }

  let parsed;
  let buffer;
  try {
    buffer = fs.readFileSync(file.path);
    parsed = await parsers.parseSheet(buffer, {
      filename: file.originalname,
      vendor: req.body?.vendor || undefined,
      sheet: req.body?.sheet,
    });
  } catch (e) {
    scrubTmp(req.files);
    // Every failure mode here is something the user can act on, so the code and the
    // message are both returned rather than a bare 500.
    const known = ['vendor_unrecognised', 'vendor_ambiguous', 'vendor_signature_mismatch', 'pdf_has_no_text',
      'pdf_unreadable', 'unsupported_file_type', 'empty_file', 'sheet_not_found', 'header_not_found', 'unknown_vendor'];
    if (e.code && known.includes(e.code)) {
      return res.status(400).json({ status: false, code: e.code, message: e.message });
    }
    throw e;
  }

  // Keep the original: the parsed rows are only as trustworthy as the file they came
  // from, and a dispute is settled by reading the vendor's own document again.
  // A price list with no effective date is unusable — the reader cannot tell which
  // day it is for. The parser reads it off the vendor's banner; if the banner changed,
  // the uploader must supply it rather than have an undated sheet reach a customer.
  const dateOverride = String(req.body?.effectiveDate || '').trim();
  if (dateOverride && !/^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
    scrubTmp(req.files);
    return res.status(400).json({ status: false, code: 'effective_date_invalid', message: 'The effective date must be a calendar date (YYYY-MM-DD).' });
  }
  const effectiveDate = dateOverride || parsed.meta.effectiveDate || null;

  // The same sheet uploaded twice leaves two publishable copies of one day's prices,
  // and nothing says which one is real. Warn, do not block: a vendor does re-issue a
  // corrected sheet for the same day, and that is a legitimate second upload.
  if (effectiveDate && !req.body?.confirm_duplicate) {
    const dupes = await FuelPriceSheet.find({
      tenantId, vendor: parsed.meta.vendor, effectiveDate,
      sheetName: parsed.meta.sheetName || null,
      ...notDeleted,
    }).select('_id createdAt stats').limit(5).lean();
    if (dupes.length) {
      scrubTmp(req.files);
      return res.status(409).json({
        status: false,
        code: 'duplicate_sheet',
        message: `A ${parsed.meta.label} sheet for ${effectiveDate} has already been read. Upload it again only if the vendor re-issued it.`,
        existing: dupes.map((d) => ({ _id: d._id, rows: d.stats?.rows, uploadedAt: d.createdAt })),
      });
    }
  }

  let stored = null;
  try { stored = await fileupload(file); } catch (e) { stored = null; }
  if (!stored) scrubTmp(req.files);

  const company = req.user?.company || null;
  const doc = await FuelPriceSheet.create({
    tenantId,
    company: company || undefined,
    vendor: parsed.meta.vendor,
    vendorLabel: parsed.meta.label,
    unit: parsed.meta.unit || null,
    currency: parsed.meta.currency || null,
    dp: parsed.meta.dp === undefined ? null : parsed.meta.dp,
    baseColumn: parsed.baseColumn || null,
    generic: !!parsed.meta.generic,
    mappingRequired: !!parsed.meta.mappingRequired,
    columns: parsed.columns,
    effectiveDate,
    effectiveTo: parsed.meta.effectiveTo || null,
    sheetName: parsed.meta.sheetName || null,
    sheetIndex: parsed.meta.sheetIndex === undefined ? null : parsed.meta.sheetIndex,
    availableSheets: parsed.meta.availableSheets || [],
    meta: parsed.meta,
    rows: parsed.rows,
    stats: { ...parsed.stats, priceRange: priceRangeOf(parsed.rows, parsed.baseColumn) },
    warnings: parsed.warnings,
    unparsed: parsed.unparsed,
    sourceFile: stored ? { name: file.originalname, url: stored.url, size: stored.size, mime: stored.mime } : { name: file.originalname, size: file.size, mime: file.mimetype },
    created_by: req.user?._id,
  });

  await logChange(req, {
    model: 'FuelPriceSheet',
    module: 'fuel_pricing',
    action: 'CREATE',
    resourceId: doc._id,
    resourceName: `${doc.vendorLabel} ${doc.effectiveDate || ''}`.trim(),
    after: doc.toObject(),
    description: `Uploaded ${doc.vendorLabel} price sheet (${doc.stats?.rows || 0} rows)`,
    logUnchanged: true,
  }).catch(() => {});

  return res.json({
    status: true,
    message: `Read ${doc.stats?.rows || 0} rows from the ${doc.vendorLabel} sheet.`,
    sheet: summarize(doc),
    warnings: doc.warnings,
    unparsed: doc.unparsed,
  });
});

/**
 * What the vendor's own prices run between, on the column a margin applies to.
 *
 * The sheet list shows it, so the dispatcher can tell one day's sheet from another at
 * a glance instead of opening both. Computed when the rows are in hand (upload, and
 * again when an unrecognised sheet is finally told which column is the price) because
 * the listing endpoint deliberately does not load 350 rows per sheet.
 */
function priceRangeOf(rows, baseColumn) {
  if (!baseColumn) return null;
  let min = null;
  let max = null;
  (rows || []).forEach((r) => {
    const money = r.money instanceof Map ? Object.fromEntries(r.money) : (r.money || {});
    const v = money[baseColumn];
    if (!v || !Number.isFinite(v.int)) return;
    if (min === null || v.int < min) min = v.int;
    if (max === null || v.int > max) max = v.int;
  });
  return min === null ? null : { minInt: min, maxInt: max };
}

function summarize(doc) {
  return {
    _id: doc._id,
    vendor: doc.vendor,
    vendorLabel: doc.vendorLabel,
    unit: doc.unit,
    currency: doc.currency,
    dp: doc.dp,
    baseColumn: doc.baseColumn,
    columns: doc.columns,
    effectiveDate: doc.effectiveDate,
    effectiveTo: doc.effectiveTo,
    sheetName: doc.sheetName,
    availableSheets: doc.availableSheets,
    stats: doc.stats,
    generic: !!doc.generic,
    mappingRequired: !!doc.mappingRequired,
    confidentialNotice: !!(doc.meta && doc.meta.confidentialNotice),
    warningCount: (doc.warnings || []).length,
    unparsedCount: (doc.unparsed || []).length,
    sourceFile: doc.sourceFile,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------
exports.listFuelSheets = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;

  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const q = { tenantId, ...notDeleted };
  if (req.query.vendor) {
    if (!parsers.byVendor(String(req.query.vendor))) {
      return res.status(400).json({ status: false, message: 'Unknown vendor.' });
    }
    q.vendor = String(req.query.vendor);
  }
  const [docs, total] = await Promise.all([
    FuelPriceSheet.find(q).sort({ createdAt: -1 }).limit(limit).select('-rows').lean(),
    FuelPriceSheet.countDocuments(q),
  ]);
  // A list that was capped must say so, or it reads as "these are all the sheets".
  return res.json({ status: true, sheets: docs.map(summarize), total, limit, truncated: total > docs.length });
});

exports.fuelSheetDetail = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid sheet id.' });

  const doc = await FuelPriceSheet.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!doc) return res.status(404).json({ status: false, message: 'Sheet not found.' });
  return res.json({ status: true, sheet: summarize(doc), rows: doc.rows, warnings: doc.warnings, unparsed: doc.unparsed, meta: doc.meta });
});

/**
 * Set the effective date on a sheet the parser could not date (or dated wrongly).
 * Publishing is blocked without one, so this is the way out rather than re-uploading.
 */
exports.setFuelSheetDate = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid sheet id.' });

  const effectiveDate = String(req.body?.effectiveDate || '').trim();
  const effectiveTo = String(req.body?.effectiveTo || '').trim();
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDate(effectiveDate)) {
    return res.status(400).json({ status: false, code: 'effective_date_invalid', message: 'Enter the effective date as a calendar date (YYYY-MM-DD).' });
  }
  if (effectiveTo && !isDate(effectiveTo)) {
    return res.status(400).json({ status: false, code: 'effective_date_invalid', message: 'The end date must be a calendar date (YYYY-MM-DD).' });
  }
  // String compare is correct on YYYY-MM-DD and involves no timezone.
  if (effectiveTo && effectiveTo < effectiveDate) {
    return res.status(400).json({ status: false, code: 'period_backwards', message: 'The end date is before the start date.' });
  }

  const before = await FuelPriceSheet.findOne({ _id: req.params.id, tenantId, ...notDeleted }).select('-rows').lean();
  if (!before) return res.status(404).json({ status: false, message: 'Sheet not found.' });

  await FuelPriceSheet.updateOne(
    { _id: before._id, tenantId },
    { $set: { effectiveDate, effectiveTo: effectiveTo || null } },
  );
  const after = await FuelPriceSheet.findOne({ _id: before._id, tenantId }).select('-rows').lean();

  await logChange(req, {
    model: 'FuelPriceSheet', module: 'fuel_pricing', action: 'UPDATE',
    resourceId: before._id, resourceName: `${before.vendorLabel} ${effectiveDate}`,
    before, after,
    description: `Set the effective date of the ${before.vendorLabel} sheet to ${effectiveDate}`,
  }).catch(() => {});

  return res.json({ status: true, message: 'Effective date saved.', sheet: summarize(after) });
});

const UNITS = ['per_litre', 'cents_per_litre', 'per_gallon'];
const CURRENCIES = ['CAD', 'USD', 'INR'];

/**
 * Confirm what an unrecognised sheet's columns mean.
 *
 * The generic reader finds the table but deliberately does not decide which column is
 * the price — a margin landing on a tax column, or on a site id, would be silently
 * wrong. A person picks it here, and only then can the sheet be priced or published.
 */
exports.setFuelSheetMapping = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid sheet id.' });

  const sheet = await FuelPriceSheet.findOne({ _id: req.params.id, tenantId, ...notDeleted }).select('-rows').lean();
  if (!sheet) return res.status(404).json({ status: false, message: 'Sheet not found.' });

  const body = req.body || {};
  const columns = sheet.columns || [];
  const moneyKeys = columns.filter((c) => c.kind === 'money').map((c) => c.key);

  const baseColumn = String(body.baseColumn || '').trim();
  if (!moneyKeys.includes(baseColumn)) {
    return res.status(400).json({
      status: false, code: 'base_column_invalid',
      message: 'Choose which column holds the price you pay. It has to be a column of numbers.',
      choices: moneyKeys,
    });
  }

  const unit = String(body.unit || '').trim();
  if (!UNITS.includes(unit)) {
    return res.status(400).json({ status: false, code: 'unit_invalid', message: 'Choose whether these prices are per litre, per gallon, or in cents per litre.' });
  }
  const currency = String(body.currency || '').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) {
    return res.status(400).json({ status: false, code: 'currency_invalid', message: 'Choose the currency these prices are in.' });
  }
  const dp = Number(body.dp);
  if (!Number.isInteger(dp) || dp < 0 || dp > 6) {
    return res.status(400).json({ status: false, code: 'dp_invalid', message: 'Choose how many decimal places these prices use.' });
  }

  const taxColumns = (Array.isArray(body.taxColumns) ? body.taxColumns : []).map((k) => String(k));
  const totalColumn = body.totalColumn ? String(body.totalColumn) : null;
  const bad = [...taxColumns, ...(totalColumn ? [totalColumn] : [])]
    .filter((k) => !moneyKeys.includes(k) || k === baseColumn);
  if (bad.length) {
    return res.status(400).json({
      status: false, code: 'column_role_invalid',
      message: 'Tax and total have to be columns of numbers, and cannot be the same column as the price.',
      invalid: bad,
    });
  }

  // Roles are written onto the sheet's own columns, so the margin engine, the preview
  // and the PDF all read a mapped generic sheet exactly like a known vendor's.
  const nextColumns = columns.map((c) => {
    const label = body.labels && body.labels[c.key] ? String(body.labels[c.key]).slice(0, 60) : c.label;
    let role = 'info';
    if (c.key === baseColumn) role = 'base';
    else if (taxColumns.includes(c.key)) role = 'tax';
    else if (totalColumn && c.key === totalColumn) role = 'total';
    else if (c.kind === 'money') role = 'reference';
    return { key: c.key, label, kind: c.kind, role };
  });

  const withRows = await FuelPriceSheet.findOne({ _id: sheet._id, tenantId }).select('rows').lean();
  await FuelPriceSheet.updateOne({ _id: sheet._id, tenantId }, {
    $set: {
      baseColumn, unit, currency, dp, columns: nextColumns,
      stats: { ...(sheet.stats || {}), priceRange: priceRangeOf(withRows?.rows, baseColumn) },
      mappingRequired: false, mappedBy: req.user?._id, mappedAt: new Date(),
    },
  });
  const after = await FuelPriceSheet.findOne({ _id: sheet._id, tenantId }).select('-rows').lean();

  await logChange(req, {
    model: 'FuelPriceSheet', module: 'fuel_pricing', action: 'UPDATE',
    resourceId: sheet._id, resourceName: `${sheet.vendorLabel} ${after.effectiveDate || ''}`.trim(),
    before: sheet, after,
    // this decides which column a margin lands on, so it is worth reading back later
    critical: true,
    description: `Set the price column of an unrecognised sheet to "${nextColumns.find((c) => c.key === baseColumn).label}" (${unit}, ${currency})`,
    logUnchanged: true,
  }).catch(() => {});

  return res.json({ status: true, message: 'Saved. This sheet can now be priced.', sheet: summarize(after) });
});

exports.removeFuelSheet = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid sheet id.' });

  const before = await FuelPriceSheet.findOne({ _id: req.params.id, tenantId, ...notDeleted }).select('-rows').lean();
  if (!before) return res.status(404).json({ status: false, message: 'Sheet not found.' });

  // Published sheets are records of what a customer was sent; they outlive the upload.
  const published = await FuelSheetOutput.countDocuments({ tenantId, sheet: before._id, ...notDeleted });
  await FuelPriceSheet.updateOne({ _id: before._id, tenantId }, { $set: { deletedAt: new Date() } });

  await logChange(req, {
    model: 'FuelPriceSheet', module: 'fuel_pricing', action: 'DELETE',
    resourceId: before._id, resourceName: `${before.vendorLabel} ${before.effectiveDate || ''}`.trim(),
    before, description: `Removed ${before.vendorLabel} price sheet`, logUnchanged: true,
  }).catch(() => {});

  return res.json({
    status: true,
    message: published
      ? `Sheet removed. ${published} published price sheet(s) built from it are kept.`
      : 'Sheet removed.',
  });
});

// ---------------------------------------------------------------------------
// Margin profiles
// ---------------------------------------------------------------------------
function profileUnitFor(rules, requestedUnit) {
  // A flat margin is denominated in the sheet's own unit, so a profile containing one
  // is only valid for sheets in that unit. A percent-only profile is unit-agnostic.
  const hasFlat = rules.some((r) => r.mode === 'flat');
  if (!hasFlat) return 'any';
  return requestedUnit;
}

exports.listMarginProfiles = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;

  const q = { tenantId, ...notDeleted };
  const customer = objectIdOrNull(req.query.customer);
  if (customer === undefined) return res.status(400).json({ status: false, message: 'Invalid customer id.' });
  if (customer) q.customer = customer;
  if (req.query.unit) q.unit = { $in: [String(req.query.unit), 'any'] };
  if (req.query.vendor) q.$and = [{ $or: [{ vendor: String(req.query.vendor) }, { vendor: null }] }];

  const profiles = await FuelMarginProfile.find(q).sort({ name: 1 })
    .populate('customer', 'company_name name email').lean();
  return res.json({ status: true, profiles });
});

async function saveProfile(req, res, existing) {
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;

  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ status: false, message: 'Please name this margin profile.' });

  let normalized;
  try {
    normalized = fuelMargin.normalizeProfile({
      name, rules: body.rules, taxMode: body.taxMode, roundingDp: body.roundingDp,
    });
  } catch (e) {
    return res.status(400).json({ status: false, code: e.code || 'profile_invalid', message: e.message });
  }

  const vendor = body.vendor ? String(body.vendor) : null;
  if (vendor && !parsers.byVendor(vendor)) {
    return res.status(400).json({ status: false, message: 'Unknown vendor.' });
  }
  const requestedUnit = body.unit ? String(body.unit) : (vendor ? parsers.byVendor(vendor).spec.unit : null);
  const hasFlat = normalized.rules.some((r) => r.mode === 'flat');
  if (hasFlat && !requestedUnit) {
    return res.status(400).json({
      status: false, code: 'unit_required',
      message: 'A flat margin is an amount per litre or per gallon, so this profile needs a unit (or a vendor) so it cannot be applied to a sheet measured differently.',
    });
  }
  const unit = profileUnitFor(normalized.rules, requestedUnit);

  const customer = objectIdOrNull(body.customer);
  if (customer === undefined) return res.status(400).json({ status: false, message: 'Invalid customer id.' });
  if (customer) {
    const exists = await Customer.findOne({ _id: customer, tenantId }).select('_id').lean();
    if (!exists) return res.status(400).json({ status: false, message: 'That customer does not exist.' });
  }

  const payload = {
    tenantId,
    name,
    vendor,
    unit,
    customer: customer || null,
    rules: fuelMargin.serializeRules(normalized.rules),
    taxMode: normalized.taxMode,
    roundingDp: normalized.roundingDp,
    showVendorCost: !!body.showVendorCost,
    notes: body.notes ? String(body.notes).slice(0, 1000) : '',
  };

  let doc;
  if (existing) {
    doc = await FuelMarginProfile.findOneAndUpdate(
      { _id: existing._id, tenantId },
      { $set: { ...payload, updatedAt: new Date(), updated_by: req.user?._id } },
      { new: true, runValidators: true },
    );
  } else {
    doc = await FuelMarginProfile.create({ ...payload, created_by: req.user?._id });
  }

  await logChange(req, {
    model: 'FuelMarginProfile', module: 'fuel_pricing',
    action: existing ? 'UPDATE' : 'CREATE',
    resourceId: doc._id, resourceName: doc.name,
    before: existing || null, after: doc.toObject(),
    description: `${existing ? 'Updated' : 'Created'} fuel margin profile "${doc.name}"`,
    logUnchanged: true,
  }).catch(() => {});

  return res.json({ status: true, message: `Margin profile ${existing ? 'updated' : 'saved'}.`, profile: doc });
}

exports.addMarginProfile = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  return saveProfile(req, res, null);
});

exports.updateMarginProfile = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid profile id.' });
  const existing = await FuelMarginProfile.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!existing) return res.status(404).json({ status: false, message: 'Margin profile not found.' });
  return saveProfile(req, res, existing);
});

exports.removeMarginProfile = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid profile id.' });

  const before = await FuelMarginProfile.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Margin profile not found.' });
  await FuelMarginProfile.updateOne({ _id: before._id, tenantId }, { $set: { deletedAt: new Date() } });

  await logChange(req, {
    model: 'FuelMarginProfile', module: 'fuel_pricing', action: 'DELETE',
    resourceId: before._id, resourceName: before.name, before,
    description: `Removed fuel margin profile "${before.name}"`, logUnchanged: true,
  }).catch(() => {});

  return res.json({ status: true, message: 'Margin profile removed.' });
});

// ---------------------------------------------------------------------------
// Pricing: preview and publish
// ---------------------------------------------------------------------------

/** Load the sheet and resolve the margin rules a request wants applied. */
async function loadForPricing(req, res, tenantId) {
  const sheetId = req.params.id || req.body?.sheet;
  if (!validId(String(sheetId || ''))) { res.status(400).json({ status: false, message: 'Invalid sheet id.' }); return null; }
  const sheet = await FuelPriceSheet.findOne({ _id: sheetId, tenantId, ...notDeleted }).lean();
  if (!sheet) { res.status(404).json({ status: false, message: 'Sheet not found.' }); return null; }
  if (sheet.mappingRequired || !sheet.baseColumn || !sheet.unit) {
    res.status(400).json({
      status: false, code: 'mapping_required',
      message: 'This sheet is not one of the layouts this app knows. Tell it which column holds the price you pay before adding a margin.',
      columns: sheet.columns,
    });
    return null;
  }

  const profileId = objectIdOrNull(req.body?.profile ?? req.query?.profile);
  if (profileId === undefined) { res.status(400).json({ status: false, message: 'Invalid profile id.' }); return null; }

  let profileDoc = null;
  let profileInput = req.body?.rules ? { rules: req.body.rules, taxMode: req.body.taxMode, roundingDp: req.body.roundingDp } : null;
  if (profileId) {
    profileDoc = await FuelMarginProfile.findOne({ _id: profileId, tenantId, ...notDeleted }).lean();
    if (!profileDoc) { res.status(404).json({ status: false, message: 'Margin profile not found.' }); return null; }
    // A flat margin means a different amount in a different unit. Refuse rather than
    // apply five cents a litre as five hundredths of a cent.
    if (profileDoc.unit !== 'any' && profileDoc.unit !== sheet.unit) {
      res.status(400).json({
        status: false, code: 'profile_unit_mismatch',
        message: `"${profileDoc.name}" was written for prices in ${profileDoc.unit.replace(/_/g, ' ')}, but this sheet is in ${sheet.unit.replace(/_/g, ' ')}. Use a profile written for this vendor.`,
      });
      return null;
    }
    if (profileDoc.vendor && profileDoc.vendor !== sheet.vendor) {
      res.status(400).json({
        status: false, code: 'profile_vendor_mismatch',
        message: `"${profileDoc.name}" is restricted to ${profileDoc.vendor} sheets.`,
      });
      return null;
    }
    profileInput = {
      name: profileDoc.name, rules: profileDoc.rules,
      taxMode: profileDoc.taxMode, roundingDp: profileDoc.roundingDp,
    };
  }
  if (!profileInput) {
    res.status(400).json({ status: false, code: 'no_margin', message: 'Choose a saved margin profile, or send the margin rules to apply.' });
    return null;
  }

  // Mongoose returns embedded Maps as plain objects with .lean(), which is what the
  // margin engine expects — but a Map instance can still arrive from a non-lean path.
  const rows = (sheet.rows || []).map((r) => ({
    ...r,
    money: r.money instanceof Map ? Object.fromEntries(r.money) : (r.money || {}),
  }));

  let priced;
  try {
    priced = fuelMargin.priceSheet({ meta: sheet, columns: sheet.columns, baseColumn: sheet.baseColumn, rows }, profileInput);
  } catch (e) {
    res.status(400).json({ status: false, code: e.code || 'pricing_failed', message: e.message });
    return null;
  }
  return { sheet, priced, profileDoc, showVendorCost: req.body?.showVendorCost !== undefined ? !!req.body.showVendorCost : !!profileDoc?.showVendorCost };
}

const MOVEMENT_THRESHOLD_PCT = 15; // a vendor price that jumps this far is worth a look

/**
 * Compare a sheet's vendor prices with the last sheet read from the same vendor.
 *
 * This is the check that catches what actually goes wrong in the wild: not our
 * arithmetic, but ONE bad row in the vendor's own file. It reports movement per row
 * plus sites that appeared or disappeared, and never blocks — an unusual move is
 * sometimes a real market move, so the decision stays with a person.
 */
async function compareToPrevious(tenantId, sheet, thresholdPct) {
  if (!sheet.effectiveDate) return null;

  // Strictly EARLIER, never the same day. A re-upload or a re-issued sheet carries the
  // same effective date, and comparing a sheet against a copy of itself reports that
  // nothing moved — which reads as reassurance when in fact nothing was checked.
  // Dates are bare YYYY-MM-DD, so a string compare is the right compare.
  const previous = await FuelPriceSheet.findOne({
    tenantId,
    vendor: sheet.vendor,
    _id: { $ne: sheet._id },
    effectiveDate: { $ne: null, $lt: sheet.effectiveDate },
    ...notDeleted,
  }).sort({ effectiveDate: -1, createdAt: -1 }).lean();

  if (!previous) return null;

  const { rowKeys } = parsers;
  const prevKeys = rowKeys(previous.rows || []);
  const prevByKey = new Map();
  (previous.rows || []).forEach((r, i) => {
    const money = r.money instanceof Map ? Object.fromEntries(r.money) : (r.money || {});
    const base = money[previous.baseColumn];
    if (base) prevByKey.set(prevKeys[i], base.int);
  });

  const curKeys = rowKeys(sheet.rows || []);
  const seen = new Set();
  const byRowNo = {};
  const unusual = [];
  let moved = 0;

  (sheet.rows || []).forEach((r, i) => {
    const key = curKeys[i];
    seen.add(key);
    const prevInt = prevByKey.get(key);
    const money = r.money instanceof Map ? Object.fromEntries(r.money) : (r.money || {});
    const base = money[sheet.baseColumn];
    if (prevInt === undefined || !base) {
      byRowNo[r.rowNo] = { isNew: prevInt === undefined };
      return;
    }
    const deltaInt = base.int - prevInt;
    if (deltaInt !== 0) moved += 1;
    // percent, in micro-units, computed exactly like the money it describes
    const pctMicro = prevInt === 0 ? null : mulDivRound(deltaInt, 100 * SCALE_MICRO, prevInt);
    byRowNo[r.rowNo] = { prevInt, deltaInt, pctMicro, isNew: false };
    if (pctMicro !== null && Math.abs(pctMicro) >= thresholdPct * SCALE_MICRO) {
      unusual.push({ rowNo: r.rowNo, prevInt, nowInt: base.int, pctMicro });
    }
  });

  const missing = prevKeys.filter((k) => !seen.has(k));

  return {
    against: { _id: previous._id, effectiveDate: previous.effectiveDate, rows: (previous.rows || []).length },
    thresholdPct,
    moved,
    unchanged: (sheet.rows || []).length - moved,
    newRows: Object.values(byRowNo).filter((m) => m.isNew).length,
    missingRows: missing.length,
    unusual: unusual.sort((a, b) => Math.abs(b.pctMicro) - Math.abs(a.pctMicro)).slice(0, 50),
    byRowNo,
  };
}

exports.previewFuelSheet = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  const loaded = await loadForPricing(req, res, tenantId);
  if (!loaded) return undefined;
  const { sheet, priced, profileDoc, showVendorCost } = loaded;

  const publishBlockers = [...priced.blockers];
  if (!sheet.effectiveDate) {
    publishBlockers.unshift({
      code: 'effective_date_missing',
      count: 0,
      message: 'This sheet has no effective date. A price list nobody can date is not usable — set the date before publishing.',
      rows: [],
    });
  }
  if ((sheet.unparsed || []).length) {
    publishBlockers.unshift({
      code: 'unparsed_lines',
      count: sheet.unparsed.length,
      message: `${sheet.unparsed.length} line(s) of the vendor sheet could not be read. Re-upload the sheet or fix the template before publishing — those locations would be missing.`,
    });
  }

  const thresholdPct = Number(req.body?.movementThreshold ?? req.query?.movementThreshold ?? MOVEMENT_THRESHOLD_PCT);
  const comparison = await compareToPrevious(
    tenantId, sheet,
    Number.isFinite(thresholdPct) && thresholdPct > 0 ? thresholdPct : MOVEMENT_THRESHOLD_PCT,
  ).catch(() => null);

  return res.json({
    status: true,
    sheet: summarize(sheet),
    comparison,
    profile: profileDoc ? { _id: profileDoc._id, name: profileDoc.name } : null,
    unit: priced.unit,
    unitLabel: priced.unitLabel,
    currency: priced.currency,
    dp: priced.dp,
    baseColumn: priced.baseColumn,
    baseColumnLabel: priced.baseColumnLabel,
    taxColumns: priced.taxColumns,
    totalColumn: priced.totalColumn,
    columns: sheet.columns,
    showVendorCost,
    rules: fuelMargin.serializeRules(priced.profile.rules),
    rows: priced.rows,
    totals: priced.totals,
    warnings: sheet.warnings,
    blockers: publishBlockers,
    canPublish: publishBlockers.length === 0,
  });
});

exports.publishFuelSheet = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  const loaded = await loadForPricing(req, res, tenantId);
  if (!loaded) return undefined;
  const { sheet, priced, profileDoc, showVendorCost } = loaded;

  if (!sheet.effectiveDate) {
    return res.status(400).json({
      status: false, code: 'effective_date_missing',
      message: 'This sheet has no effective date. Set the date before publishing — a price list nobody can date is not usable.',
    });
  }
  if ((sheet.unparsed || []).length) {
    return res.status(400).json({
      status: false, code: 'unparsed_lines',
      message: `${sheet.unparsed.length} line(s) of the vendor sheet could not be read, so this sheet would be missing locations. Fix that before publishing.`,
      unparsed: sheet.unparsed,
    });
  }
  if (priced.blockers.length) {
    return res.status(400).json({
      status: false, code: 'blocked', message: 'This sheet is not ready to publish.', blockers: priced.blockers,
    });
  }

  const customerId = objectIdOrNull(req.body?.customer ?? profileDoc?.customer);
  if (customerId === undefined) return res.status(400).json({ status: false, message: 'Invalid customer id.' });
  let customer = null;
  if (customerId) {
    customer = await Customer.findOne({ _id: customerId, tenantId }).select('company_name name').lean();
    if (!customer) return res.status(400).json({ status: false, message: 'That customer does not exist.' });
  }

  const company = await Company.findOne({ tenantId }).lean();
  const doc = await createOutput({
    req, tenantId, sheet, priced, profileDoc, showVendorCost, company,
    customerId, customer, title: req.body?.title,
  });

  const replaced = doc.__superseded || 0;
  return res.json({
    status: true,
    message: `Published ${doc.rows.length} priced locations.${replaced ? ` Version ${doc.version} replaces the ${replaced} earlier sheet(s) for the same customer.` : ''}`,
    output: { _id: doc._id, version: doc.version, rows: doc.rows.length, superseded: replaced },
  });
});

/**
 * Write one published sheet. The single and the batch publish both go through here so
 * they cannot drift into producing different documents — the same rule the cheque
 * printer follows with one renderer for single and batch.
 */
async function createOutput({ req, tenantId, sheet, priced, profileDoc, showVendorCost, company, customerId, customer, title }) {
  const priorCount = await FuelSheetOutput.countDocuments({ tenantId, sheet: sheet._id });

  const doc = await FuelSheetOutput.create({
    tenantId,
    company: company?._id,
    sheet: sheet._id,
    profile: profileDoc?._id || null,
    customer: customerId || null,
    title: String(title || 'Fuel Price Sheet').slice(0, 120),
    version: priorCount + 1,
    vendor: sheet.vendor,
    vendorLabel: sheet.vendorLabel,
    unit: priced.unit,
    currency: priced.currency,
    dp: priced.dp,
    effectiveDate: sheet.effectiveDate,
    effectiveTo: sheet.effectiveTo,
    columns: sheet.columns,
    baseColumn: priced.baseColumn,
    taxColumns: priced.taxColumns,
    totalColumn: priced.totalColumn,
    showVendorCost,
    // snapshots: this document must reproduce even after the profile is edited
    profileSnapshot: {
      name: profileDoc?.name || priced.profile.name || 'Ad-hoc margin',
      taxMode: priced.profile.taxMode,
      roundingDp: priced.profile.roundingDp,
      rules: fuelMargin.serializeRules(priced.profile.rules),
    },
    // Company (db/Company.js) carries name/address/email/phone only — the same
    // fields the customer invoice prints.
    brandingSnapshot: {
      name: company?.name || '',
      address: company?.address || '',
      email: company?.email || '',
      phone: company?.phone || '',
      logo: company?.logo || '',
      customerName: customer ? (customer.company_name || customer.name || '') : '',
    },
    rows: priced.rows.filter((r) => r.priced).map((r) => ({
      rowNo: r.rowNo, text: r.text, baseInt: r.baseInt, marginInt: r.marginInt,
      finalInt: r.finalInt, taxes: r.taxes, totalInt: r.totalInt, ruleIndex: r.ruleIndex, rule: r.rule,
    })),
    totals: priced.totals,
    created_by: req.user?._id,
  });

  // The previous sheet for this same vendor sheet + customer is now out of date.
  // Leaving both marked 'published' is how the wrong version gets emailed out; the old
  // one keeps its numbers (it is a record of what was sent) but says it was replaced.
  const superseded = await FuelSheetOutput.updateMany(
    {
      tenantId,
      sheet: sheet._id,
      customer: customerId || null,
      status: 'published',
      _id: { $ne: doc._id },
      ...notDeleted,
    },
    { $set: { status: 'superseded', supersededBy: doc._id } },
  );

  await logChange(req, {
    model: 'FuelSheetOutput', module: 'fuel_pricing', action: 'CREATE',
    resourceId: doc._id, resourceName: `${doc.title} v${doc.version}`,
    after: doc.toObject(),
    description: `Published ${doc.vendorLabel} price sheet v${doc.version} (${doc.rows.length} rows)${customer ? ` for ${doc.brandingSnapshot.customerName}` : ''}`,
    logUnchanged: true,
  }).catch(() => {});

  doc.__superseded = superseded?.modifiedCount || superseded?.nModified || 0;
  return doc;
}

/**
 * Publish one vendor sheet for several margin profiles at once.
 *
 * This is what makes the feature usable for a real week: a client serving ten
 * customers on ten margins was otherwise doing ten preview-and-publish rounds per
 * vendor sheet per day, which is the manual work this was meant to remove.
 *
 * Each profile is priced and checked on its own, and a profile that is not ready is
 * REPORTED and skipped — one bad margin must not stop the other nine going out, and
 * must not go out half-priced either.
 */
exports.publishFuelSheetBatch = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid sheet id.' });

  const ids = Array.isArray(req.body?.profiles) ? req.body.profiles : [];
  if (!ids.length) return res.status(400).json({ status: false, code: 'no_profiles', message: 'Choose at least one margin profile to publish.' });
  if (ids.length > 50) return res.status(400).json({ status: false, code: 'too_many_profiles', message: 'Publish at most 50 sheets at a time.' });
  const clean = ids.map((x) => objectIdOrNull(x));
  if (clean.some((x) => x === undefined || x === null)) {
    return res.status(400).json({ status: false, message: 'One of the margin profiles is not a valid id.' });
  }

  const sheet = await FuelPriceSheet.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!sheet) return res.status(404).json({ status: false, message: 'Sheet not found.' });
  if (!sheet.effectiveDate) {
    return res.status(400).json({ status: false, code: 'effective_date_missing', message: 'Set the effective date before publishing.' });
  }
  if ((sheet.unparsed || []).length) {
    return res.status(400).json({
      status: false, code: 'unparsed_lines',
      message: `${sheet.unparsed.length} line(s) of the vendor sheet could not be read. Fix that before publishing anything from it.`,
    });
  }

  const company = await Company.findOne({ tenantId }).lean();
  const rows = (sheet.rows || []).map((r) => ({
    ...r,
    money: r.money instanceof Map ? Object.fromEntries(r.money) : (r.money || {}),
  }));

  const published = [];
  const skipped = [];

  for (const profileId of clean) {
    /* eslint-disable no-await-in-loop */
    const profileDoc = await FuelMarginProfile.findOne({ _id: profileId, tenantId, ...notDeleted }).lean();
    if (!profileDoc) { skipped.push({ profile: profileId, code: 'not_found', message: 'That margin profile no longer exists.' }); continue; }
    if (profileDoc.unit !== 'any' && profileDoc.unit !== sheet.unit) {
      skipped.push({ profile: profileId, name: profileDoc.name, code: 'profile_unit_mismatch', message: `"${profileDoc.name}" is written for prices in ${profileDoc.unit.replace(/_/g, ' ')}, not ${sheet.unit.replace(/_/g, ' ')}.` });
      continue;
    }
    if (profileDoc.vendor && profileDoc.vendor !== sheet.vendor) {
      skipped.push({ profile: profileId, name: profileDoc.name, code: 'profile_vendor_mismatch', message: `"${profileDoc.name}" is restricted to another vendor.` });
      continue;
    }

    let priced;
    try {
      priced = fuelMargin.priceSheet(
        { meta: sheet, columns: sheet.columns, baseColumn: sheet.baseColumn, rows },
        { name: profileDoc.name, rules: profileDoc.rules, taxMode: profileDoc.taxMode, roundingDp: profileDoc.roundingDp },
      );
    } catch (e) {
      skipped.push({ profile: profileId, name: profileDoc.name, code: e.code || 'pricing_failed', message: e.message });
      continue;
    }
    if (priced.blockers.length) {
      skipped.push({ profile: profileId, name: profileDoc.name, code: 'blocked', message: priced.blockers[0].message, blockers: priced.blockers });
      continue;
    }

    let customer = null;
    if (profileDoc.customer) {
      customer = await Customer.findOne({ _id: profileDoc.customer, tenantId }).select('company_name name').lean();
      if (!customer) { skipped.push({ profile: profileId, name: profileDoc.name, code: 'customer_missing', message: 'That profile points at a customer that no longer exists.' }); continue; }
    }

    const doc = await createOutput({
      req, tenantId, sheet, priced, profileDoc, company,
      showVendorCost: !!profileDoc.showVendorCost,
      customerId: profileDoc.customer ? String(profileDoc.customer) : null,
      customer,
      title: req.body?.title,
    });
    published.push({
      _id: doc._id, version: doc.version, rows: doc.rows.length,
      profile: profileDoc.name,
      customer: customer ? (customer.company_name || customer.name) : null,
      superseded: doc.__superseded || 0,
    });
    /* eslint-enable no-await-in-loop */
  }

  return res.json({
    status: true,
    message: skipped.length
      ? `Published ${published.length} sheet(s); ${skipped.length} could not be published.`
      : `Published ${published.length} sheet(s).`,
    published,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// Published sheets
// ---------------------------------------------------------------------------
exports.listFuelOutputs = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;

  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const q = { tenantId, ...notDeleted };
  const sheetId = objectIdOrNull(req.query.sheet);
  if (sheetId === undefined) return res.status(400).json({ status: false, message: 'Invalid sheet id.' });
  if (sheetId) q.sheet = sheetId;
  const customerId = objectIdOrNull(req.query.customer);
  if (customerId === undefined) return res.status(400).json({ status: false, message: 'Invalid customer id.' });
  if (customerId) q.customer = customerId;

  if (req.query.status) {
    const status = String(req.query.status);
    if (!['published', 'superseded'].includes(status)) {
      return res.status(400).json({ status: false, message: 'Unknown status filter.' });
    }
    q.status = status;
  }
  const [docs, total] = await Promise.all([
    FuelSheetOutput.find(q).sort({ publishedAt: -1 }).limit(limit).select('-rows')
      .populate('customer', 'company_name name').lean(),
    FuelSheetOutput.countDocuments(q),
  ]);
  return res.json({ status: true, outputs: docs, total, limit, truncated: total > docs.length });
});

exports.fuelOutputDetail = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });
  const doc = await FuelSheetOutput.findOne({ _id: req.params.id, tenantId, ...notDeleted })
    .populate('customer', 'company_name name').lean();
  if (!doc) return res.status(404).json({ status: false, message: 'Published sheet not found.' });
  return res.json({ status: true, output: doc });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** One renderer for both the preview and the published document, so they cannot drift. */
async function renderSheetPdf(out, { logo, company, preview }) {
  const { launchBrowser, hardenPage } = require('../utils/puppeteer');
  const html = buildFuelSheetHtml(out, { logo, company, preview });
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await hardenPage(page);
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    const pdf = await page.pdf({
      format: 'letter',
      landscape: true,
      printBackground: true,
      margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' },
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function outputForRender(doc) {
  const b = doc.brandingSnapshot || {};
  return {
    title: doc.title,
    version: doc.version,
    unit: doc.unit,
    currency: doc.currency,
    dp: doc.dp,
    effectiveDate: doc.effectiveDate,
    effectiveTo: doc.effectiveTo,
    columns: doc.columns,
    taxColumns: doc.taxColumns,
    totalColumn: doc.totalColumn,
    showVendorCost: doc.showVendorCost,
    customerName: b.customerName || '',
    rows: (doc.rows || []).map((r) => ({
      ...r,
      taxes: r.taxes instanceof Map ? Object.fromEntries(r.taxes) : (r.taxes || {}),
    })),
  };
}

exports.fuelOutputPdf = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });

  const doc = await FuelSheetOutput.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!doc) return res.status(404).json({ status: false, message: 'Published sheet not found.' });

  const company = doc.company ? await Company.findOne({ _id: doc.company, tenantId }).lean() : await Company.findOne({ tenantId }).lean();
  const logo = await resolveCompanyLogoBase64(company).catch(() => '');

  let buffer;
  try {
    buffer = await renderSheetPdf(outputForRender(doc), { logo, company: doc.brandingSnapshot || company, preview: false });
  } catch (e) {
    if (e.code === 'chrome_missing') return res.status(500).json({ status: false, code: e.code, message: e.message });
    throw e;
  }

  await logChange(req, {
    model: 'FuelSheetOutput', module: 'fuel_pricing', action: 'DOWNLOAD',
    resourceId: doc._id, resourceName: `${doc.title} v${doc.version}`,
    description: `Downloaded ${doc.vendorLabel} price sheet v${doc.version}`, logUnchanged: true,
  }).catch(() => {});

  const name = `${(doc.title || 'fuel-prices').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${doc.effectiveDate || ''}-v${doc.version}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return res.end(buffer);
});

/** A preview PDF of an unpublished sheet — watermarked, and it writes nothing. */
exports.previewFuelSheetPdf = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  const loaded = await loadForPricing(req, res, tenantId);
  if (!loaded) return undefined;
  const { sheet, priced, showVendorCost } = loaded;

  const company = await Company.findOne({ tenantId }).lean();
  const logo = await resolveCompanyLogoBase64(company).catch(() => '');
  const out = {
    // Read from the request: `title` is a parameter of createOutput, not a variable in
    // scope here. Referencing it made every preview PDF a 500 with the user told only
    // that the document could not be produced — the same undeclared-variable fault as
    // updateOrderPaymentStatus, and the reason "the PDF never rendered".
    title: String(req.body?.title || 'Fuel Price Sheet').slice(0, 120),
    unit: priced.unit, currency: priced.currency, dp: priced.dp,
    effectiveDate: sheet.effectiveDate, effectiveTo: sheet.effectiveTo,
    columns: sheet.columns, taxColumns: priced.taxColumns, totalColumn: priced.totalColumn,
    showVendorCost,
    rows: priced.rows.filter((r) => r.priced),
  };

  let buffer;
  try {
    buffer = await renderSheetPdf(out, { logo, company, preview: true });
  } catch (e) {
    if (e.code === 'chrome_missing') return res.status(500).json({ status: false, code: e.code, message: e.message });
    throw e;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="fuel-price-sheet-preview.pdf"');
  return res.end(buffer);
});

// ---------------------------------------------------------------------------
// CSV — the back office wants the numbers, not a document
// ---------------------------------------------------------------------------
const csvCell = (v) => {
  const s = String(v === null || v === undefined ? '' : v);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

exports.fuelOutputCsv = catchAsync(async (req, res) => {
  if (!hasFuelPricingAccess(req.user)) return deny(res);
  const tenantId = needTenant(req, res); if (!tenantId) return undefined;
  if (!validId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });

  const doc = await FuelSheetOutput.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!doc) return res.status(404).json({ status: false, message: 'Published sheet not found.' });

  const { fmtMoney } = require('../utils/fuelParsers/shared');
  const textCols = (doc.columns || []).filter((c) => c.kind === 'text');
  const taxCols = (doc.taxColumns || []).map((k) => (doc.columns || []).find((c) => c.key === k)).filter(Boolean);
  const header = [
    ...textCols.map((c) => c.label),
    ...(doc.showVendorCost ? ['Vendor', 'Margin'] : []),
    'Price',
    ...taxCols.map((c) => c.label),
    ...(doc.totalColumn ? ['Total'] : []),
  ];
  const lines = [header.map(csvCell).join(',')];
  (doc.rows || []).forEach((r) => {
    const taxes = r.taxes instanceof Map ? Object.fromEntries(r.taxes) : (r.taxes || {});
    lines.push([
      ...textCols.map((c) => (r.text || {})[c.key] || ''),
      ...(doc.showVendorCost ? [fmtMoney(r.baseInt, doc.dp), fmtMoney(r.marginInt, doc.dp)] : []),
      fmtMoney(r.finalInt, doc.dp),
      ...taxCols.map((c) => (taxes[c.key] === undefined ? '' : fmtMoney(taxes[c.key], doc.dp))),
      ...(doc.totalColumn ? [fmtMoney(r.totalInt, doc.dp)] : []),
    ].map(csvCell).join(','));
  });

  await logChange(req, {
    model: 'FuelSheetOutput', module: 'fuel_pricing', action: 'EXPORT',
    resourceId: doc._id, resourceName: `${doc.title} v${doc.version}`,
    description: `Exported ${doc.vendorLabel} price sheet v${doc.version} as CSV`, logUnchanged: true,
  }).catch(() => {});

  const name = `${(doc.title || 'fuel-prices').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${doc.effectiveDate || ''}-v${doc.version}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return res.end(`﻿${lines.join('\n')}`);
});
