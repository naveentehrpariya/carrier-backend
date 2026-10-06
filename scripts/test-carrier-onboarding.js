/**
 * Carrier onboarding links — end to end against a throwaway local database.
 *
 *   mongod --dbpath /tmp/onb --port 27099 --fork --logpath /tmp/onb/log
 *   node scripts/test-carrier-onboarding.js
 *
 * Drives the real controllers. File storage (Bunny) and SMTP are stubbed through
 * require.cache; the signed PDF is rendered by the real Chrome. Refuses any
 * non-localhost URI because it drops the database when it finishes.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_onboarding_test';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const audit = [];
stub('../utils/activityLogger', { logActivity: async (req, o) => { audit.push(o); }, logChange: async () => {}, AUDIT_FIELDS: {} });
let uploadCount = 0;
stub('../utils/fileupload', async (file) => {
  uploadCount += 1;
  if (file.path) fs.unlink(file.path, () => {});
  return { filename: `f${uploadCount}-${file.originalname}`, url: `https://cdn.test/f${uploadCount}-${file.originalname}`, mime: file.mimetype, size: file.size };
});
const mails = [];
let mailFails = false;
const sendEmailStub = async (o) => { if (mailFails) throw new Error('535 auth failed'); mails.push(o); return { accepted: [o.email] }; };
sendEmailStub.isEmailConfigured = () => true;
stub('../utils/Email', sendEmailStub);

const Company = require('../db/Company');
const Carrier = require('../db/Carrier');
require('../db/Users');
const FleetDoc = require('../db/FleetDoc');
const CarrierOnboarding = require('../db/CarrierOnboarding');
const ctrl = require('../controllers/carrierOnboardingController');
const spec = require('../utils/carrierOnboardingSpec');

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); } catch (e) { fail += 1; console.log(`  FAIL ${name}\n         ${e.stack.split('\n').slice(0, 3).join('\n         ')}`); }
};

const TENANT = 'onb-tenant';
const OTHER = 'other-tenant';
const oid = () => new mongoose.Types.ObjectId();
const COMPANY_ID = oid();
const ADMIN = { _id: oid(), tenantId: TENANT, company: { _id: COMPANY_ID }, is_admin: 1, permissions: [], name: 'Admin' };
const DRIVER = { _id: oid(), tenantId: TENANT, company: { _id: COMPANY_ID }, is_admin: 0, permissions: ['driver'] };
const OTHER_ADMIN = { _id: oid(), tenantId: OTHER, company: { _id: oid() }, is_admin: 1, permissions: [] };

const mkRes = () => {
  const r = { statusCode: 200, body: null, headers: {}, sent: null };
  let settle; r.done = new Promise((ok) => { settle = ok; });
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; settle(r); return r; };
  r.send = r.json;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (buf) => { r.sent = buf; settle(r); return r; };
  return r;
};
const call = async (handler, req) => {
  const res = mkRes();
  const full = { headers: { 'user-agent': 'test-agent', 'x-forwarded-for': '203.0.113.9' }, query: {}, params: {}, body: {}, ip: '127.0.0.1', ...req };
  handler(full, res, (err) => { res.statusCode = 500; res.body = { err: err?.message }; res.json(res.body); });
  return res.done;
};
const asUser = (user, extra = {}) => ({ user, tenantId: user.tenantId, ...extra });

const SIG = `data:image/png;base64,${Buffer.from('fake-png-signature-bytes').toString('base64')}`;
const FULL_DATA = {
  legalName: 'Northern Haul Ltd', mcNumber: '998877', dotNumber: '1122334',
  address: '12 Yard Rd', city: 'Brampton', state: 'ON', zip: 'L6T 1A1', country: 'USA',
  phone: '905-555-0101', email: 'Ops@NorthernHaul.test', contactName: 'Jas Singh',
  operationsManager: 'Jas Singh', opsPhone: '905-555-0102', followsDot: 'yes', safetyRating: 'Satisfactory', logsManagerName: 'Simran',
  agentName: 'Pat Agent', agentPhone: '416-555-0199', agentEmail: 'pat@agency.test', insuranceExpiry: '2027-03-31', autoPolicyNo: 'AUTO-1',
  taxIdType: 'EIN', taxId: '12-3456789', workersComp: 'no', wcExemptReason: 'sole_proprietor', usAuthority: 'yes', hazmat: 'no',
  paymentMethod: 'direct_deposit', bankName: 'TD', accountName: 'Northern Haul Ltd', accountType: 'checking', routingNumber: '004-12345', accountNumber: '5551234567',
  usesFactoring: 'no',
  equipment: ['Dry Van', 'Reefer', 'Spaceship'],
  acknowledgements: { noDoubleBrokering: true, agreementAccepted: true, electronicSignature: true },
};

async function uploadAs(token, kind, name = `${kind}.pdf`, mime = 'application/pdf') {
  const p = path.join(os.tmpdir(), `onb-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(p, 'x');
  return call(ctrl.publicUploadFile, { params: { token }, body: { kind }, file: { path: p, originalname: name, mimetype: mime, size: 1 } });
}

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.db.dropDatabase();
  await Company.create({ _id: COMPANY_ID, tenantId: TENANT, name: 'Cross Miles Carrier Inc', email: 'ops@cmc.test', phone: '437-383-3310', address: '1 Main St' });
  await CarrierOnboarding.init();

  let token; let linkId; let SHARED_KEY;
  const startPacket = async () => {
    const r = await call(ctrl.publicStart, { params: { key: SHARED_KEY } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const d = await CarrierOnboarding.findOne({ token: r.body.token }).lean();
    return { token: r.body.token, id: String(d._id) };
  };

  console.log('\nSpec');
  await t('sanitize drops unknown keys, bad options and hidden answers', async () => {
    const s = spec.sanitize({ ...FULL_DATA, evil: '$where', usesFactoring: 'no', factoringCompany: 'Leftover Factoring', safetyRating: 'Great' });
    assert.strictEqual(s.evil, undefined);
    assert.strictEqual(s.factoringCompany, undefined, 'hidden field kept');
    assert.strictEqual(s.safetyRating, undefined, 'invalid option kept');
    assert.deepStrictEqual(s.equipment, ['Dry Van', 'Reefer']);
    assert.strictEqual(s.email, 'ops@northernhaul.test');
  });
  await t('validate asks for bank fields only when the method needs them', async () => {
    const d = spec.sanitize({ ...FULL_DATA, paymentMethod: 'standard' });
    assert.ok(!spec.validate(d, []).some((e) => e.key === 'accountNumber'));
    const d2 = spec.sanitize({ ...FULL_DATA, accountNumber: '' });
    assert.ok(spec.validate(d2, []).some((e) => e.key === 'accountNumber'));
  });
  await t('maskValue keeps only the last four', async () => {
    assert.strictEqual(spec.maskValue('5551234567'), '••••4567');
    assert.strictEqual(spec.maskValue('123'), '•••');
  });

  console.log('\nDashboard');
  await t('a driver cannot see the shared link', async () => {
    const r = await call(ctrl.listLinks, asUser(DRIVER));
    assert.strictEqual(r.statusCode, 403);
  });
  await t('admin gets ONE shared link — the same every time, different per tenant', async () => {
    const a1 = await call(ctrl.listLinks, asUser(ADMIN));
    const a2 = await call(ctrl.listLinks, asUser(ADMIN));
    SHARED_KEY = a1.body.sharedKey;
    assert.ok(ctrl._internals.TOKEN_RE.test(SHARED_KEY) && SHARED_KEY.length >= 32);
    assert.strictEqual(a2.body.sharedKey, SHARED_KEY);
    const o = await call(ctrl.listLinks, asUser(OTHER_ADMIN));
    assert.notStrictEqual(o.body.sharedKey, SHARED_KEY);
    assert.strictEqual(typeof ctrl.createLink, 'undefined', 'per-carrier link creation must be gone');
  });
  await t('each visitor of the shared link gets their own packet; empty ones stay off the list', async () => {
    const p1 = await startPacket();
    const p2 = await startPacket();
    assert.notStrictEqual(p1.token, p2.token);
    const d = await CarrierOnboarding.findById(p1.id).lean();
    assert.strictEqual(d.source, 'shared');
    assert.strictEqual(d.tenantId, TENANT);
    assert.strictEqual(String(d.company), String(COMPANY_ID));
    const l = await call(ctrl.listLinks, asUser(ADMIN));
    assert.strictEqual(l.body.links.length, 0, 'opened-but-empty packets must not clutter the list');
    token = p1.token; linkId = p1.id;
  });
  await t('an unknown shared key is a 404', async () => {
    assert.strictEqual((await call(ctrl.publicStart, { params: { key: 'B'.repeat(32) } })).statusCode, 404);
    assert.strictEqual((await call(ctrl.publicStart, { params: { key: 'x' } })).statusCode, 404);
  });
  await t('another tenant cannot see the link', async () => {
    const r = await call(ctrl.linkDetail, asUser(OTHER_ADMIN, { params: { id: linkId } }));
    assert.strictEqual(r.statusCode, 404);
    const l = await call(ctrl.listLinks, asUser(OTHER_ADMIN));
    assert.strictEqual(l.body.links.length, 0);
  });
  await t('broker party is fixed to the packet (no settings to fill in)', async () => {
    assert.strictEqual(typeof ctrl.saveSettings, 'undefined');
    assert.strictEqual(typeof ctrl.getSettings, 'undefined');
  });

  console.log('\nPublic');
  await t('a malformed or unknown token is a 404', async () => {
    assert.strictEqual((await call(ctrl.publicGet, { params: { token: 'short' } })).statusCode, 404);
    assert.strictEqual((await call(ctrl.publicGet, { params: { token: 'A'.repeat(32) } })).statusCode, 404);
  });
  await t('opening the link serves the spec and marks it opened', async () => {
    const r = await call(ctrl.publicGet, { params: { token } });
    assert.ok(r.body.spec.sections.length >= 5);
    assert.strictEqual(r.body.broker.mc, '1365834');
    assert.strictEqual((await CarrierOnboarding.findById(linkId)).status, 'opened');
  });
  await t('draft saves sanitized data', async () => {
    const r = await call(ctrl.publicSaveDraft, { params: { token }, body: { data: { legalName: '  Northern Haul Ltd  ', bogus: 1 } } });
    assert.strictEqual(r.body.data.legalName, 'Northern Haul Ltd');
    assert.strictEqual(r.body.data.bogus, undefined);
  });
  await t('uploads: unknown kind and bad type refused; a single-file kind is replaced', async () => {
    assert.strictEqual((await uploadAs(token, 'passport')).statusCode, 400);
    assert.strictEqual((await uploadAs(token, 'coi', 'x.exe', 'application/x-msdownload')).statusCode, 400);
    await uploadAs(token, 'coi', 'old-coi.pdf');
    const r = await uploadAs(token, 'coi', 'new-coi.pdf');
    const cois = r.body.files.filter((f) => f.kind === 'coi');
    assert.strictEqual(cois.length, 1);
    assert.strictEqual(cois[0].name, 'new-coi.pdf');
  });
  await t('documents are optional: none required by validation', async () => {
    const errs = spec.validate(spec.sanitize(FULL_DATA), []);
    assert.ok(!errs.some((e) => e.key.startsWith('file:')), JSON.stringify(errs));
  });
  await t('submit without a signature is refused and keeps the answers', async () => {
    const r = await call(ctrl.publicSubmit, { params: { token }, body: { data: FULL_DATA, signature: { image: '', name: 'Jas Singh' } } });
    assert.strictEqual(r.statusCode, 400);
    assert.ok(r.body.errors.some((e) => e.key === 'signature'));
    const doc = await CarrierOnboarding.findById(linkId).lean();
    assert.strictEqual(doc.status, 'in_progress');
    assert.strictEqual(doc.data.accountNumber, '5551234567', 'draft must keep the full value until submit');
    await uploadAs(token, 'w9');
  });
  await t('preview returns the filled packet with sensitive values masked', async () => {
    const r = await call(ctrl.publicPreview, { params: { token }, body: { data: FULL_DATA } });
    assert.ok(r.body.html.includes('Northern Haul Ltd'));
    assert.ok(r.body.html.includes('PREVIEW'));
    assert.ok(!r.body.html.includes('5551234567'), 'full account number in preview');
    assert.ok(r.body.html.includes('••••4567'));
    assert.ok(r.body.html.includes('1365834'), 'broker MC missing');
  });
  await t('preview escapes carrier input', async () => {
    const r = await call(ctrl.publicPreview, { params: { token }, body: { data: { ...FULL_DATA, legalName: '<img src=x onerror=alert(1)>' } } });
    assert.ok(!r.body.html.includes('<img src=x'));
  });

  console.log('\nSubmit');
  let submitRes;
  await t('a complete packet signs and renders a PDF — but creates NO carrier', async () => {
    submitRes = await call(ctrl.publicSubmit, { params: { token }, body: { data: FULL_DATA, signature: { image: SIG, name: 'Jas Singh', title: 'Owner' } } });
    assert.strictEqual(submitRes.statusCode, 200, JSON.stringify(submitRes.body));
    const doc = await CarrierOnboarding.findById(linkId).select('+pdf').lean();
    assert.strictEqual(doc.status, 'submitted');
    assert.ok(doc.pdf && doc.pdf.buffer ? doc.pdf.buffer.length > 1000 : doc.pdf.length > 1000);
    const buf = Buffer.from(doc.pdf.buffer || doc.pdf);
    assert.strictEqual(buf.slice(0, 4).toString(), '%PDF');
    assert.strictEqual(crypto.createHash('sha256').update(buf).digest('hex'), doc.pdfHash);
    assert.strictEqual(doc.signature.ip, '203.0.113.9');
    assert.strictEqual(doc.carrier, null);
    assert.strictEqual(doc.review, 'pending');
    assert.strictEqual(await Carrier.countDocuments({ tenantId: TENANT }), 0);
    const buf2 = Buffer.from(doc.pdf.buffer || doc.pdf).toString('latin1');
    assert.ok(!/Not signed yet/.test(buf2));
  });
  await t('the database keeps only masked bank and tax numbers', async () => {
    const doc = await CarrierOnboarding.findById(linkId).lean();
    assert.strictEqual(doc.data.accountNumber, '••••4567');
    assert.strictEqual(doc.data.taxId, '••••6789');
    assert.ok(!JSON.stringify(doc).includes('5551234567'));
  });
  await t('approval: a driver cannot, reject of an approved one fails, double approve creates one', async () => {
    assert.strictEqual((await call(ctrl.approvePacket, asUser(DRIVER, { params: { id: linkId } }))).statusCode, 403);
    const [a, b] = await Promise.all([
      call(ctrl.approvePacket, asUser(ADMIN, { params: { id: linkId } })),
      call(ctrl.approvePacket, asUser(ADMIN, { params: { id: linkId } })),
    ]);
    assert.deepStrictEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.strictEqual(await Carrier.countDocuments({ tenantId: TENANT }), 1);
    const doc = await CarrierOnboarding.findById(linkId).lean();
    assert.strictEqual(doc.review, 'approved');
    assert.strictEqual(String(doc.reviewedBy), String(ADMIN._id));
    assert.strictEqual((await call(ctrl.rejectPacket, asUser(ADMIN, { params: { id: linkId } }))).statusCode, 409);
  });
  await t('carrier record matches the packet and carries its documents', async () => {
    const doc = await CarrierOnboarding.findById(linkId).lean();
    const c = await Carrier.findById(doc.carrier).lean();
    assert.strictEqual(c.name, 'Northern Haul Ltd');
    assert.strictEqual(c.mc_code, '998877');
    assert.strictEqual(String(c.company), String(COMPANY_ID));
    assert.strictEqual(String(c.onboarding), String(linkId));
    assert.strictEqual(String(c.created_by), String(ADMIN._id), 'approver should own the carrier');
    const docs = await FleetDoc.find({ entityId: c._id, type: 'carrier' }).lean();
    const coi = docs.find((d) => d.docType === 'coi');
    assert.ok(coi, 'COI not filed');
    assert.strictEqual(coi.expiryDate.toISOString().slice(0, 10), '2027-03-31');
    assert.ok(docs.some((d) => d.docType === 'w9'));
    assert.ok(docs.some((d) => d.docType === 'agreement'), 'signed agreement not filed');
  });
  await t('the email carries the FULL values and the signed PDF', async () => {
    assert.ok(await waitFor(async () => (await CarrierOnboarding.findById(linkId).lean()).emailStatus === 'sent'));
    const m = mails[mails.length - 1];
    assert.ok(m.message.includes('5551234567'), 'full account number missing from email');
    assert.ok(m.message.includes('12-3456789'), 'full tax id missing from email');
    assert.ok(m.message.includes('waiting for approval'));
    assert.ok(m.attachments.some((a) => a.contentType === 'application/pdf' && a.content.length > 1000));
    assert.ok(m.attachments.some((a) => String(a.path || '').startsWith('https://cdn.test/')));
    assert.strictEqual(m.email, 'ops@cmc.test', 'with nothing set, packets go to the company email');
  });
  await t('the link stops working after submit', async () => {
    const g = await call(ctrl.publicGet, { params: { token } });
    assert.strictEqual(g.statusCode, 410);
    assert.strictEqual(g.body.code, 'already_submitted');
    const s = await call(ctrl.publicSubmit, { params: { token }, body: { data: FULL_DATA, signature: { image: SIG, name: 'X Y' } } });
    assert.strictEqual(s.statusCode, 410);
    assert.strictEqual((await uploadAs(token, 'other')).statusCode, 410);
  });
  await t('dashboard serves the stored PDF; a driver cannot', async () => {
    const r = await call(ctrl.linkPdf, asUser(ADMIN, { params: { id: linkId } }));
    assert.strictEqual(Buffer.from(r.sent).slice(0, 4).toString(), '%PDF');
    const d = await call(ctrl.linkPdf, asUser(DRIVER, { params: { id: linkId } }));
    assert.strictEqual(d.statusCode, 403);
  });
  await t('notify emails: set on the dashboard, per company, validated', async () => {
    assert.strictEqual((await call(ctrl.saveNotifyEmails, asUser(DRIVER, { body: { emails: ['x@y.test'] } }))).statusCode, 403);
    const bad = await call(ctrl.saveNotifyEmails, asUser(ADMIN, { body: { emails: ['mark@cmc.test', 'not-an-email'] } }));
    assert.strictEqual(bad.statusCode, 400);
    const ok = await call(ctrl.saveNotifyEmails, asUser(ADMIN, { body: { emails: 'Mark@CMC.test, ops2@cmc.test, mark@cmc.test' } }));
    assert.deepStrictEqual(ok.body.notifyEmails, ['mark@cmc.test', 'ops2@cmc.test']);
    const l = await call(ctrl.listLinks, asUser(ADMIN));
    assert.deepStrictEqual(l.body.setup.emailTo, ['mark@cmc.test', 'ops2@cmc.test']);
    const o = await call(ctrl.listLinks, asUser(OTHER_ADMIN));
    assert.ok(!o.body.setup.emailTo.includes('mark@cmc.test'), 'another company must not inherit the setting');
  });
  await t('resend works and says the values are masked', async () => {
    const before = mails.length;
    const r = await call(ctrl.resendEmail, asUser(ADMIN, { params: { id: linkId } }));
    assert.strictEqual(r.body.status, true);
    assert.strictEqual(mails.length, before + 1);
    assert.ok(!mails[mails.length - 1].message.includes('5551234567'));
    assert.strictEqual(mails[mails.length - 1].email, 'mark@cmc.test, ops2@cmc.test', 'resend must use the dashboard setting');
  });
  await t('a failed email is recorded, not lost', async () => {
    mailFails = true;
    const r = await call(ctrl.resendEmail, asUser(ADMIN, { params: { id: linkId } }));
    mailFails = false;
    assert.strictEqual(r.statusCode, 502);
    assert.strictEqual((await CarrierOnboarding.findById(linkId).lean()).emailStatus, 'failed');
  });
  await t('a submitted link cannot be revoked', async () => {
    const r = await call(ctrl.revokeLink, asUser(ADMIN, { params: { id: linkId } }));
    assert.strictEqual(r.statusCode, 409);
  });

  console.log('\nSecond packet');
  await t('same MC links to the existing carrier instead of duplicating it', async () => {
    const c = await startPacket();
    const tk = c.token;
    for (const k of ['coi', 'w9', 'authority', 'void_cheque']) await uploadAs(tk, k); // eslint-disable-line no-await-in-loop
    const r = await call(ctrl.publicSubmit, { params: { token: tk }, body: { data: { ...FULL_DATA, email: 'new@x.test' }, signature: { image: SIG, name: 'Jas Singh' } } });
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const ap = await call(ctrl.approvePacket, asUser(ADMIN, { params: { id: c.id } }));
    assert.strictEqual(ap.statusCode, 200, JSON.stringify(ap.body));
    const doc = await CarrierOnboarding.findById(c.id).lean();
    assert.strictEqual(doc.carrierMatched, true);
    assert.strictEqual(await Carrier.countDocuments({ tenantId: TENANT, mc_code: '998877' }), 1);
  });
  await t('two concurrent submits sign once', async () => {
    const c = await startPacket();
    const tk = c.token;
    for (const k of ['coi', 'w9', 'authority', 'void_cheque']) await uploadAs(tk, k); // eslint-disable-line no-await-in-loop
    const body = { data: { ...FULL_DATA, mcNumber: '111222', email: 'race@x.test' }, signature: { image: SIG, name: 'Jas Singh' } };
    const [a, b] = await Promise.all([call(ctrl.publicSubmit, { params: { token: tk }, body }), call(ctrl.publicSubmit, { params: { token: tk }, body })]);
    const codes = [a.statusCode, b.statusCode].sort();
    assert.strictEqual(codes[0], 200);
    assert.ok([409, 410].includes(codes[1]), `second submit answered ${codes[1]}`);
    assert.strictEqual(await CarrierOnboarding.countDocuments({ _id: c.id, status: 'submitted' }), 1);
    assert.strictEqual(await Carrier.countDocuments({ tenantId: TENANT, mc_code: '111222' }), 0, 'no carrier before approval');
  });
  await t('reject keeps the packet, adds no carrier, and can still be approved later', async () => {
    const c = await startPacket();
    const tk = c.token;
    const r = await call(ctrl.publicSubmit, { params: { token: tk }, body: { data: { ...FULL_DATA, mcNumber: '333444', email: 'rej@x.test' }, signature: { image: SIG, name: 'Jas Singh' } } });
    assert.strictEqual(r.statusCode, 200, 'submit with no documents at all must pass');
    const rj = await call(ctrl.rejectPacket, asUser(ADMIN, { params: { id: c.id }, body: { reason: 'Insurance too low' } }));
    assert.strictEqual(rj.body.link.review, 'rejected');
    assert.strictEqual(rj.body.link.rejectReason, 'Insurance too low');
    assert.strictEqual(await Carrier.countDocuments({ tenantId: TENANT, mc_code: '333444' }), 0);
    const ap = await call(ctrl.approvePacket, asUser(ADMIN, { params: { id: c.id } }));
    assert.strictEqual(ap.statusCode, 200);
    assert.strictEqual(await Carrier.countDocuments({ tenantId: TENANT, mc_code: '333444' }), 1);
  });
  await t('a packet not yet signed cannot be approved', async () => {
    const c = await startPacket();
    const r = await call(ctrl.approvePacket, asUser(ADMIN, { params: { id: c.id } }));
    assert.strictEqual(r.statusCode, 409);
    assert.strictEqual(r.body.code, 'not_signed');
  });
  await t('a revoked link is dead and its draft loses the full numbers', async () => {
    const c = await startPacket();
    const tk = c.token;
    await call(ctrl.publicSaveDraft, { params: { token: tk }, body: { data: FULL_DATA } });
    const r = await call(ctrl.revokeLink, asUser(ADMIN, { params: { id: c.id } }));
    assert.strictEqual(r.body.status, true);
    assert.strictEqual((await call(ctrl.publicGet, { params: { token: tk } })).body.code, 'link_revoked');
    const doc = await CarrierOnboarding.findById(c.id).lean();
    assert.strictEqual(doc.data.accountNumber, '••••4567');
  });
  await t('an expired packet is dead (and shows once it holds data)', async () => {
    const c = await startPacket();
    await call(ctrl.publicSaveDraft, { params: { token: c.token }, body: { data: { legalName: 'Lapsed Co' } } });
    await CarrierOnboarding.updateOne({ _id: c.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const g = await call(ctrl.publicGet, { params: { token: c.token } });
    assert.strictEqual(g.body.code, 'link_expired');
    const l = await call(ctrl.listLinks, asUser(ADMIN));
    assert.strictEqual(l.body.links.find((x) => String(x._id) === String(c.id)).status, 'expired');
  });

  // Write the signed PDF out so a person can look at it.
  const sample = await CarrierOnboarding.findById(linkId).select('+pdf').lean();
  const out = path.join(os.tmpdir(), 'carrier-onboarding-sample.pdf');
  fs.writeFileSync(out, Buffer.from(sample.pdf.buffer || sample.pdf));
  console.log(`\nSample signed PDF: ${out}`);

  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.connection.db.dropDatabase(); } catch (_) { /* ignore */ }
  process.exit(1);
});
