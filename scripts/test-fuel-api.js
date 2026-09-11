#!/usr/bin/env node
'use strict';
/**
 * Fuel pricing API tests — upload, profiles, preview, publish, PDF, CSV.
 *
 * Needs a throwaway local mongod (DB_URL_OFFICE in this repo points at PRODUCTION,
 * so this suite never reads it):
 *   mkdir -p /tmp/fuel && mongod --dbpath /tmp/fuel --port 27099 --fork --logpath /tmp/fuel/log
 *
 * Uses TEST_DB_URL, default mongodb://127.0.0.1:27099/carrier_fuel_test. It REFUSES to
 * run against anything that is not localhost, because it drops the database at the end.
 *
 * What it pins down:
 *   - the four real vendor files upload, parse and price through the HTTP handlers
 *   - the access gate, and that a missing tenant is refused rather than run unscoped
 *   - tenant isolation on every read
 *   - a flat margin profile cannot be applied to a sheet measured in another unit
 *   - a sheet with unreadable lines can be previewed but never published
 *   - publishing SNAPSHOTS, so editing the profile afterwards does not move a
 *     document that has already gone to a customer
 *   - the PDF and the CSV are rendered from the snapshot
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const URI = process.env.TEST_DB_URL || 'mongodb://127.0.0.1:27099/carrier_fuel_test';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) {
  console.error(`Refusing to run against a non-local database: ${URI}`);
  process.exit(1);
}

// The audit chain is not under test; capture what would have been written.
const loggerPath = require.resolve('../utils/activityLogger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true, exports: {
    logActivity: () => {},
    logChange: async (req, payload) => { global.__audit.push(payload); },
    CreatePaymentLog: async () => {},
    AUDIT_FIELDS: {},
  },
};
global.__audit = [];

// The real uploader PUTs to BunnyCDN.
const uploadPath = require.resolve('../utils/fileupload');
require.cache[uploadPath] = {
  id: uploadPath, filename: uploadPath, loaded: true,
  exports: async (f) => ({ message: 'ok', mime: f.mimetype, filename: `stub-${f.originalname}`, url: `https://cdn.test/${f.originalname}`, file: f, size: f.size }),
};

const FuelPriceSheet = require('../db/FuelPriceSheet');
const FuelMarginProfile = require('../db/FuelMarginProfile');
const FuelSheetOutput = require('../db/FuelSheetOutput');
const Company = require('../db/Company');
const Customer = require('../db/Customer');
const fuel = require('../controllers/fuelPriceController');
const { fmtMoney } = require('../utils/fuelParsers/shared');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n         ${e.message}`); }
};
const section = (s) => console.log(`\n${s}`);

// catchAsync does NOT return its promise, so awaiting the handler resolves immediately.
// Wait on the RESPONSE instead. `end()` is used by the PDF/CSV routes.
function mkRes() {
  const r = { statusCode: 200, body: null, headers: {}, raw: null };
  r.done = new Promise((res, rej) => { r._resolve = res; r._reject = rej; });
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r._resolve(r); return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.raw = b; r._resolve(r); return r; };
  return r;
}
async function run(handler, req, timeout = 40000) {
  const res = mkRes();
  handler(req, res, (e) => res._reject(e || new Error('next() with no error')));
  await Promise.race([res.done, new Promise((_, rej) => setTimeout(() => rej(new Error('handler timed out')), timeout))]);
  return res;
}

const TENANT = 'fuel-test-tenant';
const OTHER = 'fuel-other-tenant';
const admin = { _id: new mongoose.Types.ObjectId(), is_admin: 1, role: 3, tenantId: TENANT, permissions: [], name: 'Admin' };
const accountant = { _id: new mongoose.Types.ObjectId(), is_admin: 0, tenantId: TENANT, permissions: ['accounting'], name: 'Accounts' };
const dispatcher = { _id: new mongoose.Types.ObjectId(), is_admin: 0, tenantId: TENANT, permissions: ['regular'], name: 'Dispatcher' };
const driverOnly = { _id: new mongoose.Types.ObjectId(), is_admin: 0, tenantId: TENANT, permissions: ['driver'], name: 'Driver' };
const mkReq = (over = {}) => ({ user: admin, tenantId: TENANT, params: {}, body: {}, query: {}, headers: {}, ...over });

const FIX = path.join(__dirname, '..', '__fixtures__', 'fuel');
const TMP = path.join(require('os').tmpdir(), 'fuel-api-test');

/** multer hands the controller a file on disk; copy the fixture so the handler can unlink it. */
function fileField(fixture, field = 'attachment') {
  fs.mkdirSync(TMP, { recursive: true });
  const src = path.join(FIX, fixture);
  const dest = path.join(TMP, `${Date.now()}-${fixture}`);
  fs.copyFileSync(src, dest);
  const stat = fs.statSync(dest);
  return {
    [field]: [{
      path: dest,
      originalname: fixture,
      filename: path.basename(dest),
      mimetype: fixture.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: stat.size,
    }],
  };
}
const upload = (fixture, body = {}) => run(fuel.uploadFuelSheet, mkReq({ files: fileField(fixture), body }));

(async () => {
  await mongoose.connect(URI, { autoIndex: true });
  await mongoose.connection.dropDatabase();
  console.log(`Fuel pricing API — ${URI}`);

  await Company.create({
    tenantId: TENANT, name: 'Cross Miles Carrier Inc',
    address: '12 Steeles Ave, Brampton, ON', email: 'ops@crossmiles.test', phone: '905-000-0000',
  });
  const customer = await Customer.create({
    tenantId: TENANT, name: 'Northbound Freight', email: 'ops@northbound.test',
    phone: '4160001111', address: '900 Dixie Rd', city: 'Mississauga', state: 'ON', country: 'Canada', zipcode: 'L4W 1A1',
  });

  // ---------------------------------------------------------------- gate
  section('access');
  await t('a plain driver cannot see fuel pricing', async () => {
    const res = await run(fuel.listFuelSheets, mkReq({ user: driverOnly }));
    assert.strictEqual(res.statusCode, 403);
  });
  await t('a dispatcher cannot see fuel pricing', async () => {
    const res = await run(fuel.listFuelSheets, mkReq({ user: dispatcher }));
    assert.strictEqual(res.statusCode, 403);
  });
  await t('an accountant can', async () => {
    const res = await run(fuel.listFuelSheets, mkReq({ user: accountant }));
    assert.strictEqual(res.statusCode, 200);
  });
  await t('a missing tenant is refused, never run unscoped', async () => {
    const res = await run(fuel.listFuelSheets, mkReq({ tenantId: null, user: { ...admin, tenantId: null } }));
    assert.strictEqual(res.statusCode, 400);
  });
  await t('the vendor catalogue lists all four parsers', async () => {
    const res = await run(fuel.fuelVendors, mkReq());
    assert.strictEqual(res.body.vendors.length, 4);
  });

  // ---------------------------------------------------------------- upload
  section('upload + parse');
  const sheets = {};
  for (const [key, fixture, rows] of [
    ['flyingJ', 'flying-j-cad-2026-09-09.pdf', 54],
    ['avaal', 'avaal-blue-esso-2026-09-04.pdf', 76],
    ['ta', 'ta-petro-2026-09-09.pdf', 350],
    ['petro', 'petro-canada-2026-08-24.xlsx', 339],
  ]) {
    await t(`${fixture} uploads and parses ${rows} rows`, async () => {
      const res = await upload(fixture);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.sheet.stats.rows, rows);
      assert.strictEqual(res.body.unparsed.length, 0);
      sheets[key] = res.body.sheet;
    });
  }
  await t('the sheet records what the vendor prices run between', async () => {
    const doc = await FuelPriceSheet.findById(sheets.flyingJ._id).lean();
    // Flying J's own prices, min and max of the column a margin applies to
    assert.strictEqual(fmtMoney(doc.stats.priceRange.minInt, 4), '1.9635');
    assert.strictEqual(fmtMoney(doc.stats.priceRange.maxInt, 4), '2.4830');
  });
  await t('a sheet whose price column is not known yet has no range', async () => {
    const res = await upload('unknown-vendor-rack.xlsx');
    const doc = await FuelPriceSheet.findById(res.body.sheet._id).lean();
    assert.strictEqual(doc.stats.priceRange, null);
    await run(fuel.removeFuelSheet, mkReq({ params: { id: String(res.body.sheet._id) } }));
  });
  await t('the uploaded rows are stored, money and all', async () => {
    const doc = await FuelPriceSheet.findById(sheets.flyingJ._id).lean();
    assert.strictEqual(doc.rows.length, 54);
    const r = doc.rows.find((x) => x.text.site_number === '813');
    assert.strictEqual(fmtMoney(r.money.price_ex_tax.int, 4), '2.0090');
    assert.strictEqual(doc.unit, 'per_litre');
    assert.strictEqual(doc.currency, 'CAD');
  });
  await t('the original file is kept for audit', async () => {
    const doc = await FuelPriceSheet.findById(sheets.ta._id).lean();
    assert.ok(doc.sourceFile.url, 'no stored source file');
  });
  await t('the upload is audited', () => {
    assert.ok(global.__audit.some((a) => a.model === 'FuelPriceSheet' && a.action === 'CREATE'));
  });
  await t('an XLSX workbook reports both of its days', async () => {
    const doc = await FuelPriceSheet.findById(sheets.petro._id).lean();
    assert.strictEqual(doc.availableSheets.length, 2);
    assert.strictEqual(doc.effectiveDate, '2026-08-24');
  });
  await t('the second day of the workbook can be uploaded on its own', async () => {
    const res = await upload('petro-canada-2026-08-24.xlsx', { sheet: '1' });
    assert.strictEqual(res.body.sheet.effectiveDate, '2026-08-25');
  });
  await t('a file that is not a known vendor sheet is refused with a reason', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'junk.pdf');
    fs.writeFileSync(p, '%PDF-1.4 not really');
    const res = await run(fuel.uploadFuelSheet, mkReq({ files: { attachment: [{ path: p, originalname: 'junk.pdf', filename: 'junk.pdf', mimetype: 'application/pdf', size: 19 }] } }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'pdf_unreadable');
  });
  await t('an upload with no file is refused', async () => {
    const res = await run(fuel.uploadFuelSheet, mkReq({ files: {} }));
    assert.strictEqual(res.statusCode, 400);
  });
  await t('a driver cannot upload', async () => {
    const res = await run(fuel.uploadFuelSheet, mkReq({ user: driverOnly, files: fileField('flying-j-cad-2026-09-09.pdf') }));
    assert.strictEqual(res.statusCode, 403);
  });

  // ---------------------------------------------------------------- tenant isolation
  section('tenant isolation');
  await t('another tenant cannot read the sheet', async () => {
    const res = await run(fuel.fuelSheetDetail, mkReq({ tenantId: OTHER, user: { ...admin, tenantId: OTHER }, params: { id: String(sheets.flyingJ._id) } }));
    assert.strictEqual(res.statusCode, 404);
  });
  await t('another tenant lists none of them', async () => {
    const res = await run(fuel.listFuelSheets, mkReq({ tenantId: OTHER, user: { ...admin, tenantId: OTHER } }));
    assert.strictEqual(res.body.sheets.length, 0);
  });
  await t('a malformed sheet id is refused, not cast-crashed', async () => {
    const res = await run(fuel.fuelSheetDetail, mkReq({ params: { id: 'not-an-id' } }));
    assert.strictEqual(res.statusCode, 400);
  });

  // ---------------------------------------------------------------- profiles
  section('margin profiles');
  let profile;
  await t('a flat profile is saved with the unit it was written for', async () => {
    const res = await run(fuel.addMarginProfile, mkReq({
      body: {
        name: 'Standard +5c', unit: 'per_litre', taxMode: 'recompute',
        rules: [
          { scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' },
          { scope: 'region', match: 'BC', mode: 'flat', direction: 'add', value: '0.0800' },
        ],
      },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    profile = res.body.profile;
    assert.strictEqual(profile.unit, 'per_litre');
  });
  await t('a percent-only profile is unit-agnostic', async () => {
    const res = await run(fuel.addMarginProfile, mkReq({
      body: { name: 'Plus 3 percent', rules: [{ scope: 'global', mode: 'percent', direction: 'add', value: '3' }] },
    }));
    assert.strictEqual(res.body.profile.unit, 'any');
  });
  await t('a flat profile with no unit is refused', async () => {
    const res = await run(fuel.addMarginProfile, mkReq({
      body: { name: 'No unit', rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.05' }] },
    }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'unit_required');
  });
  await t('a profile with no rules is refused', async () => {
    const res = await run(fuel.addMarginProfile, mkReq({ body: { name: 'Empty', rules: [] } }));
    assert.strictEqual(res.statusCode, 400);
  });
  await t('an unnamed profile is refused', async () => {
    const res = await run(fuel.addMarginProfile, mkReq({ body: { rules: [{ scope: 'global', value: '1' }] } }));
    assert.strictEqual(res.statusCode, 400);
  });
  await t('a negative rule value is refused with a code', async () => {
    const res = await run(fuel.addMarginProfile, mkReq({
      body: { name: 'Bad', unit: 'per_litre', rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '-1' }] },
    }));
    assert.strictEqual(res.body.code, 'rule_value_negative');
  });
  await t('a customer-scoped profile requires a real customer', async () => {
    const res = await run(fuel.addMarginProfile, mkReq({
      body: { name: 'Ghost', unit: 'per_litre', customer: String(new mongoose.Types.ObjectId()), rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.05' }] },
    }));
    assert.strictEqual(res.statusCode, 400);
  });
  await t('a profile edit is audited with a before image', async () => {
    global.__audit.length = 0;
    const res = await run(fuel.updateMarginProfile, mkReq({
      params: { id: String(profile._id) },
      body: { name: 'Standard +6c', unit: 'per_litre', rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0600' }] },
    }));
    assert.strictEqual(res.statusCode, 200);
    const entry = global.__audit.find((a) => a.model === 'FuelMarginProfile' && a.action === 'UPDATE');
    assert.ok(entry && entry.before, 'no before image recorded');
    // put it back
    await run(fuel.updateMarginProfile, mkReq({
      params: { id: String(profile._id) },
      body: {
        name: 'Standard +5c', unit: 'per_litre', taxMode: 'recompute',
        rules: [
          { scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' },
          { scope: 'region', match: 'BC', mode: 'flat', direction: 'add', value: '0.0800' },
        ],
      },
    }));
  });

  // ---------------------------------------------------------------- preview
  section('preview');
  let preview;
  await t('a sheet prices against a saved profile', async () => {
    const res = await run(fuel.previewFuelSheet, mkReq({ params: { id: String(sheets.flyingJ._id) }, body: { profile: String(profile._id) } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    preview = res.body;
    assert.strictEqual(preview.totals.priced, 54);
    assert.strictEqual(preview.canPublish, true);
  });
  await t('the global rule is applied', () => {
    const r = preview.rows.find((x) => x.text.site_number === '813');
    assert.strictEqual(fmtMoney(r.finalInt, 4), '2.0590');
    assert.strictEqual(r.rule.scope, 'global');
  });
  await t('a region rule beats the global one', () => {
    const r = preview.rows.find((x) => x.text.site_number === '827');
    assert.strictEqual(r.rule.scope, 'region');
    assert.strictEqual(fmtMoney(r.finalInt, 4), '2.4420');
  });
  await t('tax is recomputed on the new price', () => {
    const r = preview.rows.find((x) => x.text.site_number === '813');
    assert.strictEqual(fmtMoney(r.taxes.gst, 4), '0.1030');
    assert.strictEqual(fmtMoney(r.totalInt, 4), '2.1620');
  });
  await t('every row says which rule priced it', () => {
    assert.strictEqual(preview.rows.filter((r) => r.priced && r.ruleIndex === null).length, 0);
  });
  await t('a per-litre profile cannot price a cents-per-litre sheet', async () => {
    const res = await run(fuel.previewFuelSheet, mkReq({ params: { id: String(sheets.avaal._id) }, body: { profile: String(profile._id) } }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'profile_unit_mismatch');
  });
  await t('a per-litre profile cannot price a per-gallon sheet either', async () => {
    const res = await run(fuel.previewFuelSheet, mkReq({ params: { id: String(sheets.ta._id) }, body: { profile: String(profile._id) } }));
    assert.strictEqual(res.body.code, 'profile_unit_mismatch');
  });
  await t('a percent profile prices any sheet', async () => {
    const pct = await FuelMarginProfile.findOne({ tenantId: TENANT, name: 'Plus 3 percent' }).lean();
    const res = await run(fuel.previewFuelSheet, mkReq({ params: { id: String(sheets.ta._id) }, body: { profile: String(pct._id) } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.totals.priced, 350);
    assert.strictEqual(res.body.unit, 'per_gallon');
  });
  await t('ad-hoc rules can be previewed without saving a profile', async () => {
    const res = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(sheets.avaal._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '5' }] },
    }));
    assert.strictEqual(res.statusCode, 200);
    const r = res.body.rows.find((x) => x.text.site_id === '53936');
    assert.strictEqual(fmtMoney(r.finalInt, 2), '200.50');
  });
  await t('a preview with no margin at all is refused', async () => {
    const res = await run(fuel.previewFuelSheet, mkReq({ params: { id: String(sheets.flyingJ._id) }, body: {} }));
    assert.strictEqual(res.body.code, 'no_margin');
  });
  await t('rows left uncovered by any rule block publishing', async () => {
    const res = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(sheets.flyingJ._id) },
      body: { rules: [{ scope: 'region', match: 'BC', mode: 'flat', direction: 'add', value: '0.05' }] },
    }));
    assert.strictEqual(res.body.canPublish, false);
    assert.ok(res.body.blockers.some((b) => b.code === 'rows_without_rule'));
  });

  // ---------------------------------------------------------------- publish
  section('publish');
  let output;
  await t('a priced sheet publishes', async () => {
    const res = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.flyingJ._id) },
      body: { profile: String(profile._id), customer: String(customer._id), title: 'Diesel Price List' },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    output = res.body.output;
    assert.strictEqual(output.rows, 54);
    assert.strictEqual(output.version, 1);
  });
  await t('publishing snapshots the rules and the branding', async () => {
    const doc = await FuelSheetOutput.findById(output._id).lean();
    assert.strictEqual(doc.profileSnapshot.rules.length, 2);
    assert.strictEqual(doc.brandingSnapshot.name, 'Cross Miles Carrier Inc');
    assert.strictEqual(doc.brandingSnapshot.customerName, 'Northbound Freight');
    assert.strictEqual(doc.rows.length, 54);
  });
  await t('a published sheet does NOT move when the profile is later edited', async () => {
    const before = await FuelSheetOutput.findById(output._id).lean();
    const priceBefore = before.rows.find((r) => r.text.site_number === '813').finalInt;
    await run(fuel.updateMarginProfile, mkReq({
      params: { id: String(profile._id) },
      body: { name: 'Standard +50c', unit: 'per_litre', rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.5000' }] },
    }));
    const after = await FuelSheetOutput.findById(output._id).lean();
    assert.strictEqual(after.rows.find((r) => r.text.site_number === '813').finalInt, priceBefore);
    assert.strictEqual(after.profileSnapshot.rules[0].value, '0.0500');
  });
  await t('republishing makes version 2, it does not edit version 1', async () => {
    const res = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.flyingJ._id) },
      body: { profile: String(profile._id), title: 'Diesel Price List' },
    }));
    assert.strictEqual(res.body.output.version, 2);
    const v1 = await FuelSheetOutput.findById(output._id).lean();
    assert.strictEqual(v1.version, 1);
    assert.strictEqual(fmtMoney(v1.rows.find((r) => r.text.site_number === '813').finalInt, 4), '2.0590');
  });
  await t('republishing for the same customer supersedes the earlier sheet', async () => {
    const first = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.ta._id) },
      body: {
        rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.100' }],
        customer: String(customer._id), title: 'US Diesel',
      },
    }));
    assert.strictEqual(first.statusCode, 200, JSON.stringify(first.body));
    const second = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.ta._id) },
      body: {
        rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.150' }],
        customer: String(customer._id), title: 'US Diesel',
      },
    }));
    assert.strictEqual(second.body.output.superseded, 1, 'the earlier sheet was not superseded');
    const old = await FuelSheetOutput.findById(first.body.output._id).lean();
    assert.strictEqual(old.status, 'superseded');
    assert.strictEqual(String(old.supersededBy), String(second.body.output._id));
    // the old one keeps its numbers — it is a record of what was actually sent
    assert.strictEqual(old.rows.length, 350);
  });
  await t('a general price list is not superseded by a customer-specific one', async () => {
    const general = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.ta._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.200' }], title: 'US Diesel' },
    }));
    assert.strictEqual(general.body.output.superseded, 0);
  });
  await t('published sheets can be filtered by status', async () => {
    const sup = await run(fuel.listFuelOutputs, mkReq({ query: { status: 'superseded' } }));
    assert.ok(sup.body.outputs.length >= 1);
    assert.ok(sup.body.outputs.every((o) => o.status === 'superseded'));
    const bad = await run(fuel.listFuelOutputs, mkReq({ query: { status: 'whatever' } }));
    assert.strictEqual(bad.statusCode, 400);
  });
  await t('a superseded sheet can still be downloaded — it is what the customer holds', async () => {
    const sup = await run(fuel.listFuelOutputs, mkReq({ query: { status: 'superseded' } }));
    const res = await run(fuel.fuelOutputCsv, mkReq({ params: { id: String(sup.body.outputs[0]._id) } }));
    assert.strictEqual(res.statusCode, 200);
  });
  await t('a sheet with no locations cannot be published', async () => {
    const doc = await FuelPriceSheet.findById(sheets.petro._id);
    const keep = doc.rows;
    doc.rows = [];
    await doc.save();
    const res = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.petro._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.05' }] },
    }));
    assert.strictEqual(res.statusCode, 400);
    assert.ok((res.body.blockers || []).some((b) => b.code === 'sheet_has_no_rows'), JSON.stringify(res.body));
    doc.rows = keep;
    await doc.save();
  });
  await t('a blocked sheet cannot be published', async () => {
    const res = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.flyingJ._id) },
      body: { rules: [{ scope: 'region', match: 'BC', mode: 'flat', direction: 'add', value: '0.05' }] },
    }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'blocked');
  });
  await t('a sheet whose lines could not all be read can be previewed but never published', async () => {
    const doc = await FuelPriceSheet.findById(sheets.avaal._id);
    doc.unparsed = [{ text: '99999 ESSO SOMEWHERE AB DSL $ 1.00', context: { page: 2 } }];
    await doc.save();
    const prev = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(sheets.avaal._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '5' }] },
    }));
    assert.strictEqual(prev.statusCode, 200);
    assert.strictEqual(prev.body.canPublish, false);
    assert.ok(prev.body.blockers.some((b) => b.code === 'unparsed_lines'));
    const pub = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.avaal._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '5' }] },
    }));
    assert.strictEqual(pub.statusCode, 400);
    assert.strictEqual(pub.body.code, 'unparsed_lines');
    doc.unparsed = [];
    await doc.save();
  });
  await t('publishing is audited', () => {
    assert.ok(global.__audit.some((a) => a.model === 'FuelSheetOutput' && a.action === 'CREATE'));
  });

  // ---------------------------------------------------------------- week-of-use rules
  section('a real week');
  await t('the same vendor sheet for the same day is refused until confirmed', async () => {
    const res = await upload('flying-j-cad-2026-09-09.pdf');
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'duplicate_sheet');
    assert.ok((res.body.existing || []).length >= 1, 'it did not say which sheet it clashed with');
  });
  await t('a re-issued sheet can still be uploaded on purpose', async () => {
    const res = await upload('flying-j-cad-2026-09-09.pdf', { confirm_duplicate: 'true' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    // clean up so later counts stay predictable
    await run(fuel.removeFuelSheet, mkReq({ params: { id: String(res.body.sheet._id) } }));
  });
  await t('an effective date can be supplied at upload time', async () => {
    const res = await upload('avaal-blue-esso-2026-09-04.pdf', { effectiveDate: '2026-09-05', confirm_duplicate: 'true' });
    assert.strictEqual(res.body.sheet.effectiveDate, '2026-09-05');
    await run(fuel.removeFuelSheet, mkReq({ params: { id: String(res.body.sheet._id) } }));
  });
  await t('a malformed effective date is refused', async () => {
    const res = await upload('avaal-blue-esso-2026-09-04.pdf', { effectiveDate: '05/09/2026', confirm_duplicate: 'true' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'effective_date_invalid');
  });
  await t('an undated sheet cannot be published, and says so in the preview', async () => {
    const doc = await FuelPriceSheet.findById(sheets.ta._id);
    const keep = doc.effectiveDate;
    doc.effectiveDate = null;
    await doc.save();
    const prev = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(sheets.ta._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.100' }] },
    }));
    assert.strictEqual(prev.body.canPublish, false);
    assert.ok(prev.body.blockers.some((b) => b.code === 'effective_date_missing'));
    const pub = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(sheets.ta._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.100' }] },
    }));
    assert.strictEqual(pub.body.code, 'effective_date_missing');
    // and it can be fixed without re-uploading
    const set = await run(fuel.setFuelSheetDate, mkReq({ params: { id: String(sheets.ta._id) }, body: { effectiveDate: keep } }));
    assert.strictEqual(set.statusCode, 200);
    assert.strictEqual(set.body.sheet.effectiveDate, keep);
  });
  await t('a backwards effective period is refused', async () => {
    const res = await run(fuel.setFuelSheetDate, mkReq({
      params: { id: String(sheets.ta._id) },
      body: { effectiveDate: '2026-09-09', effectiveTo: '2026-09-01' },
    }));
    assert.strictEqual(res.body.code, 'period_backwards');
  });
  await t("the vendor's confidentiality notice is surfaced, not buried", async () => {
    const res = await run(fuel.fuelSheetDetail, mkReq({ params: { id: String(sheets.ta._id) } }));
    assert.strictEqual(res.body.sheet.confidentialNotice, true);
  });

  section('comparison with the previous sheet');
  let day2;
  await t('a second day of the same vendor is compared with the first', async () => {
    const up = await upload('petro-canada-2026-08-24.xlsx', { sheet: '1' });
    // (the Aug 25 sheet was already uploaded earlier in this suite, so confirm)
    const res = up.statusCode === 409
      ? await upload('petro-canada-2026-08-24.xlsx', { sheet: '1', confirm_duplicate: 'true' })
      : up;
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    day2 = res.body.sheet;
    const prev = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(day2._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }] },
    }));
    assert.ok(prev.body.comparison, 'no comparison was produced');
    assert.strictEqual(prev.body.comparison.against.effectiveDate, '2026-08-24');
    // 337 of the 339 Petro-Canada prices moved between the 24th and the 25th; two
    // industrial sites (MCL CNRL JACKFISH, MCL ALTAGAS REEF) held flat, which is
    // exactly the kind of thing the comparison has to represent rather than round off
    assert.strictEqual(prev.body.comparison.moved, 337);
    assert.strictEqual(prev.body.comparison.unchanged, 2);
    assert.strictEqual(prev.body.comparison.newRows, 0);
    assert.strictEqual(prev.body.comparison.missingRows, 0);
    const flat = prev.body.rows.filter((r) => {
      const m = prev.body.comparison.byRowNo[r.rowNo];
      return m && m.deltaInt === 0;
    }).map((r) => r.text.site_name).sort();
    assert.deepStrictEqual(flat, ['MCL ALTAGAS REEF', 'MCL CNRL JACKFISH']);
  });
  await t('an ordinary daily move is not called unusual', async () => {
    const prev = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(day2._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }] },
    }));
    // Aug 24 -> Aug 25 moved about 3.4%; nothing should trip a 15% threshold
    assert.strictEqual(prev.body.comparison.unusual.length, 0, JSON.stringify(prev.body.comparison.unusual.slice(0, 3)));
  });
  await t('a vendor typo in ONE row is caught', async () => {
    // this is the failure the whole comparison exists for: our arithmetic is right,
    // the vendor's own file is wrong
    const doc = await FuelPriceSheet.findById(day2._id);
    const row = doc.rows.find((r) => r.text.site_name === 'DEER LAKE');
    const original = row.money.get('price_ex_sales_tax').int;
    row.money.set('price_ex_sales_tax', { int: original * 10, dp: 4 });
    doc.markModified('rows');
    await doc.save();
    const prev = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(day2._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }] },
    }));
    const hit = prev.body.comparison.unusual.find((u) => u.rowNo === row.rowNo);
    assert.ok(hit, 'the ten-times price was not flagged');
    assert.ok(hit.pctMicro > 800 * 1e6, `expected a huge percentage, got ${hit.pctMicro / 1e6}`);
    // an unusual move is a warning, not a block — it can be a real market move
    assert.strictEqual(prev.body.canPublish, true);
    row.money.set('price_ex_sales_tax', { int: original, dp: 4 });
    doc.markModified('rows');
    await doc.save();
  });
  await t('the threshold can be tightened', async () => {
    const prev = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(day2._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }], movementThreshold: 1 },
    }));
    assert.ok(prev.body.comparison.unusual.length > 0, 'a 1% threshold caught nothing on a 3% day');
  });
  await t('a same-day re-upload is never used as the comparison base', async () => {
    // Aug 25 exists twice in this suite. Comparing against the copy would report that
    // nothing moved — the most misleading answer available.
    const res = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(day2._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }] },
    }));
    assert.strictEqual(res.body.comparison.against.effectiveDate, '2026-08-24');
    assert.ok(res.body.comparison.moved > 0, 'it compared against an identical sheet');
  });
  await t('the first sheet from a vendor has nothing to compare with', async () => {
    const res = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(sheets.flyingJ._id) },
      body: { profile: String(profile._id) },
    }));
    // flying J was uploaded once and its only sibling was removed above
    assert.strictEqual(res.body.comparison, null);
  });

  section('batch publish');
  await t('one sheet publishes for several customers at once', async () => {
    const c2 = await Customer.create({
      tenantId: TENANT, name: 'Southline Transport', email: 'ap@southline.test',
      phone: '9050002222', address: '5 Main St', city: 'Hamilton', state: 'ON', country: 'Canada', zipcode: 'L8P 1A1',
    });
    const p1 = await run(fuel.addMarginProfile, mkReq({
      body: { name: 'Northbound litre', unit: 'per_litre', customer: String(customer._id), rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0400' }] },
    }));
    const p2 = await run(fuel.addMarginProfile, mkReq({
      body: { name: 'Southline litre', unit: 'per_litre', customer: String(c2._id), rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0700' }] },
    }));
    const res = await run(fuel.publishFuelSheetBatch, mkReq({
      params: { id: String(day2._id) },
      body: { profiles: [String(p1.body.profile._id), String(p2.body.profile._id)], title: 'Diesel Price List' },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.published.length, 2, JSON.stringify(res.body));
    assert.strictEqual(res.body.skipped.length, 0);
    const names = res.body.published.map((x) => x.customer).sort();
    assert.deepStrictEqual(names, ['Northbound Freight', 'Southline Transport']);
    // and each customer got their OWN margin, not a shared one
    const docs = await FuelSheetOutput.find({ tenantId: TENANT, sheet: day2._id, status: 'published' }).lean();
    const byCustomer = {};
    docs.forEach((d) => { byCustomer[String(d.customer)] = d.rows.find((r) => r.text.site_name === 'DEER LAKE').marginInt; });
    assert.strictEqual(byCustomer[String(customer._id)], 40000);
    assert.strictEqual(byCustomer[String(c2._id)], 70000);
  });
  await t('a profile that cannot price the sheet is reported, not silently skipped', async () => {
    const bad = await run(fuel.addMarginProfile, mkReq({
      body: { name: 'Gallon margin', unit: 'per_gallon', rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.100' }] },
    }));
    const res = await run(fuel.publishFuelSheetBatch, mkReq({
      params: { id: String(day2._id) },
      body: { profiles: [String(bad.body.profile._id)] },
    }));
    assert.strictEqual(res.body.published.length, 0);
    assert.strictEqual(res.body.skipped[0].code, 'profile_unit_mismatch');
    assert.ok(res.body.skipped[0].name, 'the skipped profile was not named');
  });
  await t('one bad profile does not stop the good ones', async () => {
    const good = await FuelMarginProfile.findOne({ tenantId: TENANT, name: 'Northbound litre' }).lean();
    const bad = await FuelMarginProfile.findOne({ tenantId: TENANT, name: 'Gallon margin' }).lean();
    const res = await run(fuel.publishFuelSheetBatch, mkReq({
      params: { id: String(day2._id) },
      body: { profiles: [String(bad._id), String(good._id)] },
    }));
    assert.strictEqual(res.body.published.length, 1);
    assert.strictEqual(res.body.skipped.length, 1);
  });
  await t('a batch with no profiles is refused', async () => {
    const res = await run(fuel.publishFuelSheetBatch, mkReq({ params: { id: String(day2._id) }, body: { profiles: [] } }));
    assert.strictEqual(res.body.code, 'no_profiles');
  });
  await t('a batch cannot be run by a driver', async () => {
    const res = await run(fuel.publishFuelSheetBatch, mkReq({ user: driverOnly, params: { id: String(day2._id) }, body: { profiles: [String(profile._id)] } }));
    assert.strictEqual(res.statusCode, 403);
  });
  await t('a batch is refused on a sheet with unreadable lines', async () => {
    const doc = await FuelPriceSheet.findById(day2._id);
    doc.unparsed = [{ text: 'SOMEWHERE 1.00', context: {} }];
    await doc.save();
    const res = await run(fuel.publishFuelSheetBatch, mkReq({ params: { id: String(day2._id) }, body: { profiles: [String(profile._id)] } }));
    assert.strictEqual(res.body.code, 'unparsed_lines');
    doc.unparsed = [];
    await doc.save();
  });

  section('any other sheet');
  let unknown;
  await t('a sheet in a layout the app does not know still uploads', async () => {
    const res = await upload('unknown-vendor-rack.xlsx');
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    unknown = res.body.sheet;
    assert.strictEqual(unknown.vendor, 'generic');
    assert.strictEqual(unknown.stats.rows, 8);
    assert.strictEqual(unknown.mappingRequired, true);
    assert.strictEqual(unknown.generic, true);
    assert.strictEqual(unknown.unit, null);
  });
  await t('it cannot be priced until someone says which column is the price', async () => {
    const res = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(unknown._id) },
      body: { rules: [{ scope: 'global', mode: 'percent', direction: 'add', value: '3' }] },
    }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'mapping_required');
    assert.ok((res.body.columns || []).length >= 6, 'it did not hand back the columns to choose from');
  });
  await t('and it cannot be published either', async () => {
    const res = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(unknown._id) },
      body: { rules: [{ scope: 'global', mode: 'percent', direction: 'add', value: '3' }] },
    }));
    assert.strictEqual(res.body.code, 'mapping_required');
  });
  await t('a text column cannot be chosen as the price', async () => {
    const res = await run(fuel.setFuelSheetMapping, mkReq({
      params: { id: String(unknown._id) },
      body: { baseColumn: 'col1', unit: 'per_litre', currency: 'CAD', dp: 4 },
    }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'base_column_invalid');
  });
  await t('a mapping with no unit is refused', async () => {
    const res = await run(fuel.setFuelSheetMapping, mkReq({
      params: { id: String(unknown._id) },
      body: { baseColumn: 'col4', currency: 'CAD', dp: 4 },
    }));
    assert.strictEqual(res.body.code, 'unit_invalid');
  });
  await t('the total cannot be the same column as the price', async () => {
    const res = await run(fuel.setFuelSheetMapping, mkReq({
      params: { id: String(unknown._id) },
      body: { baseColumn: 'col4', unit: 'per_litre', currency: 'CAD', dp: 4, totalColumn: 'col4' },
    }));
    assert.strictEqual(res.body.code, 'column_role_invalid');
  });
  await t('mapping fills the price range in', async () => {
    const before = await FuelPriceSheet.findById(unknown._id).lean();
    assert.strictEqual(before.stats.priceRange, null);
    await run(fuel.setFuelSheetMapping, mkReq({
      params: { id: String(unknown._id) },
      body: { baseColumn: 'col4', unit: 'per_litre', currency: 'CAD', dp: 4 },
    }));
    const after = await FuelPriceSheet.findById(unknown._id).lean();
    assert.strictEqual(fmtMoney(after.stats.priceRange.minInt, 4), '1.5990');
    assert.strictEqual(fmtMoney(after.stats.priceRange.maxInt, 4), '1.7440');
    // and the rest of the stats survived the write
    assert.strictEqual(after.stats.rows, 8);
  });
  await t('once mapped it behaves exactly like a known vendor sheet', async () => {
    const map = await run(fuel.setFuelSheetMapping, mkReq({
      params: { id: String(unknown._id) },
      body: {
        baseColumn: 'col4', unit: 'per_litre', currency: 'CAD', dp: 4,
        taxColumns: ['col5'], totalColumn: 'col6',
        labels: { col1: 'Terminal', col4: 'Rack price' },
      },
    }));
    assert.strictEqual(map.statusCode, 200, JSON.stringify(map.body));
    assert.strictEqual(map.body.sheet.mappingRequired, false);
    assert.strictEqual(map.body.sheet.unit, 'per_litre');

    const prev = await run(fuel.previewFuelSheet, mkReq({
      params: { id: String(unknown._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }] },
    }));
    assert.strictEqual(prev.statusCode, 200, JSON.stringify(prev.body));
    assert.strictEqual(prev.body.totals.priced, 8);
    assert.strictEqual(prev.body.canPublish, true);
    const sarnia = prev.body.rows.find((r) => r.text.col1 === 'Sarnia');
    assert.strictEqual(fmtMoney(sarnia.baseInt, 4), '1.6421');
    assert.strictEqual(fmtMoney(sarnia.finalInt, 4), '1.6921');
    // the tax column was recomputed on the new price and the total adds up
    assert.strictEqual(sarnia.totalInt, sarnia.finalInt + sarnia.taxes.col5);
  });
  await t('choosing the price column is audited as a sensitive change', () => {
    const entry = global.__audit.filter((a) => a.model === 'FuelPriceSheet' && a.action === 'UPDATE').pop();
    assert.ok(entry, 'no audit entry');
    assert.strictEqual(entry.critical, true);
  });
  await t('a mapped unknown sheet publishes and renders', async () => {
    const res = await run(fuel.publishFuelSheet, mkReq({
      params: { id: String(unknown._id) },
      body: { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }], title: 'Rack Prices' },
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const pdf = await run(fuel.fuelOutputPdf, mkReq({ params: { id: String(res.body.output._id) } }));
    if (pdf.statusCode === 500 && pdf.body?.code === 'chrome_missing') return;
    assert.strictEqual(pdf.statusCode, 200);
    assert.strictEqual(Buffer.from(pdf.raw).subarray(0, 4).toString('latin1'), '%PDF');
  });
  await t('an unknown PDF is read the same way', async () => {
    const res = await upload('unknown-vendor-contract.pdf');
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.sheet.vendor, 'generic');
    assert.strictEqual(res.body.sheet.stats.rows, 7);
    assert.strictEqual(res.body.sheet.effectiveDate, '2026-09-12');
    // the fixture's one malformed value is flagged, which blocks publishing
    assert.strictEqual(res.body.sheet.stats.flagged, 1);
  });

  // ---------------------------------------------------------------- documents
  section('documents');
  await t('the published sheet renders a PDF from its snapshot', async () => {
    const res = await run(fuel.fuelOutputPdf, mkReq({ params: { id: String(output._id) } }));
    if (res.statusCode === 500 && res.body?.code === 'chrome_missing') {
      console.log('       (skipped: no Chrome on this machine)');
      return;
    }
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.raw && res.raw.length > 5000, 'pdf too small');
    assert.ok(Buffer.isBuffer(res.raw), 'pdf should be sent as a Buffer so Content-Length is set');
    assert.strictEqual(Buffer.from(res.raw).subarray(0, 4).toString('latin1'), '%PDF');
    assert.ok(/attachment; filename=/.test(res.headers['content-disposition']));
  });
  await t('the PDF download is audited', () => {
    assert.ok(global.__audit.some((a) => a.model === 'FuelSheetOutput' && a.action === 'DOWNLOAD'));
  });
  await t('the CSV carries a row per location', async () => {
    const res = await run(fuel.fuelOutputCsv, mkReq({ params: { id: String(output._id) } }));
    assert.strictEqual(res.statusCode, 200);
    const lines = String(res.raw).trim().split('\n');
    assert.strictEqual(lines.length, 55); // header + 54
    assert.ok(lines[0].includes('Price'));
  });
  await t('the CSV does not print our cost when the profile says not to', async () => {
    const res = await run(fuel.fuelOutputCsv, mkReq({ params: { id: String(output._id) } }));
    assert.ok(!String(res.raw).split('\n')[0].includes('Vendor'));
  });
  await t('a CSV cell that starts with = is defanged', async () => {
    const doc = await FuelSheetOutput.findById(output._id);
    doc.rows[0].text.name = '=cmd|calc';
    doc.markModified('rows');
    await doc.save();
    const res = await run(fuel.fuelOutputCsv, mkReq({ params: { id: String(output._id) } }));
    assert.ok(String(res.raw).includes("'=cmd|calc"), 'formula not escaped');
  });
  await t('another tenant cannot download the PDF', async () => {
    const res = await run(fuel.fuelOutputPdf, mkReq({ tenantId: OTHER, user: { ...admin, tenantId: OTHER }, params: { id: String(output._id) } }));
    assert.strictEqual(res.statusCode, 404);
  });
  await t('a driver cannot download the CSV', async () => {
    const res = await run(fuel.fuelOutputCsv, mkReq({ user: driverOnly, params: { id: String(output._id) } }));
    assert.strictEqual(res.statusCode, 403);
  });

  // ---------------------------------------------------------------- listings
  section('listings');
  await t('published sheets list newest first with a truncation flag', async () => {
    const res = await run(fuel.listFuelOutputs, mkReq({ query: {} }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.outputs.length >= 2);
    assert.strictEqual(typeof res.body.truncated, 'boolean');
  });
  await t('published sheets can be filtered by customer', async () => {
    const res = await run(fuel.listFuelOutputs, mkReq({ query: { customer: String(customer._id) } }));
    assert.ok(res.body.outputs.length >= 1, 'no sheets for that customer');
    assert.ok(
      res.body.outputs.every((o) => String(o.customer?._id || o.customer) === String(customer._id)),
      'the filter returned another customer\'s sheet',
    );
    const all = await run(fuel.listFuelOutputs, mkReq({ query: {} }));
    assert.ok(all.body.outputs.length > res.body.outputs.length, 'the filter did not narrow anything');
  });
  await t('a malformed customer filter is refused, not passed to the query', async () => {
    const res = await run(fuel.listFuelOutputs, mkReq({ query: { customer: { $ne: null } } }));
    assert.strictEqual(res.statusCode, 400);
  });
  await t('removing a sheet keeps the sheets already published from it', async () => {
    const res = await run(fuel.removeFuelSheet, mkReq({ params: { id: String(sheets.flyingJ._id) } }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(/published price sheet/i.test(res.body.message), res.body.message);
    const still = await FuelSheetOutput.countDocuments({ tenantId: TENANT, sheet: sheets.flyingJ._id });
    assert.strictEqual(still, 2);
    const gone = await run(fuel.fuelSheetDetail, mkReq({ params: { id: String(sheets.flyingJ._id) } }));
    assert.strictEqual(gone.statusCode, 404);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nSUITE THREW:', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  try { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
