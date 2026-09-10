const catchAsync = require('../utils/catchAsync');
const BankAccount = require('../db/BankAccount');
const PaymentCheque = require('../db/PaymentCheque');
const Counter = require('../db/Counter');
const { logChange } = require('../utils/activityLogger');
const { hasChequeAccess } = require('./vendorController');
const { buildAlignmentSheetHtml } = require('../utils/chequeHtml');
const { logActivity } = require('../utils/activityLogger');

const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * Print settings off a request body — only keys that are actually present, so a
 * partial update never resets a setting the caller did not mention (the same
 * rule as `editCustomer.assigned_to`).
 */
function parsePrintSettings(body) {
  const out = {};
  if (body.printMode !== undefined && ['blank', 'preprinted'].includes(body.printMode)) {
    out.printMode = body.printMode;
  }
  if (body.chequePosition !== undefined && ['top', 'middle', 'bottom'].includes(body.chequePosition)) {
    out.chequePosition = body.chequePosition;
  }
  if (body.chequeHeightIn !== undefined) {
    const n = Number(body.chequeHeightIn);
    // CPA 006 caps a business cheque at 3.75in; below 2.75in it is not one.
    if (Number.isFinite(n)) out.chequeHeightIn = clamp(n, 2.75, 3.75);
  }
  for (const k of ['offsetXmm', 'offsetYmm']) {
    if (body[k] !== undefined) {
      const n = Number(body[k]);
      if (Number.isFinite(n)) out[k] = clamp(n, -25, 25);
    }
  }
  if (body.printChequeNumber !== undefined) out.printChequeNumber = !!body.printChequeNumber;
  if (body.dateFormat !== undefined && ['YYYYMMDD', 'MMDDYYYY', 'DDMMYYYY'].includes(body.dateFormat)) {
    out.dateFormat = body.dateFormat;
  }
  if (body.layoutOverrides !== undefined) {
    // Null clears back to the spec defaults.
    out.layoutOverrides = sanitizeLayoutOverrides(body.layoutOverrides);
  }
  return out;
}

/**
 * Field position overrides are merged over the spec defaults and interpolated
 * straight into a `style` attribute on the rendered cheque, so they are
 * validated key by key rather than stored as given.
 *
 * Two reasons, and the second is the one that matters on a cheque:
 *  - a string where a number belongs ("abc") produces `left:abcin`, which the
 *    browser drops — the field silently falls back to its default position and
 *    prints in the wrong place on numbered stock;
 *  - an unchecked `align` could carry a quote and close the attribute.
 *
 * Anything not recognised is dropped, never passed through.
 */
const LAYOUT_FIELDS = ['amountFigures', 'amountWords', 'payee', 'date', 'memo', 'chequeNo', 'currencyNote'];
const LAYOUT_NUMERIC = {
  // key: [min, max] in inches, except font size in points.
  left: [0, 8.5], right: [0, 8.5], width: [0.2, 8.5], top: [0, 4],
  bottomCentre: [0, 4], belowAmount: [0, 3], aboveMicr: [0, 3],
  size: [5, 24], lineHeight: [0.8, 3],
};

function sanitizeLayoutOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const field of LAYOUT_FIELDS) {
    const src = raw[field];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const clean = {};
    for (const [key, [lo, hi]] of Object.entries(LAYOUT_NUMERIC)) {
      if (src[key] === undefined) continue;
      const n = Number(src[key]);
      if (Number.isFinite(n)) clean[key] = clamp(n, lo, hi);
    }
    if (src.align !== undefined && ['left', 'right', 'center'].includes(src.align)) clean.align = src.align;
    for (const flag of ['bold', 'nowrap', 'clip']) {
      if (src[flag] !== undefined) clean[flag] = !!src[flag];
    }
    if (Object.keys(clean).length) out[field] = clean;
  }
  return Object.keys(out).length ? out : null;
}

exports._sanitizeLayoutOverrides = sanitizeLayoutOverrides;

// GET /bank-accounts?includeInactive=true
exports.listBankAccounts = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage bank accounts.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const criteria = { tenantId, ...notDeleted };
  if (String(req.query.includeInactive) !== 'true') criteria.active = true;
  const rows = await BankAccount.find(criteria).sort({ name: 1 });
  const accounts = rows.map((a) => ({ ...a.toObject(), label: a.printedLabel() }));
  return res.json({ status: true, accounts });
});

// POST /bank-accounts/add
exports.addBankAccount = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage bank accounts.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ status: false, message: 'Please enter an account name.' });
  const chequeStart = Number(req.body.chequeStart);

  const account = await BankAccount.create({
    tenantId,
    company: req.user?.company?._id || req.user?.company || null,
    name,
    bankName: String(req.body.bankName || '').trim(),
    accountNo: String(req.body.accountNo || '').trim(),
    currency: ['USD', 'CAD', 'INR'].includes(String(req.body.currency || '').toUpperCase()) ? String(req.body.currency).toUpperCase() : '',
    chequeStart: Number.isFinite(chequeStart) && chequeStart >= 1 ? Math.floor(chequeStart) : 1001,
    notes: String(req.body.notes || '').trim(),
    ...parsePrintSettings(req.body),
    created_by: req.user?._id,
  });

  logChange(req, {
    model: 'BankAccount', module: 'cheque', after: account.toObject(),
    resourceId: account._id, resourceName: account.name,
    description: `Bank account "${account.name}" added`,
  });
  return res.json({ status: true, message: 'Bank account added.', account: { ...account.toObject(), label: account.printedLabel() } });
});

// POST /bank-accounts/update/:id
exports.updateBankAccount = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage bank accounts.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const before = await BankAccount.findOne({ _id: req.params.id, tenantId, ...notDeleted });
  if (!before) return res.status(404).json({ status: false, message: 'Bank account not found.' });
  const beforeObj = before.toObject();

  const update = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ status: false, message: 'Account name cannot be empty.' });
    update.name = name;
  }
  ['bankName', 'accountNo', 'notes'].forEach((k) => {
    if (req.body[k] !== undefined) update[k] = String(req.body[k] || '').trim();
  });
  if (req.body.currency !== undefined) {
    const cur = String(req.body.currency || '').toUpperCase();
    update.currency = ['USD', 'CAD', 'INR'].includes(cur) ? cur : '';
  }
  if (req.body.active !== undefined) update.active = !!req.body.active;
  Object.assign(update, parsePrintSettings(req.body));
  if (req.body.chequeStart !== undefined) {
    const n = Number(req.body.chequeStart);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ status: false, message: 'Next cheque number must be a positive number.' });
    update.chequeStart = Math.floor(n);
    // The operator says the book is now at N: never let the counter hand out
    // anything lower. (It can already be ahead — that is fine.)
    await Counter.bumpTo(tenantId, `cheque_no_acct:${before._id}`, Math.floor(n) - 1);
  }

  const account = await BankAccount.findOneAndUpdate(
    { _id: req.params.id, tenantId },
    { $set: update },
    { new: true, runValidators: true }
  );

  logChange(req, {
    model: 'BankAccount', module: 'cheque', before: beforeObj, after: account.toObject(),
    resourceId: account._id, resourceName: account.name,
  });
  return res.json({ status: true, message: 'Bank account updated.', account: { ...account.toObject(), label: account.printedLabel() } });
});

// GET /bank-accounts/remove/:id — soft delete; cheques keep their snapshot label.
exports.deleteBankAccount = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage bank accounts.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const before = await BankAccount.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Bank account not found.' });

  const chequeCount = await PaymentCheque.countDocuments({ tenantId, bankAccount: before._id });
  const account = await BankAccount.findOneAndUpdate(
    { _id: req.params.id, tenantId },
    { $set: { deletedAt: new Date(), active: false } },
    { new: true }
  );

  logChange(req, {
    model: 'BankAccount', module: 'cheque', before, after: account.toObject(),
    resourceId: account._id, resourceName: account.name,
    description: `Bank account "${account.name}" deleted (${chequeCount} cheque(s) keep their snapshot)`,
  });
  return res.json({ status: true, message: 'Bank account removed. Existing cheques keep their printed label.' });
});


/**
 * GET /bank-accounts/:id/alignment-sheet — the calibration page, on PLAIN paper.
 *
 * Cheque stock is numbered: every misfed sheet is a void cheque that has to be
 * recorded and destroyed. Finding the printer's drift on blank paper first
 * costs nothing, which is why this exists rather than "print one and see".
 */
exports.alignmentSheet = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage bank accounts.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const account = await BankAccount.findOne({ _id: req.params.id, tenantId, ...notDeleted });
  if (!account) return res.status(404).json({ status: false, message: 'Bank account not found.' });

  // Preview a nudge without saving it, so the operator can converge in a few
  // prints instead of writing a wrong value onto the account each time.
  const spec = account.printSpec();
  if (req.query.offsetXmm !== undefined) {
    const n = Number(req.query.offsetXmm);
    if (Number.isFinite(n)) spec.offsetXmm = clamp(n, -25, 25);
  }
  if (req.query.offsetYmm !== undefined) {
    const n = Number(req.query.offsetYmm);
    if (Number.isFinite(n)) spec.offsetYmm = clamp(n, -25, 25);
  }

  const html = buildAlignmentSheetHtml(spec, account.layoutOverrides, account);

  const { launchBrowser, hardenPage } = require('../utils/puppeteer');
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await hardenPage(page);
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    const pdfBuffer = await page.pdf({
      format: 'Letter', printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    await browser.close();
    browser = null;

    logActivity(req, {
      action: 'DOWNLOAD', module: 'cheque',
      description: `Printed the cheque alignment sheet for "${account.name}"`,
      resourceId: account._id, resourceName: account.name,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cheque-alignment-${String(account.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf"`);
    return res.end(pdfBuffer);
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (e) { /* noop */ } }
    if (err?.code === 'chrome_missing') {
      return res.status(500).json({ status: false, code: 'chrome_missing', message: err.message });
    }
    return res.status(500).json({ status: false, message: 'Failed to generate the alignment sheet.' });
  }
});
