/**
 * Carrier onboarding — a single-use link that walks a carrier through the setup
 * packet, collects their documents, and has them sign the Broker / Carrier
 * Agreement.
 *
 * Rules (see CLAUDE.md "Carrier onboarding links"):
 *  - A link works until it is submitted, revoked or expired — never twice.
 *  - The signed PDF is rendered ONCE at submit and stored with its SHA-256.
 *  - Full bank account / tax id numbers go out in the notification email only;
 *    the database keeps the masked form.
 *  - Submitting creates the carrier (or links an existing one with the same MC)
 *    and files the attached documents on it as typed carrier documents.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const CarrierOnboarding = require('../db/CarrierOnboarding');
const CarrierOnboardingKey = require('../db/CarrierOnboardingKey');
const Company = require('../db/Company');
const Carrier = require('../db/Carrier');
const FleetDoc = require('../db/FleetDoc');
const fileupload = require('../utils/fileupload');
const sendEmail = require('../utils/Email');
const { logActivity } = require('../utils/activityLogger');
const { resolveCompanyLogoBase64 } = require('../utils/pdfBranding');
const { hasCarrierAccess } = require('../utils/entityVisibility');
const spec = require('../utils/carrierOnboardingSpec');
const { buildCarrierPacketHtml, safeImg } = require('../utils/carrierPacketHtml');
const { TEMPLATE_VERSION, BROKER_PARTY } = require('../utils/carrierAgreementText');

const TOKEN_RE = /^[A-Za-z0-9_-]{24,80}$/;
const OPEN_STATUSES = ['sent', 'opened', 'in_progress'];
const MAX_FILES = 25;
const MAX_SIGNATURE_BYTES = 300 * 1024;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']);

/* ------------------------------------------------------------------ *
 * Gates
 * ------------------------------------------------------------------ */
const permsOf = (u) => (Array.isArray(u?.permissions) ? u.permissions : []);
const isFullAdmin = (u) => !!u && (u.is_admin === 1 || Number(u.role) === 3 || u.isTenantAdmin === true);
// Sending a link creates a carrier on submit, so it needs carrier write access.
const canManageOnboarding = (u) => isFullAdmin(u) || ['carriers_write', 'subadmin'].some((p) => permsOf(u).includes(p));

function tenantOf(req, res) {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    res.status(400).json({ status: false, message: 'Tenant context is required.' });
    return null;
  }
  return tenantId;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
async function loadBroker(tenantId) {
  const company = await Company.findOne({ tenantId }).lean();
  return {
    company,
    broker: {
      ...BROKER_PARTY,
      email: company?.email || '',
      address: company?.address || '',
    },
  };
}

const isExpired = (doc) => doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now();

function effectiveStatus(doc) {
  if (['submitted', 'revoked'].includes(doc.status)) return doc.status;
  if (doc.status === 'submitting') return 'submitting';
  return isExpired(doc) ? 'expired' : doc.status;
}

function linkGone(res, doc) {
  const st = doc ? effectiveStatus(doc) : 'missing';
  const map = {
    missing: [404, 'link_not_found', 'This link is not valid. Please ask for a new one.'],
    submitted: [410, 'already_submitted', 'This packet has already been signed and submitted. Thank you!'],
    submitting: [409, 'submitting', 'This packet is being submitted right now.'],
    revoked: [410, 'link_revoked', 'This link has been cancelled. Please ask for a new one.'],
    expired: [410, 'link_expired', 'This link has expired. Please ask for a new one.'],
  };
  const [code, key, message] = map[st] || map.missing;
  return res.status(code).json({ status: false, code: key, message });
}

async function findOpenLink(req, res) {
  const token = String(req.params.token || '');
  if (!TOKEN_RE.test(token)) { linkGone(res, null); return null; }
  const doc = await CarrierOnboarding.findOne({ token, deletedAt: null });
  if (!doc || !OPEN_STATUSES.includes(doc.status) || isExpired(doc)) { linkGone(res, doc); return null; }
  return doc;
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.ip || req.socket?.remoteAddress || '').slice(0, 64);
}

function publicFiles(files = []) {
  return files.map((f) => ({ _id: f._id, kind: f.kind, name: f.name, mime: f.mime, size: f.size, uploadedAt: f.uploadedAt }));
}

async function renderPdf(html) {
  const { launchBrowser, hardenPage } = require('../utils/puppeteer');
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await hardenPage(page);
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: { top: '10mm', bottom: '12mm', left: '8mm', right: '8mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#777">Carrier Setup Packet — page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Who gets this company's signed packets: the dashboard setting, else the company email. */
async function recipients(tenantId, broker) {
  const k = await CarrierOnboardingKey.findOne({ tenantId }).select('notifyEmails').lean();
  const list = (k?.notifyEmails || []).filter(Boolean);
  if (!list.length && broker?.email) list.push(broker.email);
  return [...new Set(list)];
}

const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function emailBody({ data, files, doc, broker, masked }) {
  const sections = spec.SECTIONS.map((s) => {
    const rows = s.fields.filter((f) => spec.isShown(f, data) && data[f.key] !== undefined && data[f.key] !== '')
      .map((f) => `<tr><td style="padding:4px 10px;color:#555;border-bottom:1px solid #eee;width:45%">${escHtml(f.label)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee"><b>${escHtml(spec.displayValue(f, data[f.key]))}</b></td></tr>`).join('');
    return rows ? `<h3 style="margin:18px 0 6px;font:600 14px Arial">${escHtml(s.title)}</h3><table style="border-collapse:collapse;width:100%;font:13px Arial">${rows}</table>` : '';
  }).join('');
  const docRows = files.map((f) => {
    const label = spec.DOCUMENTS.find((d) => d.kind === f.kind)?.label || f.kind;
    return `<li>${escHtml(label)}: <a href="${escHtml(f.url)}">${escHtml(f.name)}</a></li>`;
  }).join('');
  return `<div style="font:13px Arial;color:#111">
    <p>A carrier has signed the setup packet${broker?.name ? ` for <b>${escHtml(broker.name)}</b>` : ''}. <b>It is waiting for approval</b> — open Carriers → Onboarding links in the dashboard to approve it; the carrier is added only then.</p>
    <p><b>${escHtml(data.legalName)}</b> — MC# ${escHtml(data.mcNumber)} · USDOT# ${escHtml(data.dotNumber)}<br/>
    Signed by ${escHtml(doc.signature?.name)}${doc.signature?.title ? `, ${escHtml(doc.signature.title)}` : ''} at ${escHtml(new Date(doc.submittedAt || Date.now()).toISOString())} (IP ${escHtml(doc.signature?.ip)})</p>
    ${masked ? '<p style="color:#a00"><b>Note:</b> this is a re-send — bank account and tax id are masked. The full values were in the original email only.</p>' : '<p style="color:#a00"><b>Keep this email safe:</b> it is the only place the full bank account and tax id numbers were sent. The app stores them masked.</p>'}
    ${sections}
    <h3 style="margin:18px 0 6px;font:600 14px Arial">Documents</h3>
    <ul>${docRows || '<li>None</li>'}</ul>
    <p style="color:#777;font-size:12px">Signed packet attached. SHA-256: ${escHtml(doc.pdfHash)}</p>
  </div>`;
}

/**
 * Send the packet email. `fullData` is the unmasked answers — passed only from
 * submit, where they exist in memory and nowhere else. Never throws.
 */
async function sendPacketEmail({ doc, fullData, broker, pdf }) {
  const to = await recipients(doc.tenantId, broker);
  if (!to.length || !sendEmail.isEmailConfigured()) {
    await CarrierOnboarding.updateOne({ _id: doc._id }, { $set: { emailStatus: 'not_configured', emailError: !to.length ? 'No recipient: add an email under "Signed packets are emailed to" on the onboarding page.' : 'SMTP is not configured.' } });
    return { ok: false, code: 'not_configured' };
  }
  const data = fullData || doc.data || {};
  const name = (data.legalName || 'carrier').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
  const base = {
    email: to.join(', '),
    subject: `Carrier setup packet signed — ${data.legalName || 'Carrier'} (MC# ${data.mcNumber || '—'})`,
    message: emailBody({ data, files: doc.files || [], doc, broker, masked: !fullData }),
    replyTo: data.email || undefined,
  };
  const pdfAttachment = { filename: `${name}-setup-packet-signed.pdf`, content: pdf, contentType: 'application/pdf' };
  const docAttachments = (doc.files || []).filter((f) => f.url).map((f) => ({ filename: f.name || f.filename, path: f.url }));
  try {
    try {
      await sendEmail({ ...base, attachments: [pdfAttachment, ...docAttachments] });
    } catch (err) {
      // A document the mail client could not fetch must not cost the packet itself:
      // retry with the signed PDF only — the documents are linked in the body.
      if (!docAttachments.length) throw err;
      await sendEmail({ ...base, attachments: [pdfAttachment] });
    }
    await CarrierOnboarding.updateOne({ _id: doc._id }, { $set: { emailStatus: 'sent', emailError: '', emailSentAt: new Date(), emailTo: to } });
    return { ok: true, to };
  } catch (err) {
    await CarrierOnboarding.updateOne({ _id: doc._id }, { $set: { emailStatus: 'failed', emailError: String(err?.message || err).slice(0, 500), emailTo: to } });
    return { ok: false, code: 'failed', message: err?.message };
  }
}

/** Create (or find) the carrier and file the documents on it. Never throws. */
async function upsertCarrierFromPacket({ req, doc, data }) {
  const tenantId = doc.tenantId;
  const companyId = doc.company || null;
  const scope = { tenantId, deletedAt: null, ...(companyId ? { company: companyId } : {}) };
  const email = String(data.email || '').toLowerCase();
  let carrier = await Carrier.findOne({ ...scope, mc_code: data.mcNumber });
  let matched = !!carrier;
  if (!carrier && email) {
    carrier = await Carrier.findOne({ ...scope, email });
    matched = !!carrier;
  }
  if (!carrier) {
    let carrierID;
    for (let i = 0; i < 20; i += 1) {
      carrierID = `CR_ID${Math.floor(100000 + Math.random() * 900000)}`;
      // eslint-disable-next-line no-await-in-loop
      if (!(await Carrier.exists({ tenantId, ...(companyId ? { company: companyId } : {}), carrierID }))) break;
    }
    const emails = [{ email, is_primary: true, created_at: new Date() }];
    if (data.dispatchEmail && data.dispatchEmail !== email) emails.push({ email: data.dispatchEmail, is_primary: false, created_at: new Date() });
    carrier = await Carrier.create({
      tenantId,
      company: companyId,
      name: data.legalName,
      mc_code: data.mcNumber,
      phone: data.phone,
      email,
      emails,
      secondary_email: data.dispatchEmail || undefined,
      secondary_phone: data.afterHoursPhone || undefined,
      country: data.country,
      state: data.state,
      city: data.city,
      zipcode: data.zip,
      location: data.address,
      carrierID,
      created_by: req?.user?._id || doc.createdBy,
      onboarding: doc._id,
    });
    logActivity(req, {
      tenantId, action: 'CREATE', module: 'carrier',
      description: `Carrier "${carrier.name}" (MC: ${carrier.mc_code}) created by approving a signed setup packet`,
      resourceId: carrier._id, resourceName: carrier.name,
    });
  }

  const expiryFor = { coi: data.insuranceExpiry, workers_comp: data.wcExpiry, hazmat: data.hazmatExpiry };
  const numberFor = { coi: data.autoPolicyNo || data.cargoPolicyNo, workers_comp: data.wcPolicyNo, hazmat: data.hazmatRegNo, authority: data.mcNumber };
  for (const f of doc.files || []) {
    const d = spec.DOCUMENTS.find((x) => x.kind === f.kind);
    const exp = expiryFor[f.kind];
    try {
      // eslint-disable-next-line no-await-in-loop
      await FleetDoc.create({
        tenantId, type: 'carrier', entityId: carrier._id,
        name: f.name, mime: f.mime, size: String(f.size || ''), filename: f.filename, url: f.url,
        docType: d?.docType || 'other',
        docTypeLabel: d?.docType === 'other' ? (d?.label || 'Document') : null,
        docNumber: numberFor[f.kind] || null,
        expiryDate: exp ? new Date(`${exp}T00:00:00.000Z`) : null,
        added_by: doc.createdBy || null,
      });
    } catch (err) {
      console.error('[carrierOnboarding] could not file document', f.kind, err.message);
    }
  }
  return { carrier, matched };
}

/** Put the signed agreement on the carrier's documents too. Best-effort. */
async function fileSignedAgreement({ doc, carrier, pdf, data }) {
  const tmp = path.join(os.tmpdir(), `onboarding-${doc._id}.pdf`);
  try {
    fs.writeFileSync(tmp, pdf);
    const up = await fileupload({ path: tmp, originalname: `${data.legalName || 'carrier'}-agreement-signed.pdf`, filename: String(doc._id), mimetype: 'application/pdf', size: pdf.length });
    if (!up) return;
    await FleetDoc.create({
      tenantId: doc.tenantId, type: 'carrier', entityId: carrier._id,
      name: 'Signed Broker / Carrier Agreement.pdf', mime: 'application/pdf', size: String(pdf.length),
      filename: up.filename, url: up.url, docType: 'agreement',
      issueDate: new Date(), added_by: doc.createdBy || null,
    });
  } catch (err) {
    console.error('[carrierOnboarding] could not file signed agreement', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Public — the carrier's side (no login; the token is the credential)
 * ------------------------------------------------------------------ */
exports.publicGet = catchAsync(async (req, res) => {
  const doc = await findOpenLink(req, res);
  if (!doc) return;
  if (doc.status === 'sent') {
    doc.status = 'opened';
    doc.openedAt = new Date();
    await doc.save();
  }
  const { broker, company } = await loadBroker(doc.tenantId);
  const logo = company ? await resolveCompanyLogoBase64(company).catch(() => '') : '';
  return res.json({
    status: true,
    spec: spec.publicSpec(),
    data: doc.data || {},
    files: publicFiles(doc.files),
    expiresAt: doc.expiresAt,
    invitedName: doc.invitedName,
    broker: { name: broker.name, mc: broker.mc, dot: broker.dot, phone: broker.phone, email: broker.email, logo: safeImg(logo) },
  });
});

exports.publicSaveDraft = catchAsync(async (req, res) => {
  const doc = await findOpenLink(req, res);
  if (!doc) return;
  doc.data = spec.sanitize(req.body?.data);
  doc.markModified('data');
  doc.status = 'in_progress';
  doc.lastSavedAt = new Date();
  await doc.save();
  return res.json({ status: true, savedAt: doc.lastSavedAt, data: doc.data });
});

exports.publicUploadFile = catchAsync(async (req, res) => {
  const file = req.file;
  const cleanupTmp = () => { if (file?.path) fs.unlink(file.path, () => {}); };
  const doc = await findOpenLink(req, res);
  if (!doc) { cleanupTmp(); return; }
  const kind = String(req.body?.kind || '');
  const def = spec.DOCUMENTS.find((d) => d.kind === kind);
  if (!def) { cleanupTmp(); return res.status(400).json({ status: false, code: 'invalid_kind', message: 'Unknown document type.' }); }
  if (!file) return res.status(400).json({ status: false, code: 'file_required', message: 'Choose a file to upload.' });
  if (!ALLOWED_MIME.has(file.mimetype)) {
    cleanupTmp();
    return res.status(400).json({ status: false, code: 'file_type', message: 'Upload a PDF or a photo (JPG / PNG).' });
  }
  if ((doc.files || []).length >= MAX_FILES) {
    cleanupTmp();
    return res.status(400).json({ status: false, code: 'too_many_files', message: `At most ${MAX_FILES} files per packet.` });
  }
  const up = await fileupload(file); // removes the temp file itself
  if (!up) return res.status(502).json({ status: false, code: 'file_upload_failed', message: 'The file could not be stored. Please try again.' });

  // One file per document type, except "anything else" — a replaced COI must not
  // leave the old one beside it.
  const entry = { kind, name: String(file.originalname || '').slice(0, 200), mime: file.mimetype, size: file.size, filename: up.filename, url: up.url, uploadedAt: new Date() };
  const fresh = await CarrierOnboarding.findOneAndUpdate(
    { _id: doc._id, status: { $in: OPEN_STATUSES } },
    def.multiple
      ? { $push: { files: entry }, $set: { status: 'in_progress' } }
      : { $set: { files: [...doc.files.filter((f) => f.kind !== kind).map((f) => f.toObject()), entry], status: 'in_progress' } },
    { new: true },
  );
  if (!fresh) return linkGone(res, await CarrierOnboarding.findById(doc._id));
  return res.json({ status: true, files: publicFiles(fresh.files) });
});

exports.publicRemoveFile = catchAsync(async (req, res) => {
  const doc = await findOpenLink(req, res);
  if (!doc) return;
  if (!mongoose.isValidObjectId(req.params.fileId)) return res.status(400).json({ status: false, message: 'Invalid file.' });
  const fresh = await CarrierOnboarding.findOneAndUpdate(
    { _id: doc._id, status: { $in: OPEN_STATUSES } },
    { $pull: { files: { _id: req.params.fileId } } },
    { new: true },
  );
  return res.json({ status: true, files: publicFiles(fresh?.files || []) });
});

function readSignature(body) {
  const sig = body?.signature || {};
  const image = typeof sig.image === 'string' ? sig.image : '';
  const name = String(sig.name || '').trim().slice(0, 120);
  const title = String(sig.title || '').trim().slice(0, 80);
  return { image, name, title };
}

exports.publicPreview = catchAsync(async (req, res) => {
  const doc = await findOpenLink(req, res);
  if (!doc) return;
  const data = spec.sanitize(req.body?.data ?? doc.data);
  const { broker, company } = await loadBroker(doc.tenantId);
  const logo = company ? await resolveCompanyLogoBase64(company).catch(() => '') : '';
  const sig = readSignature(req.body);
  const html = buildCarrierPacketHtml({
    data: spec.maskSensitive(data), files: doc.files, broker, logo, mode: 'preview',
    signature: { image: safeImg(sig.image), name: sig.name, title: sig.title, signedAt: new Date() },
  });
  return res.json({ status: true, html, errors: spec.validate(data, doc.files) });
});

exports.publicSubmit = catchAsync(async (req, res) => {
  const doc = await findOpenLink(req, res);
  if (!doc) return;
  const data = spec.sanitize(req.body?.data);
  const errors = spec.validate(data, doc.files);
  const sig = readSignature(req.body);
  if (!safeImg(sig.image)) errors.push({ key: 'signature', message: 'Please sign in the signature box.' });
  else if (Buffer.byteLength(sig.image) > MAX_SIGNATURE_BYTES) errors.push({ key: 'signature', message: 'The signature image is too large — clear it and sign again.' });
  if (sig.name.length < 2) errors.push({ key: 'signatureName', message: 'Type your full name under the signature.' });
  if (errors.length) {
    // Keep what they typed — a refused submit must not cost the form.
    await CarrierOnboarding.updateOne({ _id: doc._id }, { $set: { data, lastSavedAt: new Date(), status: 'in_progress' } });
    return res.status(400).json({ status: false, code: 'incomplete', message: errors[0].message, errors });
  }

  // Claim the link atomically: two clicks on Submit must not sign twice.
  const claimed = await CarrierOnboarding.findOneAndUpdate(
    { _id: doc._id, status: { $in: OPEN_STATUSES }, expiresAt: { $gt: new Date() } },
    { $set: { status: 'submitting' } },
    { new: true },
  );
  if (!claimed) return linkGone(res, await CarrierOnboarding.findById(doc._id));

  const submittedAt = new Date();
  const signature = {
    image: sig.image, name: sig.name, title: sig.title, signedAt: submittedAt,
    ip: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  };
  const masked = spec.maskSensitive(data);
  const { broker, company } = await loadBroker(doc.tenantId);
  const logo = company ? await resolveCompanyLogoBase64(company).catch(() => '') : '';

  let pdf;
  try {
    const html = buildCarrierPacketHtml({ data: masked, files: claimed.files, broker, signature, logo, mode: 'signed', submittedAt });
    pdf = await renderPdf(html);
  } catch (err) {
    console.error('[carrierOnboarding] PDF render failed', err);
    await CarrierOnboarding.updateOne({ _id: doc._id }, { $set: { status: 'in_progress', data } });
    return res.status(500).json({ status: false, code: 'pdf_failed', message: 'We could not produce the signed document. Nothing was submitted — please try again in a minute.' });
  }
  const pdfHash = crypto.createHash('sha256').update(pdf).digest('hex');

  claimed.data = masked;
  claimed.markModified('data');
  claimed.signature = signature;
  claimed.brokerSnapshot = { ...broker };
  claimed.templateVersion = TEMPLATE_VERSION;
  claimed.submittedAt = submittedAt;
  claimed.pdf = pdf;
  claimed.pdfHash = pdfHash;
  claimed.pdfSize = pdf.length;
  claimed.status = 'submitted';
  // Signed is not approved: the carrier is created only when an admin approves.
  claimed.review = 'pending';
  await claimed.save();

  logActivity(req, {
    tenantId: claimed.tenantId, action: 'CREATE', module: 'carrier_onboarding',
    description: `Carrier setup packet signed by ${sig.name} for "${data.legalName}" (MC ${data.mcNumber})`,
    resourceId: claimed._id, resourceName: data.legalName,
    details: { pdfHash, ip: signature.ip, templateVersion: TEMPLATE_VERSION },
  });

  res.json({ status: true, message: 'Thank you — your carrier packet has been signed and submitted.' });

  // After the response: the carrier should not wait on the mail server. The full
  // (unmasked) answers exist only in this closure.
  sendPacketEmail({ doc: claimed, fullData: data, broker, pdf }).catch(() => {});
});

/* ------------------------------------------------------------------ *
 * Dashboard — the broker's side
 * ------------------------------------------------------------------ */
function summary(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    _id: o._id,
    token: o.token,
    status: effectiveStatus(o),
    source: o.source || 'link',
    invitedName: o.invitedName,
    invitedEmail: o.invitedEmail,
    note: o.note,
    expiresAt: o.expiresAt,
    createdAt: o.createdAt,
    openedAt: o.openedAt,
    lastSavedAt: o.lastSavedAt,
    submittedAt: o.submittedAt,
    legalName: o.data?.legalName || '',
    mcNumber: o.data?.mcNumber || '',
    // Packets submitted before approval existed created their carrier at once.
    review: o.review || (o.status === 'submitted' ? (o.carrier ? 'approved' : 'pending') : null),
    reviewedAt: o.reviewedAt,
    reviewedBy: o.reviewedBy,
    rejectReason: o.rejectReason,
    carrier: o.carrier,
    carrierMatched: o.carrierMatched,
    emailStatus: o.emailStatus,
    emailError: o.emailError,
    filesCount: (o.files || []).length,
    signerName: o.signature?.name || '',
    createdBy: o.createdBy,
  };
}

const SHARED_SESSION_DAYS = 30;
const newToken = () => crypto.randomBytes(24).toString('base64url');

/** The tenant's one shared link — created on first use, then never changes. */
async function ensureSharedKey(tenantId, user) {
  const existing = await CarrierOnboardingKey.findOne({ tenantId }).lean();
  if (existing) return existing;
  try {
    return (await CarrierOnboardingKey.create({
      tenantId,
      key: newToken(),
      company: user?.company?._id || user?.company || null,
      createdBy: user?._id || null,
    })).toObject();
  } catch (err) {
    if (err?.code === 11000) return CarrierOnboardingKey.findOne({ tenantId }).lean(); // two first-opens raced
    throw err;
  }
}

/**
 * A visitor of the shared link starts THEIR OWN packet. POST (not GET) so link
 * previews and crawlers cannot create packets just by fetching the URL. The
 * packet only appears on the dashboard once something is saved in it.
 */
exports.publicStart = catchAsync(async (req, res) => {
  const key = String(req.params.key || '');
  if (!TOKEN_RE.test(key)) return linkGone(res, null);
  const k = await CarrierOnboardingKey.findOne({ key }).lean();
  if (!k) return linkGone(res, null);
  const doc = await CarrierOnboarding.create({
    tenantId: k.tenantId,
    company: k.company,
    token: newToken(),
    source: 'shared',
    status: 'opened',
    openedAt: new Date(),
    expiresAt: new Date(Date.now() + SHARED_SESSION_DAYS * 86400000),
    createdBy: k.createdBy,
  });
  return res.json({ status: true, token: doc.token });
});

exports.listLinks = catchAsync(async (req, res) => {
  if (!hasCarrierAccess(req.user)) return res.status(403).json({ status: false, message: 'Not allowed.' });
  const tenantId = tenantOf(req, res);
  if (!tenantId) return;
  const rows = await CarrierOnboarding.find({
    tenantId,
    deletedAt: null,
    // Someone who opened the shared link and typed nothing is not a lead.
    $nor: [{ source: 'shared', lastSavedAt: null, status: { $in: ['sent', 'opened'] } }],
  })
    .select('-pdf -signature.image -brokerSnapshot')
    .populate('createdBy', 'name')
    .populate('reviewedBy', 'name')
    .populate('carrier', 'name mc_code')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  const { broker } = await loadBroker(tenantId);
  return res.json({
    status: true,
    links: rows.map(summary),
    sharedKey: (await ensureSharedKey(tenantId, req.user)).key,
    setup: {
      emailTo: await recipients(tenantId, broker),
      notifyEmails: (await CarrierOnboardingKey.findOne({ tenantId }).select('notifyEmails').lean())?.notifyEmails || [],
      companyEmail: broker.email,
      emailConfigured: sendEmail.isEmailConfigured(),
      canEdit: canManageOnboarding(req.user),
    },
  });
});

exports.linkDetail = catchAsync(async (req, res) => {
  if (!hasCarrierAccess(req.user)) return res.status(403).json({ status: false, message: 'Not allowed.' });
  const tenantId = tenantOf(req, res);
  if (!tenantId) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });
  const doc = await CarrierOnboarding.findOne({ _id: req.params.id, tenantId, deletedAt: null })
    .select('-pdf').populate('createdBy', 'name').populate('reviewedBy', 'name').populate('carrier', 'name mc_code').lean();
  if (!doc) return res.status(404).json({ status: false, message: 'Not found.' });
  return res.json({
    status: true,
    link: summary(doc),
    // An in-progress draft still holds what the carrier typed — mask it here too.
    data: spec.maskSensitive(doc.data || {}),
    files: (doc.files || []).map((f) => ({ ...f })),
    signature: doc.signature ? { ...doc.signature } : null,
    pdfHash: doc.pdfHash,
    templateVersion: doc.templateVersion,
    spec: spec.publicSpec(),
  });
});

exports.linkPdf = catchAsync(async (req, res) => {
  if (!hasCarrierAccess(req.user)) return res.status(403).json({ status: false, message: 'Not allowed.' });
  const tenantId = tenantOf(req, res);
  if (!tenantId) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });
  const doc = await CarrierOnboarding.findOne({ _id: req.params.id, tenantId, deletedAt: null }).select('+pdf data status');
  if (!doc || doc.status !== 'submitted' || !doc.pdf) return res.status(404).json({ status: false, message: 'This packet has not been signed yet.' });
  const name = (doc.data?.legalName || 'carrier').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
  logActivity(req, { action: 'DOWNLOAD', module: 'carrier_onboarding', description: `Downloaded signed setup packet of "${doc.data?.legalName || ''}"`, resourceId: doc._id, resourceName: doc.data?.legalName || '' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}-setup-packet-signed.pdf"`);
  res.setHeader('Content-Length', doc.pdf.length);
  return res.end(Buffer.from(doc.pdf));
});

exports.revokeLink = catchAsync(async (req, res) => {
  if (!canManageOnboarding(req.user)) return res.status(403).json({ status: false, message: 'Not allowed.' });
  const tenantId = tenantOf(req, res);
  if (!tenantId) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });
  const doc = await CarrierOnboarding.findOneAndUpdate(
    { _id: req.params.id, tenantId, deletedAt: null, status: { $in: OPEN_STATUSES } },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: req.user._id } },
    { new: true },
  );
  if (!doc) return res.status(409).json({ status: false, code: 'not_revocable', message: 'Only a link that has not been submitted can be cancelled.' });
  // A cancelled draft never becomes a packet — drop the full bank / tax numbers it held.
  await CarrierOnboarding.updateOne({ _id: doc._id }, { $set: { data: spec.maskSensitive(doc.data || {}) } });
  logActivity(req, { action: 'STATUS_CHANGE', module: 'carrier_onboarding', description: `Cancelled carrier setup link${doc.invitedName ? ` for ${doc.invitedName}` : ''}`, resourceId: doc._id, resourceName: doc.invitedName || '' });
  return res.json({ status: true, link: summary(doc) });
});

exports.resendEmail = catchAsync(async (req, res) => {
  if (!hasCarrierAccess(req.user)) return res.status(403).json({ status: false, message: 'Not allowed.' });
  const tenantId = tenantOf(req, res);
  if (!tenantId) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });
  const doc = await CarrierOnboarding.findOne({ _id: req.params.id, tenantId, deletedAt: null }).select('+pdf');
  if (!doc || doc.status !== 'submitted' || !doc.pdf) return res.status(404).json({ status: false, message: 'This packet has not been signed yet.' });
  const broker = doc.brokerSnapshot || (await loadBroker(tenantId)).broker;
  const out = await sendPacketEmail({ doc, fullData: null, broker, pdf: Buffer.from(doc.pdf) });
  if (!out.ok) {
    const fresh = await CarrierOnboarding.findById(doc._id).select('emailError').lean();
    return res.status(out.code === 'not_configured' ? 400 : 502).json({ status: false, code: out.code === 'not_configured' ? 'email_not_configured' : 'email_send_failed', message: fresh?.emailError || 'The email could not be sent.' });
  }
  return res.json({ status: true, message: `Sent to ${out.to.join(', ')}.` });
});

exports.approvePacket = catchAsync(async (req, res) => {
  if (!canManageOnboarding(req.user)) return res.status(403).json({ status: false, message: 'You are not allowed to approve carriers.' });
  const tenantId = tenantOf(req, res);
  if (!tenantId) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });
  // Claim it: two clicks on Approve must not create the carrier twice.
  const doc = await CarrierOnboarding.findOneAndUpdate(
    { _id: req.params.id, tenantId, deletedAt: null, status: 'submitted', carrier: null, review: { $in: ['pending', 'rejected', null] } },
    { $set: { review: 'approving' } },
    { new: true },
  ).select('+pdf');
  if (!doc) {
    const cur = await CarrierOnboarding.findOne({ _id: req.params.id, tenantId, deletedAt: null }).lean();
    if (!cur) return res.status(404).json({ status: false, message: 'Not found.' });
    if (cur.status !== 'submitted') return res.status(409).json({ status: false, code: 'not_signed', message: 'Only a signed packet can be approved.' });
    return res.status(409).json({ status: false, code: 'already_approved', message: 'This packet is already approved.' });
  }
  let result;
  try {
    result = await upsertCarrierFromPacket({ req, doc, data: doc.data || {} });
  } catch (err) {
    await CarrierOnboarding.updateOne({ _id: doc._id }, { $set: { review: 'pending' } });
    console.error('[carrierOnboarding] approve failed', err);
    return res.status(400).json({ status: false, code: 'carrier_create_failed', message: `The carrier could not be created: ${err.message}` });
  }
  await CarrierOnboarding.updateOne({ _id: doc._id }, {
    $set: { review: 'approved', reviewedAt: new Date(), reviewedBy: req.user._id, rejectReason: '', carrier: result.carrier._id, carrierMatched: result.matched },
  });
  if (doc.pdf) await fileSignedAgreement({ doc, carrier: result.carrier, pdf: Buffer.from(doc.pdf), data: doc.data || {} });
  logActivity(req, {
    action: 'STATUS_CHANGE', module: 'carrier_onboarding',
    description: `Approved setup packet of "${doc.data?.legalName || ''}" — ${result.matched ? 'linked to existing' : 'created'} carrier`,
    resourceId: doc._id, resourceName: doc.data?.legalName || '',
  });
  return res.json({
    status: true,
    message: result.matched ? `Linked to the existing carrier "${result.carrier.name}".` : `Carrier "${result.carrier.name}" added.`,
    carrier: { _id: result.carrier._id, name: result.carrier.name },
  });
});

exports.rejectPacket = catchAsync(async (req, res) => {
  if (!canManageOnboarding(req.user)) return res.status(403).json({ status: false, message: 'Not allowed.' });
  const tenantId = tenantOf(req, res);
  if (!tenantId) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ status: false, message: 'Invalid id.' });
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  const doc = await CarrierOnboarding.findOneAndUpdate(
    { _id: req.params.id, tenantId, deletedAt: null, status: 'submitted', carrier: null, review: { $in: ['pending', null] } },
    { $set: { review: 'rejected', reviewedAt: new Date(), reviewedBy: req.user._id, rejectReason: reason } },
    { new: true },
  );
  if (!doc) return res.status(409).json({ status: false, code: 'not_pending', message: 'Only a signed packet awaiting approval can be rejected.' });
  logActivity(req, {
    action: 'STATUS_CHANGE', module: 'carrier_onboarding',
    description: `Rejected setup packet of "${doc.data?.legalName || ''}"${reason ? ` — ${reason}` : ''}`,
    resourceId: doc._id, resourceName: doc.data?.legalName || '',
  });
  return res.json({ status: true, link: summary(doc) });
});

exports.saveNotifyEmails = catchAsync(async (req, res) => {
  if (!canManageOnboarding(req.user)) return res.status(403).json({ status: false, message: 'You are not allowed to change this.' });
  const tenantId = tenantOf(req, res);
  if (!tenantId) return;
  const raw = Array.isArray(req.body?.emails) ? req.body.emails : String(req.body?.emails || '').split(/[,;\s]+/);
  const emails = [...new Set(raw.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const bad = emails.find((e) => e.length > 160 || !/^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]{2,}$/.test(e));
  if (bad) return res.status(400).json({ status: false, code: 'invalid_email', message: `"${bad}" is not a valid email address.` });
  if (emails.length > 5) return res.status(400).json({ status: false, code: 'too_many', message: 'At most 5 email addresses.' });
  await ensureSharedKey(tenantId, req.user);
  const before = await CarrierOnboardingKey.findOne({ tenantId }).lean();
  await CarrierOnboardingKey.updateOne({ tenantId }, { $set: { notifyEmails: emails, notifyUpdatedAt: new Date(), notifyUpdatedBy: req.user._id } });
  logActivity(req, {
    action: 'UPDATE', module: 'carrier_onboarding',
    description: `Signed carrier packets now emailed to ${emails.length ? emails.join(', ') : 'the company email'} (was ${before?.notifyEmails?.length ? before.notifyEmails.join(', ') : 'the company email'})`,
    resourceId: before?._id, resourceName: 'Carrier packet email',
  });
  const { broker } = await loadBroker(tenantId);
  return res.json({ status: true, notifyEmails: emails, emailTo: await recipients(tenantId, broker) });
});

exports._internals = { effectiveStatus, recipients, canManageOnboarding, TOKEN_RE };
