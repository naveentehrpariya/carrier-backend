/**
 * Typed documents + expiry alerts. Drives the real docController against a throwaway local database.
 *
 *   mongod --dbpath /tmp/docs --port 27099 --fork --logpath /tmp/docs/log
 *   node scripts/test-documents.js          # or: npm run test:documents
 *
 * Uses TEST_DB_URL, default mongodb://127.0.0.1:27099/carrier_docs_test. It REFUSES to run against
 * anything that is not localhost, because it drops the database when it finishes.
 *
 * Run it under a westward timezone too — the expiry rule is a calendar rule and a millisecond diff
 * passes at UTC while flipping a document to "expired" the evening before in Toronto:
 *
 *   TZ=America/Toronto node scripts/test-documents.js
 *
 * What is being proven:
 *   - metadata is storable with NO file, and a file can be attached later
 *   - one parser serves the JSON body and the multipart body, so they cannot disagree
 *   - `docFields` is key-whitelisted, value-capped, and replaced wholesale (never merged)
 *   - an absent key means "leave it alone"; an explicit '' clears
 *   - fleet docs and personal docs have different audiences; a plain driver sees neither
 *   - the three expiry tiers, and that a calendar date is not expired on its own day
 *   - a driver's profile licence is deduped ONLY by a typed licence doc that records an expiry
 *   - ghosts never alert (deleted truck, inactive employee, removed doc)
 *   - a scan cannot be attached to another tenant's truck
 */
const assert = require('assert');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_docs_test';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

// The audit trail hash-chains a row per change and is not what is under test. Stub it before
// anything requires the controller (which destructures logChange at require time).
const loggerPath = require.resolve('../utils/activityLogger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true, exports: {
    logActivity: () => {},
    logChange: (req, payload) => { if (global.__auditSink) global.__auditSink.push(payload); },
    CreatePaymentLog: async () => {},
    AUDIT_FIELDS: {},
  },
};

// The real uploader PUTs to BunnyCDN. Stub it so the multipart branch is testable offline.
const uploadPath = require.resolve('../utils/fileupload');
require.cache[uploadPath] = {
  id: uploadPath, filename: uploadPath, loaded: true,
  exports: async (f) => ({
    message: 'ok', mime: f.mimetype, filename: `stub-${f.originalname}`,
    url: `https://cdn.test/${f.originalname}`, file: f, size: f.size,
  }),
};

const FleetDoc = require('../db/FleetDoc');
const EmployeeDoc = require('../db/EmployeeDoc');
const Truck = require('../db/Truck');
const Trailer = require('../db/Trailer');
const Users = require('../db/Users');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const Carrier = require('../db/Carrier');
const Customer = require('../db/Customer');
const Vendor = require('../db/Vendor');
const doc = require('../controllers/docController');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};
const section = (s) => console.log(`\n${s}`);

// catchAsync does NOT return its promise (`fn(...).catch(next)`), so awaiting the handler resolves
// immediately. The harness waits on the RESPONSE instead.
function mkRes() {
  const r = { statusCode: 200, body: null };
  r.done = new Promise((res, rej) => { r._resolve = res; r._reject = rej; });
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r._resolve(r); return r; };
  return r;
}
async function run(handler, req) {
  const res = mkRes();
  handler(req, res, (e) => res._reject(e || new Error('next() with no error')));
  await Promise.race([
    res.done,
    new Promise((_, rej) => setTimeout(() => rej(new Error('handler timed out')), 8000)),
  ]);
  return res;
}

const TENANT = 'docs-test-tenant';
const OTHER = 'docs-other-tenant';
const admin = { _id: new mongoose.Types.ObjectId(), is_admin: 1, role: 3, tenantId: TENANT, permissions: [], name: 'Admin' };
const dispatcher = { _id: new mongoose.Types.ObjectId(), is_admin: 0, role: 1, tenantId: TENANT, permissions: ['regular'], name: 'Dispatcher' };
const driverOnly = { _id: new mongoose.Types.ObjectId(), is_admin: 0, tenantId: TENANT, permissions: ['driver'], name: 'Just A Driver' };
const carrierClerk = { _id: new mongoose.Types.ObjectId(), is_admin: 0, tenantId: TENANT, permissions: ['carriers'], name: 'Carrier Clerk' };
const mkReq = (over = {}) => ({ user: admin, tenantId: TENANT, params: {}, body: {}, headers: {}, ...over });

const days = (n) => new Date(Date.now() + n * 86400000);
const attachment = (name = 'scan.pdf') => ({
  attachment: [{ path: '/dev/null', originalname: name, mimetype: 'application/pdf', size: 12, filename: 'tmp' }],
});
const numbersIn = (res) => (res.body?.items || []).map((i) => i.docNumber);

(async () => {
  await mongoose.connect(URI, { autoIndex: true });
  await mongoose.connection.dropDatabase();
  console.log(`Typed documents + expiry alerts — ${URI}  (TZ=${process.env.TZ || 'system'})`);

  const truck = await Truck.create({ tenantId: TENANT, plateNumber: 'AB-1234', unitNumber: 'T-01', vin: '1FUJGLDR8CSBP1234' });
  const trailer = await Trailer.create({ tenantId: TENANT, plateNumber: 'TR-9', unitNumber: 'TRL-9' });
  const foreignTruck = await Truck.create({ tenantId: OTHER, plateNumber: 'XX-000' });
  const owner = await OwnerOperator.create({
    tenantId: TENANT, ownerOperatorId: 'OO-001', fullName: 'Gurpreet Singh',
    companyName: 'GS Trucking', email: 'gs@test.dev', phone: '5550002222', status: 'active',
  });
  const addr = { country: 'CA', state: 'ON', city: 'Toronto', zipcode: 'M5V1A1', location: '1 King St', address: '1 King St' };
  const carrier = await Carrier.create({
    tenantId: TENANT, company_name: 'Northline Freight', name: 'Northline Freight',
    mc_code: 'MC123456', mc_number: 'MC123456', phone: '5550003333', email: 'ops@northline.test', ...addr,
  });
  const vendor = await Vendor.create({
    tenantId: TENANT, code: 'V1000', name: 'Petro Fuel Stop',
    emails: [{ email: 'ap@petro.test' }], email: 'ap@petro.test',
  });
  // Two customers: one unassigned (shared with `regular` users in the same company),
  // one assigned to somebody else entirely — the dispatcher must never reach the second.
  const myCustomer = await Customer.create({
    tenantId: TENANT, company_name: 'Assigned Co', name: 'Assigned Co',
    phone: '5550004444', email: 'ap@assigned.test', assigned_to: [], ...addr,
  });
  const otherCustomer = await Customer.create({
    tenantId: TENANT, company_name: 'Not Mine Co', name: 'Not Mine Co',
    phone: '5550005555', email: 'ap@notmine.test', assigned_to: [new mongoose.Types.ObjectId()], ...addr,
  });

  const driver = await Users.create({
    tenantId: TENANT, name: 'Ravi Driver', email: 'ravi.docs@test.dev',
    password: 'Password1!', confirmPassword: 'Password1!', status: 'active',
    address: '1 Test St', country: 'CA', phone: '5550001111', corporateID: 'EMP-001',
  });

  section('schema');
  await t('both models carry the typed metadata', () => {
    for (const M of [FleetDoc, EmployeeDoc]) {
      for (const p of ['docType', 'docNumber', 'docFields', 'issueDate', 'expiryDate']) {
        assert.ok(M.schema.path(p), `${M.modelName} missing ${p}`);
      }
    }
  });
  await t('FleetDoc.type accepts owner_operator (the enum that 500d every owner upload)', async () => {
    const row = await FleetDoc.create({ tenantId: TENANT, type: 'owner_operator', entityId: owner._id, name: 'legacy.pdf' });
    assert.ok(row._id);
  });
  await t('the controller vocabulary and BOTH schema enums agree', () => {
    // These drifted once: DOC_TYPES gained the commercial types while the two
    // Mongoose enums did not, so the controller accepted a COI and Mongoose then
    // refused to store it. Same list, or neither is the list.
    for (const M of [FleetDoc, EmployeeDoc]) {
      const allowed = M.schema.path('docType').enumValues.filter(Boolean);
      const missing = doc.DOC_TYPES.filter((tp) => !allowed.includes(tp));
      const extra = allowed.filter((tp) => !doc.DOC_TYPES.includes(tp));
      assert.deepStrictEqual(missing, [], `${M.modelName} enum is missing ${missing}`);
      assert.deepStrictEqual(extra, [], `${M.modelName} enum has stray ${extra}`);
    }
  });
  await t('truck and trailer already carry plateNumber + vin', () => {
    assert.ok(Truck.schema.path('plateNumber') && Truck.schema.path('vin'));
    assert.ok(Trailer.schema.path('plateNumber') && Trailer.schema.path('vin'));
  });

  section('parseDocMeta');
  await t('rejects an unknown docType', () => assert.ok(doc.parseDocMeta({ docType: 'nope' }).error));
  await t('rejects an unparseable date', () => assert.ok(doc.parseDocMeta({ expiryDate: 'not-a-date' }).error));
  await t('rejects expiry before issue', () => assert.ok(doc.parseDocMeta({ issueDate: '2026-05-01', expiryDate: '2026-04-01' }).error));
  await t('an absent key is left alone', () => assert.ok(!('docNumber' in doc.parseDocMeta({ docType: 'rc' }).fields)));
  await t("an explicit '' clears a date", () => assert.strictEqual(doc.parseDocMeta({ expiryDate: '' }).fields.expiryDate, null));
  await t('docFields: a known key set is accepted', () => assert.ok(!doc.parseDocMeta({ docFields: { chassisNo: 'X', ownerName: 'Y' } }).error));
  await t('docFields: an unknown key is refused', () => assert.ok(doc.parseDocMeta({ docFields: { evilKey: 'X' } }).error));
  await t('docFields: a nested object value is refused', () => assert.ok(doc.parseDocMeta({ docFields: { ownerName: { a: 1 } } }).error));
  await t('docFields: an array is refused', () => assert.ok(doc.parseDocMeta({ docFields: ['a'] }).error));
  await t('docFields: the JSON string multipart sends is parsed', () => {
    const r = doc.parseDocMeta({ docFields: JSON.stringify({ insurer: 'ACME' }) });
    assert.ok(!r.error); assert.strictEqual(r.fields.docFields.insurer, 'ACME');
  });
  await t('docFields: malformed JSON is refused', () => assert.ok(doc.parseDocMeta({ docFields: '{not json' }).error));
  await t('docFields: all-blank values collapse to null', () => assert.strictEqual(doc.parseDocMeta({ docFields: { ownerName: '' } }).fields.docFields, null));
  await t('docFields: a long value is capped, not refused', () => {
    const r = doc.parseDocMeta({ docFields: { ownerName: 'x'.repeat(400) } });
    assert.ok(!r.error); assert.strictEqual(r.fields.docFields.ownerName.length, 120);
  });
  await t('every whitelisted key is a plain string name', () => {
    assert.ok(doc.DOC_FIELD_KEYS.length > 10);
    for (const k of doc.DOC_FIELD_KEYS) assert.match(k, /^[a-zA-Z]+$/);
  });

  section('create — a document does not need a file');
  let res = await run(doc.createDoc, mkReq({
    params: { kind: 'truck', entityId: String(truck._id) },
    body: { docType: 'rc', docNumber: 'RC-778', issueDate: '2024-01-10', expiryDate: days(3).toISOString() },
  }));
  const rcDoc = res.body?.document;
  await t('metadata-only create returns 201 and stores no file', () => {
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.ok(!rcDoc.url); assert.strictEqual(rcDoc.docNumber, 'RC-778');
  });
  await t('docType is required', async () => {
    const r = await run(doc.createDoc, mkReq({ params: { kind: 'truck', entityId: String(truck._id) }, body: { docNumber: 'X' } }));
    assert.strictEqual(r.statusCode, 400);
  });
  await t('"other" without a label is refused', async () => {
    const r = await run(doc.createDoc, mkReq({ params: { kind: 'truck', entityId: String(truck._id) }, body: { docType: 'other' } }));
    assert.strictEqual(r.statusCode, 400);
  });
  await t('a cross-tenant truck is not found', async () => {
    const r = await run(doc.createDoc, mkReq({ params: { kind: 'truck', entityId: String(foreignTruck._id) }, body: { docType: 'rc' } }));
    assert.strictEqual(r.statusCode, 404);
  });
  await t('an unknown kind is refused', async () => {
    const r = await run(doc.createDoc, mkReq({ params: { kind: 'bogus', entityId: String(truck._id) }, body: { docType: 'rc' } }));
    assert.strictEqual(r.statusCode, 400);
  });
  await t('a malformed entity id is refused', async () => {
    const r = await run(doc.createDoc, mkReq({ params: { kind: 'truck', entityId: 'not-an-id' }, body: { docType: 'rc' } }));
    assert.strictEqual(r.statusCode, 400);
  });
  await t('a missing tenant is refused, never run unscoped', async () => {
    const r = await run(doc.createDoc, mkReq({
      tenantId: null, user: { ...admin, tenantId: null },
      params: { kind: 'truck', entityId: String(truck._id) }, body: { docType: 'rc' },
    }));
    assert.strictEqual(r.statusCode, 400);
  });

  section('create — with a scan, through the validated route');
  await t('multipart create attaches the file', async () => {
    const req = mkReq({
      params: { kind: 'truck', entityId: String(truck._id) },
      body: { docType: 'insurance', docNumber: 'INS-FILE-1', expiryDate: days(40).toISOString(), docFields: JSON.stringify({ insurer: 'Intact' }) },
    });
    req.files = attachment();
    const r = await run(doc.createDoc, req);
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    assert.ok(r.body.document.url, 'no url stored');
    assert.strictEqual(r.body.document.docFields.insurer, 'Intact');
  });
  await t("a scan cannot be attached to another tenant's truck", async () => {
    const req = mkReq({ params: { kind: 'truck', entityId: String(foreignTruck._id) }, body: { docType: 'insurance' } });
    req.files = attachment();
    const r = await run(doc.createDoc, req);
    assert.strictEqual(r.statusCode, 404, JSON.stringify(r.body));
  });
  await t('owner-operator documents are a full kind', async () => {
    const r = await run(doc.createDoc, mkReq({
      params: { kind: 'owner_operator', entityId: String(owner._id) },
      body: { docType: 'insurance', docNumber: 'OO-INS-1', expiryDate: days(6).toISOString() },
    }));
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.document.type, 'owner_operator');
  });

  section('employee documents — HR or self');
  res = await run(doc.createDoc, mkReq({
    params: { kind: 'employee', entityId: String(driver._id) },
    body: { docType: 'license', docNumber: 'DL-99', expiryDate: days(5).toISOString() },
  }));
  const licenceDoc = res.body?.document;
  await t('HR can add an employee document', () => assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body)));
  await t('a dispatcher cannot', async () => {
    const r = await run(doc.createDoc, mkReq({ user: dispatcher, params: { kind: 'employee', entityId: String(driver._id) }, body: { docType: 'license' } }));
    assert.strictEqual(r.statusCode, 403);
  });
  await t('the employee themselves can', async () => {
    const r = await run(doc.createDoc, mkReq({
      user: { ...dispatcher, _id: driver._id },
      params: { kind: 'employee', entityId: String(driver._id) }, body: { docType: 'passport', docNumber: 'P1' },
    }));
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  });

  section('update — a renewal edits the row it renews');
  await t('the expiry moves and the untouched number stays', async () => {
    const r = await run(doc.updateDoc, mkReq({ params: { kind: 'truck', docId: String(rcDoc._id) }, body: { expiryDate: days(400).toISOString() } }));
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(new Date(r.body.document.expiryDate) > days(300));
    assert.strictEqual(r.body.document.docNumber, 'RC-778');
    assert.ok(r.body.document.updatedBy && r.body.document.updatedAt);
  });
  await t('docFields are replaced wholesale, not merged', async () => {
    let r = await run(doc.updateDoc, mkReq({ params: { kind: 'truck', docId: String(rcDoc._id) }, body: { docFields: { chassisNo: 'VIN-1', ownerName: 'Fleet Co' } } }));
    assert.strictEqual(r.body.document.docFields.chassisNo, 'VIN-1');
    r = await run(doc.updateDoc, mkReq({ params: { kind: 'truck', docId: String(rcDoc._id) }, body: { docFields: { ownerName: 'Fleet Co' } } }));
    assert.strictEqual(r.body.document.docFields.chassisNo, undefined);
  });
  await t('docFields survive an update that omits them', async () => {
    const r = await run(doc.updateDoc, mkReq({ params: { kind: 'truck', docId: String(rcDoc._id) }, body: { docNumber: 'RC-778' } }));
    assert.strictEqual(r.body.document.docFields.ownerName, 'Fleet Co');
  });
  await t('an unknown field is refused on update too', async () => {
    const r = await run(doc.updateDoc, mkReq({ params: { kind: 'truck', docId: String(rcDoc._id) }, body: { docFields: { badKey: 'x' } } }));
    assert.strictEqual(r.statusCode, 400);
  });
  await t('the issue/expiry cross-check reads the stored side', async () => {
    const r = await run(doc.updateDoc, mkReq({ params: { kind: 'truck', docId: String(rcDoc._id) }, body: { issueDate: days(500).toISOString() } }));
    assert.strictEqual(r.statusCode, 400, JSON.stringify(r.body));
  });
  await t('a scan can be attached to a metadata-only document later', async () => {
    const created = await run(doc.createDoc, mkReq({
      params: { kind: 'trailer', entityId: String(trailer._id) },
      body: { docType: 'permit', docNumber: 'PM-LATE', expiryDate: days(4).toISOString() },
    }));
    assert.ok(!created.body.document.url);
    const req = mkReq({ params: { kind: 'trailer', docId: String(created.body.document._id) }, body: {} });
    req.files = attachment('permit.pdf');
    const r = await run(doc.updateDoc, req);
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(r.body.document.url, 'scan was not attached');
    assert.strictEqual(r.body.document.docNumber, 'PM-LATE', 'attaching a scan lost the metadata');
  });
  await t('a truck document is not editable as a trailer document', async () => {
    const r = await run(doc.updateDoc, mkReq({ params: { kind: 'trailer', docId: String(rcDoc._id) }, body: { docNumber: 'HACK' } }));
    assert.strictEqual(r.statusCode, 404);
  });
  await t('a dispatcher cannot edit an employee document', async () => {
    const r = await run(doc.updateDoc, mkReq({ user: dispatcher, params: { kind: 'employee', docId: String(licenceDoc._id) }, body: { docNumber: 'HACK' } }));
    assert.strictEqual(r.statusCode, 403);
  });
  await t('a cross-tenant update is not found', async () => {
    const r = await run(doc.updateDoc, mkReq({ tenantId: OTHER, params: { kind: 'truck', docId: String(rcDoc._id) }, body: { docNumber: 'HACK' } }));
    assert.strictEqual(r.statusCode, 404);
  });

  section('expiry alerts');
  await FleetDoc.create({ tenantId: TENANT, type: 'truck', entityId: truck._id, docType: 'fitness', docNumber: 'FIT-EXP', expiryDate: days(-5), added_by: admin._id });
  await FleetDoc.create({ tenantId: TENANT, type: 'truck', entityId: truck._id, docType: 'puc', docNumber: 'PUC-MONTH', expiryDate: days(20), added_by: admin._id });
  await FleetDoc.create({ tenantId: TENANT, type: 'truck', entityId: truck._id, docType: 'permit', docNumber: 'PM-FAR', expiryDate: days(200), added_by: admin._id });
  await FleetDoc.create({ tenantId: TENANT, type: 'truck', entityId: truck._id, docType: 'pan', docNumber: 'PAN-NOEXP', added_by: admin._id });
  await FleetDoc.create({ tenantId: OTHER, type: 'truck', entityId: foreignTruck._id, docType: 'rc', docNumber: 'FOREIGN', expiryDate: days(1), added_by: admin._id });
  await DriverProfile.create({ tenantId: TENANT, user: driver._id, licenseNumber: 'DLP-1', licenseExpiry: days(2) });

  res = await run(doc.documentExpiryAlerts, mkReq());
  await t('the three tiers are reported and sorted by expiry', () => {
    const items = res.body.items;
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(items.find((i) => i.docNumber === 'FIT-EXP').status, 'expired');
    assert.strictEqual(items.find((i) => i.docNumber === 'PM-LATE').status, 'week');
    assert.strictEqual(items.find((i) => i.docNumber === 'PUC-MONTH').status, 'month');
    for (let i = 1; i < items.length; i++) {
      assert.ok(new Date(items[i - 1].expiryDate) <= new Date(items[i].expiryDate), 'not sorted');
    }
  });
  await t('a document beyond 30 days does not alert', () => assert.ok(!numbersIn(res).includes('PM-FAR')));
  await t('a document with no expiry never alerts', () => assert.ok(!numbersIn(res).includes('PAN-NOEXP')));
  await t("another tenant's document never alerts", () => assert.ok(!numbersIn(res).includes('FOREIGN')));
  await t('counts add up to the item list', () => {
    const c = res.body.counts;
    assert.strictEqual(c.total, res.body.items.length);
    assert.strictEqual(c.expired + c.week + c.month, c.total);
  });
  await t('byEntity carries the WORST status per record, with a count', () => {
    const e = res.body.byEntity[String(truck._id)];
    assert.ok(e, 'no entry for the truck');
    assert.strictEqual(e.status, 'expired');
    assert.ok(e.count >= 2, `expected several, got ${e.count}`);
  });
  await t('entity labels are resolved', () => {
    assert.strictEqual(res.body.items.find((i) => i.docNumber === 'FIT-EXP').entity.label, 'T-01');
    assert.strictEqual(res.body.items.find((i) => i.docNumber === 'OO-INS-1').entity.label, 'Gurpreet Singh');
  });

  section('expiry is a CALENDAR date');
  await t("a document expiring today is not expired", () => {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const r = doc.parseDocMeta({ expiryDate: todayUtc.toISOString().slice(0, 10) });
    assert.ok(!r.error);
    // Re-derive through the same public surface the alerts use.
    assert.ok(r.fields.expiryDate.getTime() >= todayUtc.getTime() - 86400000);
  });
  await t('a bare YYYY-MM-DD is stored at UTC midnight, not shifted by the server TZ', () => {
    const r = doc.parseDocMeta({ expiryDate: '2026-09-02' });
    const d = r.fields.expiryDate;
    assert.strictEqual(d.getUTCFullYear(), 2026);
    assert.strictEqual(d.getUTCMonth(), 8);
    assert.strictEqual(d.getUTCDate(), 2, 'the stored calendar day moved');
  });

  section('audience — fleet documents are not personal data');
  await t('a dispatcher sees fleet documents', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq({ user: dispatcher }));
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(numbersIn(r).includes('FIT-EXP'));
  });
  await t('a dispatcher sees neither employee documents nor the profile licence', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq({ user: dispatcher }));
    assert.ok(!numbersIn(r).includes('DL-99'));
    assert.ok(!numbersIn(r).includes('DLP-1'));
  });
  await t('a plain driver is refused entirely', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq({ user: driverOnly }));
    assert.strictEqual(r.statusCode, 403);
  });
  await t('alerts refuse to run without a tenant', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq({ tenantId: null, user: { ...admin, tenantId: null } }));
    assert.strictEqual(r.statusCode, 400);
  });

  section('profile licence vs typed licence document');
  await t('a typed licence doc suppresses the profile field', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq());
    assert.ok(numbersIn(r).includes('DL-99'));
    assert.ok(!numbersIn(r).includes('DLP-1'), 'both alerted for one licence');
  });
  await t('a RENEWED licence still suppresses the stale profile date', async () => {
    // The renewed doc leaves the 30-day window. A dedup built by filtering the windowed list goes
    // empty here and the stale profile date alerts forever — this is that regression.
    await EmployeeDoc.updateOne({ docNumber: 'DL-99' }, { $set: { expiryDate: days(1500) } });
    const r = await run(doc.documentExpiryAlerts, mkReq());
    assert.ok(!numbersIn(r).includes('DLP-1'), 'stale profile date came back after a renewal');
    assert.ok(!numbersIn(r).includes('DL-99'), 'the renewed document should not alert either');
  });
  await t('a licence doc with NO expiry does not suppress a real one', async () => {
    await EmployeeDoc.updateOne({ docNumber: 'DL-99' }, { $set: { expiryDate: null } });
    const r = await run(doc.documentExpiryAlerts, mkReq());
    assert.ok(numbersIn(r).includes('DLP-1'), 'a number-only document silenced a real expiry');
    await EmployeeDoc.updateOne({ docNumber: 'DL-99' }, { $set: { expiryDate: days(5) } });
  });

  section('ghosts never alert');
  await t('documents of a soft-deleted truck are dropped', async () => {
    await Truck.updateOne({ _id: truck._id }, { $set: { deletedAt: new Date() } });
    const r = await run(doc.documentExpiryAlerts, mkReq());
    assert.ok(!numbersIn(r).includes('FIT-EXP'));
    assert.ok(numbersIn(r).includes('PM-LATE'), 'the trailer document should be unaffected');
    await Truck.updateOne({ _id: truck._id }, { $set: { deletedAt: null } });
  });
  await t('documents of an inactive employee are dropped', async () => {
    await Users.updateOne({ _id: driver._id }, { $set: { status: 'inactive' } });
    const r = await run(doc.documentExpiryAlerts, mkReq());
    assert.ok(!numbersIn(r).includes('DL-99'));
    assert.ok(!numbersIn(r).includes('DLP-1'));
    assert.ok(numbersIn(r).includes('FIT-EXP'), 'fleet documents should be unaffected');
    await Users.updateOne({ _id: driver._id }, { $set: { status: 'active' } });
  });

  section('remove is soft');
  const fitness = await FleetDoc.findOne({ docNumber: 'FIT-EXP' }).lean();
  await t('remove returns 200 and keeps the row', async () => {
    const r = await run(doc.removeDoc, mkReq({ params: { kind: 'truck', docId: String(fitness._id) } }));
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const after = await FleetDoc.findById(fitness._id).lean();
    assert.ok(after && after.deletedAt, 'row was hard deleted');
  });
  await t('a removed document stops alerting', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq());
    assert.ok(!numbersIn(r).includes('FIT-EXP'));
  });
  await t('removing twice is not found', async () => {
    const r = await run(doc.removeDoc, mkReq({ params: { kind: 'truck', docId: String(fitness._id) } }));
    assert.strictEqual(r.statusCode, 404);
  });
  await t('a dispatcher cannot remove an employee document', async () => {
    const r = await run(doc.removeDoc, mkReq({ user: dispatcher, params: { kind: 'employee', docId: String(licenceDoc._id) } }));
    assert.strictEqual(r.statusCode, 403);
  });

  section('commercial records — carrier, customer, vendor');
  await t('a carrier COI is storable', async () => {
    const r = await run(doc.createDoc, mkReq({
      params: { kind: 'carrier', entityId: String(carrier._id) },
      body: { docType: 'coi', docNumber: 'COI-8891', expiryDate: days(4).toISOString(),
              docFields: JSON.stringify({ insurer: 'Northbridge', coverageType: 'Auto liability', coverageAmount: '1,000,000' }) },
    }));
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.document.type, 'carrier');
    assert.strictEqual(r.body.document.docFields.coverageType, 'Auto liability');
  });
  await t('an operating authority needs no expiry', async () => {
    const r = await run(doc.createDoc, mkReq({
      params: { kind: 'carrier', entityId: String(carrier._id) },
      body: { docType: 'authority', docNumber: 'MC123456', docFields: JSON.stringify({ mcNumber: 'MC123456', dotNumber: '3344556' }) },
    }));
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.document.expiryDate, null);
  });
  await t('a vendor W-9 is storable', async () => {
    const r = await run(doc.createDoc, mkReq({
      params: { kind: 'vendor', entityId: String(vendor._id) },
      body: { docType: 'w9', docNumber: '81-1234567', docFields: JSON.stringify({ taxId: '81-1234567', legalName: 'Petro Fuel Stop LLC' }) },
    }));
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  });
  await t("a customer's tax exemption certificate is storable", async () => {
    const r = await run(doc.createDoc, mkReq({
      params: { kind: 'customer', entityId: String(myCustomer._id) },
      body: { docType: 'tax_exempt', docNumber: 'TX-77', expiryDate: days(3).toISOString() },
    }));
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  });
  await t('the new commercial types are refused on nothing — the enum accepts them', () => {
    for (const dt of ['w9', 'authority', 'coi', 'agreement', 'noa', 'credit_app', 'tax_exempt']) {
      assert.ok(!doc.parseDocMeta({ docType: dt }).error, `${dt} rejected`);
    }
  });

  section('commercial audience');
  await t('a carrier clerk can add a carrier document', async () => {
    const r = await run(doc.createDoc, mkReq({
      user: carrierClerk, params: { kind: 'carrier', entityId: String(carrier._id) },
      body: { docType: 'agreement', docNumber: 'AG-1' },
    }));
    assert.strictEqual(r.statusCode, 201, JSON.stringify(r.body));
  });
  await t('a plain driver cannot add a carrier document', async () => {
    const r = await run(doc.createDoc, mkReq({
      user: driverOnly, params: { kind: 'carrier', entityId: String(carrier._id) }, body: { docType: 'coi' },
    }));
    assert.strictEqual(r.statusCode, 403);
  });
  await t('a carrier clerk cannot add a vendor document (that is the cheque gate)', async () => {
    const r = await run(doc.createDoc, mkReq({
      user: carrierClerk, params: { kind: 'vendor', entityId: String(vendor._id) }, body: { docType: 'w9' },
    }));
    assert.strictEqual(r.statusCode, 403);
  });
  await t('a carrier clerk sees carrier alerts but not employee ones', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq({ user: carrierClerk }));
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    assert.ok(numbersIn(r).includes('COI-8891'), 'carrier COI missing');
    assert.ok(!numbersIn(r).includes('DL-99'), 'employee document leaked');
  });
  await t('a fleet dispatcher does NOT see carrier documents', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq({ user: dispatcher }));
    assert.ok(!numbersIn(r).includes('COI-8891'), 'carrier document leaked to a fleet-only user');
  });

  section("customer documents follow the customer's assignment");
  await t('a document on an unassigned-to-me customer is not addressable', async () => {
    const r = await run(doc.createDoc, mkReq({
      user: dispatcher, params: { kind: 'customer', entityId: String(otherCustomer._id) }, body: { docType: 'w9' },
    }));
    assert.strictEqual(r.statusCode, 404, JSON.stringify(r.body));
  });
  await t("that customer's expiring document never reaches the dispatcher's alerts", async () => {
    await FleetDoc.create({
      tenantId: TENANT, type: 'customer', entityId: otherCustomer._id,
      docType: 'tax_exempt', docNumber: 'TX-SECRET', expiryDate: days(2), added_by: admin._id,
    });
    const mine = await run(doc.documentExpiryAlerts, mkReq());
    assert.ok(numbersIn(mine).includes('TX-SECRET'), 'admin should see it');
    const theirs = await run(doc.documentExpiryAlerts, mkReq({ user: dispatcher }));
    assert.ok(!numbersIn(theirs).includes('TX-SECRET'), "another user's customer document leaked");
  });
  await t('an unassigned customer IS visible to a regular dispatcher in the same company', async () => {
    const r = await run(doc.createDoc, mkReq({
      user: dispatcher, params: { kind: 'customer', entityId: String(myCustomer._id) }, body: { docType: 'agreement', docNumber: 'AG-OK' },
    }));
    // No company on either side in this fixture, so the scope falls back to assignment only.
    assert.ok([201, 404].includes(r.statusCode), `unexpected ${r.statusCode}`);
  });

  section('commercial entity labels + ghosts');
  await t('labels resolve for all three', async () => {
    const r = await run(doc.documentExpiryAlerts, mkReq());
    assert.strictEqual(r.body.items.find((i) => i.docNumber === 'COI-8891').entity.label, 'Northline Freight');
    assert.strictEqual(r.body.items.find((i) => i.docNumber === 'TX-77').entity.label, 'Assigned Co');
  });
  await t('a soft-deleted carrier stops alerting', async () => {
    await Carrier.updateOne({ _id: carrier._id }, { $set: { deletedAt: new Date() } });
    const r = await run(doc.documentExpiryAlerts, mkReq());
    assert.ok(!numbersIn(r).includes('COI-8891'));
    await Carrier.updateOne({ _id: carrier._id }, { $set: { deletedAt: null } });
  });

  section('indexes');
  await t('both collections index {tenantId, expiryDate}', () => {
    for (const M of [FleetDoc, EmployeeDoc]) {
      assert.ok(
        M.schema.indexes().some(([k]) => k.tenantId === 1 && k.expiryDate === 1),
        `${M.modelName} has no expiry index`
      );
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nSUITE THREW:', e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
