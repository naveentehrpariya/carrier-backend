#!/usr/bin/env node
/**
 * End-to-end regression for vendors + payment cheques (+ the global-search
 * phone/digits rule that ships with them).
 *
 * Self-contained: boots its own backend against a THROWAWAY local Mongo
 * database, seeds fixtures, drives the HTTP API, then drops the database and
 * stops the server. Never touches the DB named in backend/.env.
 *
 * Every run picks its OWN database name and a free port, so two runs never
 * collide. Both can be pinned when needed.
 *
 *   node backend/scripts/test-cheques.js
 *   node backend/scripts/test-cheques.js --mongo mongodb://127.0.0.1:27099/x --port 5601
 *
 * Needs: a local mongod, and Chrome for the PDF cases (they are skipped with a
 * warning when launchBrowser reports chrome_missing).
 */
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
// Each run gets its OWN database and port unless told otherwise.
//
// Sharing one fixed name/port meant two runs (a second terminal, a colleague,
// a CI job) silently fought over the same rows: one process's cleanup wiped the
// other's fixtures mid-flight and the server answered "User no longer exists"
// somewhere in the middle. Isolation is cheaper than diagnosing that twice.
const RUN_ID = `${process.pid}${Date.now().toString(36).slice(-4)}`;
const MONGO = arg('--mongo', `mongodb://127.0.0.1:27017/carrier_cheque_test_${RUN_ID}`);
const PORT_ARG = arg('--port', null);
const SECRET = 'cheque-test-secret';
const ROOT = path.join(__dirname, '..');
// Filled in once a free port is found (or taken from --port).
let PORT = PORT_ARG ? Number(PORT_ARG) : 0;
let B = '';

if (/13\.232\.96\.215|mongodb\+srv|logistikore/i.test(MONGO)) {
  console.error('Refusing to run against what looks like a production database:', MONGO);
  process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPdf = (r) => r.status === 200 && Buffer.from(r.data.slice(0, 4)).toString() === '%PDF';

// Refuse to run when the port is already taken.
//
// bootServer polls `GET /` and cannot tell OUR server from a leftover one, so
// without this check a crashed previous run leaves a server holding 5599, the
// new spawn fails to bind, the poll succeeds against the STALE process, and the
// suite silently tests old code against a database two runs are both writing —
// which is exactly how this suite started failing in a different place each run.
function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

// Ask the OS for a free port. bootServer polls `GET /` and cannot tell OUR
// server from a leftover one, so binding to a port someone else holds would
// silently test the wrong process.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function bootServer() {
  if (PORT) {
    if (await portInUse(PORT)) {
      console.error(`Port ${PORT} is already in use — free it (lsof -ti:${PORT} | xargs kill) or drop --port to auto-pick.`);
      process.exit(2);
    }
  } else {
    PORT = await freePort();
  }
  B = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_URL_OFFICE: MONGO,
      MONGODB_URI: MONGO,
      SECRET_ACCESS: SECRET,
      PORT: String(PORT),
      NODE_ENV: 'test',
      // A timezone west of UTC — the cheque-date bug only shows there.
      TZ: 'America/Toronto',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; process.stderr.write('SERVER STDERR: ' + d); });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await axios.get(`${B}/`, { timeout: 1000 });
      if (r.status === 200) return child;
    } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) break;
  }
  console.error('Server did not come up:\n', log.slice(-2000));
  process.exit(2);
}

// Assigned inside the try below; the teardown must cope with either being unset
// (a fixture can fail before the server is even spawned).
let server = null;
let cleanDb = async () => {};

// A crash used to skip teardown entirely, leaving a server on the port and a
// half-seeded database for the next run to trip over.
// Wait for the spawned backend to actually exit before touching the database.
//
// `kill()` only signals. The server keeps its own Mongo connection and writes
// asynchronously (audit entries, the FX cron), so dropping the database while
// it is still alive lets it RE-CREATE the database a moment later — which is
// why throwaway test databases kept surviving a clean run.
function stopServer(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } done(); }, timeoutMs);
    child.once('exit', done);
    try { child.kill(); } catch (e) { done(); }
  });
}

async function teardown() {
  await stopServer(server);
  try { await cleanDb(); } catch (e) { console.error('WARN teardown cleanup failed:', e.message); }
  try { await mongoose.disconnect(); } catch (e) { /* best effort */ }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await teardown(); process.exit(130); });
}

(async () => {
  await mongoose.connect(MONGO);
  // We own this database name (it carries the run id) unless the caller passed
  // --mongo, so the whole thing goes at the end rather than row by row.
  const ownsDatabase = !argv.includes('--mongo');
  cleanDb = async () => {
    if (ownsDatabase) {
      await mongoose.connection.dropDatabase();
      return;
    }
    // A caller-supplied database may hold other things — only clear rows.
    const colls = await mongoose.connection.db.collections();
    for (const c of colls) { await c.deleteMany({}); }
  };
  await cleanDb();

  try {
  const Tenant = require('../db/Tenant');
  const Users = require('../db/Users');
  const Carrier = require('../db/Carrier');
  const Customer = require('../db/Customer');
  const OwnerOperator = require('../db/OwnerOperator');
  const Company = require('../db/Company');
  const PaymentCheque = require('../db/PaymentCheque');
  const ActivityLog = require('../db/ActivityLog');

  const mkUser = (o) => Users.create({
    tenantId: 't1', password: 'x12345678', phone: '000', country: 'CA', address: '1 St', status: 'active', ...o,
  });

  const co = await Company.create({ tenantId: 't1', name: 'Test Co Inc', email: 'c@t.co', phone: '000', address: '1 Co St' });
  await Tenant.create({ tenantId: 't1', name: 'T1', domain: 't1.example.com', status: 'active', contactInfo: { adminName: 'A', adminEmail: 'admin@t.co' } });
  const admin = await mkUser({ name: 'Admin', email: 'admin@t.co', corporateID: 'AD1', is_admin: 1, company: co._id, permissions: ['accounting'] });
  const staff = await mkUser({ name: 'Plain Staff', email: 'staff@t.co', corporateID: 'ST1', is_admin: 0, company: co._id, permissions: ['regular'] });
  const driver = await mkUser({ name: 'Drv One', email: 'drv@t.co', corporateID: 'DR1', company: co._id, permissions: ['driver'] });
  const goneDrv = await mkUser({ name: 'Gone Drv', email: 'gone@t.co', corporateID: 'DR2', company: co._id, permissions: ['driver'], status: 'inactive' });
  await mkUser({ name: 'Deleted Drv', email: 'del@t.co', corporateID: 'DR3', company: co._id, permissions: ['driver'], status: 'inactive', deletedAt: new Date() });
  const carrier = await Carrier.create({
    tenantId: 't1', company: co._id, name: '40 WEST YARD INC.', mc_code: 'MC1', phone: '(416) 555-1212', email: 'yard@t.co',
    country: 'Canada', state: 'ON', city: 'Brampton', zipcode: 'L6T 3T6', location: '40 West Drive', carrierID: 'CR_ID1',
  });
  await Customer.create({
    tenantId: 't1', company: co._id, name: 'Bay Area Logistics', email: 'cust@t.co', phone: '(416) 555-9090',
    address: '1234 Main St', country: 'Canada', state: 'ON', city: 'Toronto', zipcode: 'M5V 2T6',
  });
  const oo = await OwnerOperator.create({
    tenantId: 't1', company: co._id, ownerOperatorId: 'OO1', fullName: 'Owner Op', phone: '666', email: 'oo@t.co',
    address: '5 Owner Way', state: 'MB', city: 'Winnipeg', zipcode: 'R2Y', status: 'active',
  });
  await Tenant.create({ tenantId: 't2', name: 'T2', domain: 't2.example.com', status: 'active', contactInfo: { adminName: 'B', adminEmail: 'admin2@t.co' } });
  const admin2 = await Users.create({
    tenantId: 't2', name: 'Admin2', email: 'admin2@t.co', corporateID: 'AD2', password: 'x12345678', phone: '1', country: 'CA', address: '1 St', is_admin: 1, status: 'active',
  });

  // Payroll + order fixtures for cheque application.
  const DriverSalary = require('../db/DriverSalary');
  const OwnerOperatorSalary = require('../db/OwnerOperatorSalary');
  const OrderModel = require('../db/Order');
  const payslip = await DriverSalary.create({
    tenantId: 't1', driver: driver._id, month: 7, year: 2026,
    currency: 'CAD', rateCurrency: 'CAD',
    basePayable: 1000, finalPayable: 1000, paidAmount: 0, dueAmount: 1000, paymentStatus: 'pending',
  });
  const ownerSlip = await OwnerOperatorSalary.create({
    tenantId: 't1', ownerOperator: oo._id, month: 7, year: 2026,
    currency: 'CAD', basePayable: 2000, finalPayable: 2000, paidAmount: 0, dueAmount: 2000, paymentStatus: 'pending',
  });
  const order = await OrderModel.create({
    tenantId: 't1', company: co._id, serial_no: 9001, order_type: 'outsourcing', company_name: 'Test Co Inc',
    customer: (await Customer.findOne({ tenantId: 't1' }))._id,
    carrier: carrier._id, carrier_amount: 900, total_amount: 1200,
    revenue_currency: 'usd', created_by: admin._id,
  }).catch((e) => { console.log('WARN order fixture failed:', e.message); return null; });

  const http = require('http');
  server = await bootServer();
  const api = (u) => axios.create({
    baseURL: B,
    httpAgent: new http.Agent({ keepAlive: false }),
    headers: { Authorization: `Bearer ${jwt.sign({ id: u._id }, SECRET, { expiresIn: '1h' })}` },
    validateStatus: () => true,
  });
  const A = api(admin); const S = api(staff); const A2 = api(admin2);

    // ---------------------------------------------------------------- vendors
    let r = await A.post('/vendors/add', { name: 'Acme Fuel', phone: '999', emails: [{ email: 'DISPATCH@acme.com', is_primary: true }, { email: 'ap@acme.com' }], address: '77 Fuel St', city: 'Calgary', state: 'AB', country: 'Canada', zipcode: 'T2P', notes: 'net 30 terms' });
    const vendor = r.data.vendor;
    ok('vendor add gets V1000', r.data.status === true && vendor?.code === 'V1000', JSON.stringify(r.data));
    ok('vendor stores multiple emails, lowercased', vendor?.emails?.length === 2 && vendor.emails[0].email === 'dispatch@acme.com');
    ok('primary email mirrored to legacy field', vendor?.email === 'dispatch@acme.com');
    r = await A.post('/vendors/add', { name: 'Second Vendor' });
    ok('vendor code increments', r.data?.vendor?.code === 'V1001');
    r = await S.post('/vendors/add', { name: 'Hacker Vendor' });
    ok('staff blocked from vendors (403)', r.status === 403);
    r = await A.get('/vendors/listings?search=acme');
    ok('vendor search by name', r.data.vendors?.length === 1);
    r = await A.get('/vendors/listings?search=net 30');
    ok('vendor search by notes', r.data.vendors?.length === 1);
    r = await A.post(`/vendors/update/${vendor._id}`, { phone: '1000', code: 'HACK', emails: [{ email: 'only@acme.com', is_primary: true }] });
    ok('vendor update; code immutable; emails editable', r.data.vendor?.phone === '1000' && r.data.vendor.code === 'V1000' && r.data.vendor.email === 'only@acme.com');

    // ---------------------------------------------------------------- payees
    for (const [type, expect] of [['vendor', 'Acme Fuel'], ['carrier', '40 WEST YARD INC.'], ['customer', 'Bay Area Logistics'], ['driver', 'Drv One'], ['truck_owner', 'Owner Op'], ['employee', 'Admin']]) {
      r = await A.get(`/cheques/payees?type=${type}`);
      ok(`payees ${type}`, r.data.status === true && (r.data.payees || []).some((p) => p.name === expect));
    }
    r = await A.get('/cheques/payees?type=driver');
    const names = (r.data.payees || []).map((p) => p.name);
    ok('inactive driver is payable (final settlement)', names.includes('Gone Drv'));
    ok('inactive driver flagged', r.data.payees.find((p) => p.name === 'Gone Drv')?.inactive === true);
    ok('active driver not flagged', r.data.payees.find((p) => p.name === 'Drv One')?.inactive === false);
    ok('soft-deleted driver excluded', !names.includes('Deleted Drv'));
    r = await A.get('/cheques/payees?type=employee');
    ok('drivers not in employee payees', !(r.data.payees || []).some((p) => /Drv/.test(p.name)));
    r = await A.get('/cheques/payees?type=bogus');
    ok('bogus payee type 400', r.status === 400);

    // ---------------------------------------------------------------- create
    const add = (body) => A.post('/cheques/add', { payeeType: 'carrier', payeeId: carrier._id, currency: 'CAD', amount: 100, ...body });
    r = await add({ amount: 2520, referenceNo: 'REF-1', paymentDate: '2026-08-28', note: 'Advance July' });
    const cheque = r.data.cheque;
    ok('cheque add, auto #1001', r.data.status === true && cheque.chequeNo === '1001', JSON.stringify(r.data));
    ok('amount in words snapshot', cheque.amountInWords === 'Two Thousand Five Hundred Twenty and 00/100');
    ok('payee name + address snapshot', cheque.payeeName === '40 WEST YARD INC.' && /40 West Drive/.test(cheque.payeeAddress));
    r = await add({ amount: -5 });
    ok('negative amount 400', r.status === 400);
    r = await add({ amount: 0 });
    ok('zero amount 400', r.status === 400);
    r = await add({ chequeNo: '1001' });
    ok('typed duplicate chequeNo 409', r.status === 409 && r.data.code === 'cheque_no_taken');
    r = await add({ payeeType: 'vendor', payeeId: staff._id });
    ok('payee not found 404', r.status === 404);
    r = await S.post('/cheques/add', { payeeType: 'carrier', payeeId: carrier._id, amount: 10 });
    ok('staff blocked from cheques', r.status === 403);
    r = await add({ chequeNo: '1002' });
    ok('manual 1002 accepted', r.data.cheque?.chequeNo === '1002');
    r = await add({});
    ok('auto-number skips a manually used number -> 1003', r.data.cheque?.chequeNo === '1003', r.data.cheque?.chequeNo);
    r = await A.post('/cheques/add', { payeeType: 'driver', payeeId: goneDrv._id, currency: 'CAD', amount: 500 });
    ok('final settlement to inactive driver saves', r.data.status === true);

    // duplicate reference: warn, then allow
    r = await add({ referenceNo: 'INV-77' });
    ok('first cheque with a reference', r.data.status === true);
    r = await add({ referenceNo: 'INV-77' });
    ok('duplicate reference 409 with existing list', r.status === 409 && r.data.code === 'duplicate_reference' && r.data.existing?.length === 1);
    r = await add({ referenceNo: 'INV-77', confirm_duplicate: true });
    ok('confirmed duplicate saves (split payment)', r.data.status === true);
    const voidRef = (await add({ referenceNo: 'INV-VOID' })).data.cheque;
    await A.post(`/cheques/void/${voidRef._id}`, { reason: 'wrong amount' });
    r = await add({ referenceNo: 'INV-VOID' });
    ok('voided cheque does not trigger the duplicate warning', r.data.status === true);

    // period validation
    r = await add({ periodFrom: '2026-08-31', periodTo: '2026-08-01' });
    ok('backwards period 400', r.status === 400 && r.data.code === 'period_backwards');
    r = await add({ periodFrom: '2026-08-01', periodTo: '2026-08-31' });
    const periodCheque = r.data.cheque;
    ok('valid period saves', r.data.status === true);
    r = await A.post(`/cheques/update/${periodCheque._id}`, { periodTo: '2026-07-01' });
    ok('backwards period on update 400', r.status === 400 && r.data.code === 'period_backwards');

    // ---------------------------------------------------------------- listing
    r = await A.get('/cheques/listings');
    ok('listing carries limit + truncated', typeof r.data.limit === 'number' && r.data.truncated === false);
    ok('totals exclude void', r.data.totals.CAD === Math.round(r.data.cheques.filter((c) => c.status !== 'void').reduce((s, c) => s + c.amount, 0) * 100) / 100);
    r = await A.get('/cheques/listings?payeeType=driver');
    ok('filter payeeType', r.data.cheques?.length === 1 && r.data.cheques[0].payeeName === 'Gone Drv');
    r = await A.get('/cheques/listings?month=8&year=2026');
    ok('month filter', r.data.cheques?.some((c) => c.chequeNo === '1001'));
    r = await A.get('/cheques/listings?search=REF-1');
    ok('search by reference', r.data.cheques?.length === 1 && r.data.cheques[0].chequeNo === '1001');
    r = await A.get('/cheques/counts?payeeType=carrier');
    const carrierCount = r.data.counts?.[String(carrier._id)];
    ok('counts per payee', carrierCount >= 5, JSON.stringify(r.data.counts));
    ok('void excluded from counts', carrierCount === (await A.get('/cheques/listings?payeeType=carrier')).data.cheques.filter((c) => c.status !== 'void').length);
    r = await S.get('/cheques/counts?payeeType=carrier');
    ok('counts for staff = {} not 403', r.status === 200 && Object.keys(r.data.counts || {}).length === 0);

    // ---------------------------------------------------------------- edit / preview / print / void
    r = await A.post(`/cheques/update/${cheque._id}`, { amount: 3000 });
    ok('update issued cheque re-snapshots words', r.data.cheque?.amount === 3000 && r.data.cheque.amountInWords === 'Three Thousand and 00/100');

    let pdfSkipped = false;
    r = await A.get(`/cheques/${cheque._id}/pdf?preview=true`, { responseType: 'arraybuffer' });
    if (r.status === 500 && /chrome_missing/.test(Buffer.from(r.data).toString())) {
      pdfSkipped = true;
      console.log('WARN  PDF cases skipped: Chrome not available');
    } else {
      ok('preview renders pdf', isPdf(r));
      let doc = await PaymentCheque.findById(cheque._id).lean();
      ok('preview leaves status issued', doc.status === 'issued');
      r = await A.post(`/cheques/update/${cheque._id}`, { amount: 3100 });
      ok('still editable after preview', r.data.status === true);

      r = await A.get(`/cheques/${cheque._id}/pdf`, { responseType: 'arraybuffer' });
      ok('print renders pdf', isPdf(r));
      doc = await PaymentCheque.findById(cheque._id).lean();
      ok('print marks printed', doc.status === 'printed');
      // The server runs in America/Toronto; the register date and the printed date must agree.
      const { buildChequeHtml } = require('../utils/chequeHtml');
      ok('printed date equals register date (UTC, not local)', buildChequeHtml(doc).includes('08/28/26'));
    }
    r = await A.post(`/cheques/update/${cheque._id}`, { amount: 1 });
    ok(pdfSkipped ? 'update still allowed when never printed' : 'printed cheque not editable 409', pdfSkipped ? r.data.status === true : (r.status === 409 && r.data.code === 'cheque_not_editable'));

    r = await A.post(`/cheques/void/${cheque._id}`, {});
    ok('void without reason 400', r.status === 400);
    r = await A.post(`/cheques/void/${cheque._id}`, { reason: 'typo in amount' });
    ok('void ok', r.data.status === true && r.data.cheque.status === 'void');
    r = await A.post(`/cheques/void/${cheque._id}`, { reason: 'again' });
    ok('double void 409', r.status === 409);
    if (!pdfSkipped) {
      r = await A.get(`/cheques/${cheque._id}/pdf`, { responseType: 'arraybuffer' });
      ok('void cheque still printable (watermarked)', isPdf(r));
    }

    // ---------------------------------------------------------------- batch
    const b1 = (await add({ amount: 700 })).data.cheque;
    const b2 = (await add({ amount: 800 })).data.cheque;
    if (!pdfSkipped) {
      r = await A.post('/cheques/print-batch', { ids: [b1._id, b2._id], preview: true }, { responseType: 'arraybuffer' });
      ok('batch preview pdf', isPdf(r));
      let st = await PaymentCheque.find({ _id: { $in: [b1._id, b2._id] } }).lean();
      ok('batch preview leaves both issued', st.every((c) => c.status === 'issued'));
      r = await A.post('/cheques/print-batch', { ids: [b1._id, b2._id] }, { responseType: 'arraybuffer' });
      ok('batch print pdf', isPdf(r));
      st = await PaymentCheque.find({ _id: { $in: [b1._id, b2._id] } }).lean();
      ok('batch print marks both printed', st.every((c) => c.status === 'printed'));
    }
    r = await A.post('/cheques/print-batch', { ids: [] });
    ok('empty batch 400', r.status === 400);
    r = await A.post('/cheques/print-batch', { ids: Array.from({ length: 101 }, () => String(b1._id)) });
    ok('oversized batch 400', r.status === 400);
    r = await S.post('/cheques/print-batch', { ids: [b1._id] });
    ok('staff blocked from batch', r.status === 403);

    // ---------------------------------------------------------------- vendor delete keeps history
    r = await A.get(`/vendors/remove/${vendor._id}`);
    ok('vendor delete', r.data.status === true);
    r = await A.get('/cheques/payees?type=vendor');
    ok('deleted vendor gone from payees', !(r.data.payees || []).some((p) => p.name === 'Acme Fuel'));

    // ---------------------------------------------------------------- tenant isolation
    r = await A2.get('/cheques/listings');
    ok('tenant isolation on listings', r.data.cheques?.length === 0);
    r = await A2.get(`/cheques/${b1._id}/pdf`);
    ok('cross-tenant pdf 404', r.status === 404);
    r = await A2.post(`/cheques/void/${b1._id}`, { reason: 'x' });
    ok('cross-tenant void 404', r.status === 404);
    r = await A2.post('/cheques/print-batch', { ids: [b1._id] });
    ok('cross-tenant batch 404', r.status === 404);

    // ---------------------------------------------------------------- bank accounts + per-account numbering
    r = await A.post('/bank-accounts/add', { name: 'RBC Operating', bankName: 'RBC', accountNo: '000114471', chequeStart: 5001 });
    const acctA = r.data.account;
    ok('bank account add', r.data.status === true && acctA.chequeStart === 5001 && /••4471/.test(acctA.label), JSON.stringify(r.data));
    r = await A.post('/bank-accounts/add', { name: 'TD Payroll', bankName: 'TD', accountNo: '888', chequeStart: 5001 });
    const acctB = r.data.account;
    ok('second account add', r.data.status === true);
    r = await S.post('/bank-accounts/add', { name: 'Hax' });
    ok('staff blocked from accounts', r.status === 403);

    r = await add({ bankAccount: acctA._id, amount: 111 });
    ok('account numbering starts at its own book (5001)', r.data.cheque?.chequeNo === '5001', JSON.stringify(r.data));
    ok('fromAccount snapshot from account label', /RBC Operating/.test(r.data.cheque?.fromAccount || ''), r.data.cheque?.fromAccount);
    r = await add({ bankAccount: acctB._id, amount: 112 });
    ok('SAME number allowed on a different account', r.data.cheque?.chequeNo === '5001');
    r = await add({ bankAccount: acctA._id, chequeNo: '5001', amount: 5 });
    ok('typed duplicate within one account still 409', r.status === 409);
    r = await add({ bankAccount: acctA._id, chequeNo: '5010', amount: 5 });
    ok('typed jump ahead accepted', r.data.status === true);
    r = await add({ bankAccount: acctA._id, amount: 5 });
    ok('auto continues after typed number (5002)', r.data.cheque?.chequeNo === '5002', r.data.cheque?.chequeNo);
    r = await A.post(`/bank-accounts/update/${acctA._id}`, { chequeStart: 6000 });
    ok('account next-number editable', r.data.status === true);
    r = await add({ bankAccount: acctA._id, amount: 5 });
    ok('counter respects the raised book number', Number(r.data.cheque?.chequeNo) >= 6000, r.data.cheque?.chequeNo);

    // ---------------------------------------------------------------- cleared / bounced lifecycle
    const life = (await add({ amount: 333, referenceNo: 'LIFE-1' })).data.cheque;
    r = await A.post(`/cheques/clear/${life._id}`, {});
    ok('cannot clear an issued cheque', r.status === 409 && r.data.code === 'not_printed');
    if (!pdfSkipped) await A.get(`/cheques/${life._id}/pdf`, { responseType: 'arraybuffer' });
    else await PaymentCheque.updateOne({ _id: life._id }, { $set: { status: 'printed' } });
    r = await A.post(`/cheques/clear/${life._id}`, { date: '2026-09-01' });
    ok('printed cheque clears', r.data.status === true && r.data.cheque.status === 'cleared');
    r = await A.post(`/cheques/update/${life._id}`, { amount: 1 });
    ok('cleared cheque not editable', r.status === 409);
    r = await A.post(`/cheques/void/${life._id}`, { reason: 'x' });
    ok('cleared cheque cannot be voided', r.status === 409 && r.data.code === 'cheque_settled');
    r = await A.post(`/cheques/bounce/${life._id}`, {});
    ok('bounce needs a reason', r.status === 400);
    r = await A.post(`/cheques/bounce/${life._id}`, { reason: 'NSF' });
    ok('cleared cheque can still bounce (bank reversal)', r.data.status === true && r.data.cheque.status === 'bounced');
    r = await A.get('/cheques/listings?status=bounced');
    ok('bounced filter works', r.data.cheques?.some((c) => String(c._id) === String(life._id)));
    r = await A.get('/cheques/listings');
    ok('bounced excluded from totals', !Object.values(r.data.totals).some((v) => v < 0) && r.data.cheques.find((c) => String(c._id) === String(life._id))?.status === 'bounced'
      && Math.abs(Object.values(r.data.totals).reduce((a, b) => a + b, 0)
        - Math.round(r.data.cheques.filter((c) => !['void', 'bounced'].includes(c.status)).reduce((s2, c) => s2 + c.amount, 0) * 100) / 100) < 0.01);
    r = await add({ referenceNo: 'LIFE-1' });
    ok('re-issue after bounce does not warn duplicate', r.data.status === true);

    // ---------------------------------------------------------------- applications: carrier -> order
    if (order) {
      const carCheque = (await add({ amount: 900 })).data.cheque;
      r = await A.get(`/cheques/${carCheque._id}/apply-targets`);
      ok('carrier targets list the order', r.data.targets?.some((t) => String(t.targetId) === String(order._id)), JSON.stringify(r.data.targets?.length));

      // A cheque is money leaving the building — it must only be applicable to work THIS carrier
      // moved. Both the carrier filter and the soft-delete filter are `$or`s, and putting them in
      // one object literal silently drops the first: every order in the tenant then came back as a
      // payable target, and a cheque could be applied against an order the carrier never touched.
      {
        const otherCarrier = await Carrier.create({
          tenantId: 't1', name: 'Someone Else Freight', mc_code: 'ZZ9', phone: '5', email: 'z@z.test',
          address: 'z', city: 'z', state: 'z', country: 'z', zipcode: 'z', location: 'Z City, ZZ',
        });
        const foreignOrder = await OrderModel.create({
          tenantId: 't1', customer: order.customer, company_name: 'X', serial_no: 999123,
          order_type: 'outsourcing', carrier: otherCarrier._id, carrier_amount: 500,
          total_amount: 700, revenue_currency: 'usd', created_by: admin._id,
        });
        const t2 = await A.get(`/cheques/${carCheque._id}/apply-targets`);
        ok('another carrier\'s order is NOT a target',
          !t2.data.targets?.some((x) => String(x.targetId) === String(foreignOrder._id)),
          JSON.stringify(t2.data.targets?.map((x) => x.label)));

        const stray = (await add({ amount: 100 })).data.cheque;
        const t3 = await A.post(`/cheques/${stray._id}/apply`, { targetId: foreignOrder._id, amount: 100 });
        ok('applying a cheque to another carrier\'s order is refused', t3.status === 404, JSON.stringify(t3.data));
        const untouched = await OrderModel.findById(foreignOrder._id).lean();
        ok('that order keeps its pending payment state',
          String(untouched.carrier_payment_status || 'pending') === 'pending'
          && !untouched.carrier_payment_method);
      }
      r = await A.post(`/cheques/${carCheque._id}/apply`, { targetId: order._id, amount: 900 });
      ok('apply to order succeeds', r.data.status === true && r.data.unapplied === 0, JSON.stringify(r.data));
      const paidOrder = await OrderModel.findById(order._id).lean();
      ok('order carrier payment marked paid by cheque', paidOrder.carrier_payment_status === 'paid' && paidOrder.carrier_payment_method === 'cheque');
      r = await A.post(`/cheques/${carCheque._id}/apply`, { targetId: order._id, amount: 1 });
      ok('over-unapplied refused', r.status === 400 && r.data.code === 'over_unapplied');
      r = await A.get(`/cheques/${carCheque._id}/applications`);
      const appRow = r.data.applications?.[0];
      ok('applications listed', r.data.applications?.length === 1 && r.data.applied === 900);
      r = await A.get('/cheques/listings?search=' + carCheque.chequeNo);
      ok('listing carries applied/unapplied', r.data.cheques?.[0]?.appliedAmount === 900 && r.data.cheques?.[0]?.unappliedAmount === 0);
      r = await A.post(`/cheques/applications/remove/${appRow._id}`);
      ok('remove application', r.data.status === true);
      const revertedOrder = await OrderModel.findById(order._id).lean();
      ok('order carrier payment reverted to pending', revertedOrder.carrier_payment_status === 'pending');
    } else {
      console.log('WARN order-application cases skipped (order fixture failed)');
    }

    // ---------------------------------------------------------------- applications: driver payslip
    const drvCheque = (await A.post('/cheques/add', { payeeType: 'driver', payeeId: driver._id, currency: 'CAD', amount: 600 })).data.cheque;
    r = await A.get(`/cheques/${drvCheque._id}/apply-targets`);
    ok('driver targets list the payslip', r.data.targets?.some((t) => String(t.targetId) === String(payslip._id)));
    r = await A.post(`/cheques/${drvCheque._id}/apply`, { targetId: payslip._id, amount: 600 });
    ok('apply to driver payslip', r.data.status === true, JSON.stringify(r.data));
    let slip = await DriverSalary.findById(payslip._id).lean();
    ok('payslip paidAmount moved by the cheque', Math.abs(slip.paidAmount - 600) < 0.01 && Math.abs(slip.dueAmount - 400) < 0.01, JSON.stringify({ paid: slip.paidAmount, due: slip.dueAmount }));
    const DriverPayment = require('../db/DriverPayment');
    const dp = await DriverPayment.findOne({ tenantId: 't1', salary: payslip._id }).lean();
    ok('a real DriverPayment row exists with the cheque reference', dp && /Cheque #/.test(dp.notes) && dp.method === 'cheque');
    r = await A.post(`/cheques/${drvCheque._id}/apply`, { targetId: payslip._id, amount: 600 });
    ok('second apply blocked by unapplied balance', r.status === 400 && r.data.code === 'over_unapplied');
    r = await A.get(`/cheques/${drvCheque._id}/applications`);
    const drvApp = r.data.applications?.[0];
    r = await A.post(`/cheques/applications/remove/${drvApp._id}`);
    ok('driver application removal reverses the payment', r.data.status === true);
    slip = await DriverSalary.findById(payslip._id).lean();
    ok('payslip back to unpaid', Math.abs(slip.paidAmount) < 0.01 && Math.abs(slip.dueAmount - 1000) < 0.01, JSON.stringify({ paid: slip.paidAmount }));

    // ---------------------------------------------------------------- applications: owner statement
    const ooCheque = (await A.post('/cheques/add', { payeeType: 'truck_owner', payeeId: oo._id, currency: 'CAD', amount: 2500 })).data.cheque;
    r = await A.post(`/cheques/${ooCheque._id}/apply`, { targetId: ownerSlip._id, amount: 2500 });
    ok('overpay refused with 409 from payroll core', r.status === 409 && r.data.code === 'overpayment', r.status);
    r = await A.post(`/cheques/${ooCheque._id}/apply`, { targetId: ownerSlip._id, amount: 2000 });
    ok('apply to owner statement', r.data.status === true, JSON.stringify(r.data));
    const oSlip = await OwnerOperatorSalary.findById(ownerSlip._id).lean();
    ok('owner statement paid by the cheque', Math.abs(oSlip.paidAmount - 2000) < 0.01 && oSlip.paymentStatus === 'paid', JSON.stringify({ paid: oSlip.paidAmount, st: oSlip.paymentStatus }));
    r = await A.get(`/cheques/${ooCheque._id}/applications`);
    ok('owner cheque shows 500 unapplied', r.data.unapplied === 500, r.data.unapplied);
    // bounce with applications outstanding -> loud warning
    if (!pdfSkipped) await A.get(`/cheques/${ooCheque._id}/pdf`, { responseType: 'arraybuffer' });
    else await PaymentCheque.updateOne({ _id: ooCheque._id }, { $set: { status: 'printed' } });
    r = await A.post(`/cheques/bounce/${ooCheque._id}`, { reason: 'stopped payment' });
    ok('bounce reports outstanding applications', r.data.status === true && r.data.applicationsRemain === 1, JSON.stringify(r.data.applicationsRemain));
    r = await A.post(`/cheques/${ooCheque._id}/apply`, { targetId: ownerSlip._id, amount: 100 });
    ok('bounced cheque cannot be applied further', r.status === 409 && r.data.code === 'cheque_not_applicable');
    // vendor cheque has no targets but stays trackable
    const vnd = await A.post('/vendors/add', { name: 'Apply Vendor' });
    const vCheque = (await A.post('/cheques/add', { payeeType: 'vendor', payeeId: vnd.data.vendor._id, currency: 'CAD', amount: 50 })).data.cheque;
    r = await A.get(`/cheques/${vCheque._id}/apply-targets`);
    ok('vendor cheque has no apply targets', r.data.targetType === null && r.data.targets.length === 0);
    r = await A.post(`/cheques/${vCheque._id}/apply`, { targetId: vnd.data.vendor._id, amount: 10 });
    ok('vendor apply refused with clear message', r.status === 400 && r.data.code === 'no_apply_targets');

    // ---------------------------------------------------------------- pre-printed stock geometry
    //
    // These are the safety-critical ones. A field printed inside the MICR strip
    // makes the cheque unreadable to the bank, and cheque stock is numbered —
    // every rejected sheet is a void cheque.
    {
      const { CPA, DEFAULT_PREPRINTED_LAYOUT, buildPreprintedSheetsHtml, buildAlignmentSheetHtml } = require('../utils/chequeHtml');
      const lineIn = (pt) => pt * 1.25 / 72;
      const topOf = (f, bandH) => {
        const ac = bandH - (CPA.amountLowerFromBottomIn + CPA.amountUpperFromBottomIn) / 2;
        if (f.top !== undefined) return f.top;
        if (f.bottomCentre !== undefined) return bandH - f.bottomCentre - lineIn(f.size) / 2;
        if (f.belowAmount !== undefined) return ac + lineIn(f.size) / 2 + f.belowAmount;
        if (f.aboveMicr !== undefined) return bandH - CPA.micrBandIn - f.aboveMicr - lineIn(f.size);
        return 0;
      };

      for (const bandH of [2.75, 3.0, 3.5, 3.75]) {
        const micrTop = bandH - CPA.micrBandIn;
        let worst = null;
        for (const [name, f] of Object.entries(DEFAULT_PREPRINTED_LAYOUT)) {
          const bottom = topOf(f, bandH) + lineIn(f.size) * (f.lineHeight || 1.25);
          if (bottom > micrTop && (!worst || bottom > worst.bottom)) worst = { name, bottom };
        }
        ok(`no field enters the MICR band on a ${bandH}" cheque`, !worst,
          worst && `${worst.name} reaches ${worst.bottom.toFixed(3)}" vs MICR at ${micrTop.toFixed(3)}"`);
        // Every field must also sit inside the band at all.
        const outside = Object.entries(DEFAULT_PREPRINTED_LAYOUT)
          .filter(([, f]) => topOf(f, bandH) < 0 || topOf(f, bandH) > bandH);
        ok(`every field stays inside a ${bandH}" cheque band`, outside.length === 0, JSON.stringify(outside.map(([n]) => n)));
      }

      // The amount in figures must land inside the scan area the bank reads.
      const bandH = 3.5;
      const aTop = topOf(DEFAULT_PREPRINTED_LAYOUT.amountFigures, bandH);
      const scanTop = bandH - CPA.amountUpperFromBottomIn;
      const scanBottom = bandH - CPA.amountLowerFromBottomIn;
      ok('amount in figures sits inside the CPA scan area',
        aTop >= scanTop && aTop + lineIn(12) <= scanBottom,
        `${aTop.toFixed(3)} vs ${scanTop.toFixed(3)}..${scanBottom.toFixed(3)}`);
      // ...and the words line must stop one clear area short of it.
      ok('amount in words clears the scan area',
        CPA.amountScanWidthIn + CPA.clearAreaIn >= CPA.amountScanWidthIn + 0.25);

      // The rendered document must not name the bank or draw its marks.
      const spec = { printMode: 'preprinted', chequePosition: 'top', chequeHeightIn: 3.5, bandTopIn: 0,
                     offsetXmm: 0, offsetYmm: 0, printChequeNumber: false, label: 'RBC Operating' };
      const sample = { _id: 'x', paymentDate: new Date('2026-08-28T00:00:00Z'), amount: 2520, currency: 'CAD',
                       amountInWords: 'Two Thousand Five Hundred Twenty and 00/100', chequeNo: '0887',
                       payeeName: '40 WEST YARD INC.', payeeAddress: '40 West Drive\nBrampton ON L6T 3T6',
                       note: 'Fuel advance', status: 'issued' };
      const pre = buildPreprintedSheetsHtml([{ cheque: sample, spec, applications: [] }]);
      ok('pre-printed sheet prints the payee', pre.includes('40 WEST YARD INC.'));
      ok('pre-printed sheet does NOT print the cheque number by default', !/>0887</.test(pre.split('stub')[0]));
      ok('pre-printed sheet draws no MICR line, bank name or signature line',
        !/MICR|routing|transit|Signature|PAY TO THE ORDER/i.test(pre));
      const withNo = buildPreprintedSheetsHtml([{ cheque: sample, spec: { ...spec, printChequeNumber: true }, applications: [] }]);
      ok('cheque number prints only when the stock is blank there', withNo.includes('0887'));

      // ---- CPA 006 formatting rules for a real cheque -------------------
      const { fmtChequeDateCPA, fmtAmountFiguresCPA, fmtAmountWordsCPA, currencyDesignation, DATE_FORMATS } = require('../utils/chequeHtml');
      const when = new Date('2026-08-28T00:00:00Z');
      ok('date uses no slashes and a 4-digit year (CPA 006 §6)',
        DATE_FORMATS.every((f) => /^[0-9]{2,4}( [0-9]{2,4}){2}$/.test(fmtChequeDateCPA(when, f))
          && !fmtChequeDateCPA(when, f).includes('/')),
        DATE_FORMATS.map((f) => fmtChequeDateCPA(when, f)).join(' | '));
      ok('each date order puts the elements in the right places',
        fmtChequeDateCPA(when, 'YYYYMMDD') === '2026 08 28'
        && fmtChequeDateCPA(when, 'MMDDYYYY') === '08 28 2026'
        && fmtChequeDateCPA(when, 'DDMMYYYY') === '28 08 2026');
      ok('an unknown date order falls back to the ISO one, never to slashes',
        fmtChequeDateCPA(when, 'garbage') === '2026 08 28');
      ok('the date is read in UTC, like the register',
        fmtChequeDateCPA('2026-08-31', 'YYYYMMDD') === '2026 08 31');

      const figs = fmtAmountFiguresCPA(2520);
      ok('amount in figures carries NO alphabetic characters (§8)', !/[A-Za-z]/.test(figs), figs);
      ok('amount in figures carries no currency code (§11)', !/CAD|USD|INR/.test(figs), figs);
      ok('asterisks in the amount box are only to the LEFT (§5.4.3)',
        /^\*+[0-9]/.test(figs) && !/[0-9]\*/.test(figs), figs);
      const wds = fmtAmountWordsCPA('Two Thousand Five Hundred Twenty and 00/100');
      ok('asterisks in the amount in words are only to the LEFT (§5.4.3)',
        /^\*+[A-Za-z]/.test(wds) && !/[0-9A-Za-z]\*/.test(wds), wds);

      ok('a USD cheque gets a currency designation (§11)', currencyDesignation({ currency: 'USD' }, { currency: 'CAD' }) === 'U.S. FUNDS');
      ok('a foreign cheque gets one too', currencyDesignation({ currency: 'INR' }, { currency: 'CAD' }) === 'INR FUNDS');
      ok('a domestic cheque gets none', currencyDesignation({ currency: 'CAD' }, { currency: 'CAD' }) === '');
      ok('no designation when the account declares no currency', currencyDesignation({ currency: 'CAD' }, { currency: '' }) === '');

      // ...and the rendered document must actually use them.
      const cadSpec = { ...spec, currency: 'CAD', dateFormat: 'YYYYMMDD' };
      const rendered = buildPreprintedSheetsHtml([{ cheque: sample, spec: cadSpec, applications: [] }]);
      const band = rendered.split('class="band stub"')[0];
      ok('the cheque band prints the CPA date', band.includes('2026 08 28'), band.match(/>[0-9 ]{8,12}</)?.[0]);
      // A full slashed date (08/28/26). NOT `[0-9]/[0-9]`, which also matches the
      // cents fraction "and 00/100" — that is the standard legal-amount form, and
      // CPA 006's slash prohibition is specifically about the date field.
      ok('the cheque band never prints a slashed date', !/\d{1,4}\/\d{1,2}\/\d{2,4}/.test(band), band.match(/\d{1,4}\/\d{1,2}\/\d{2,4}/)?.[0]);
      ok('the amount in words keeps its cents fraction', /and 00\/100/.test(band));
      ok('the cheque band prints no currency code beside the amount', !/CAD 2,520/.test(band));
      const usdRendered = buildPreprintedSheetsHtml([{ cheque: { ...sample, currency: 'USD' }, spec: cadSpec, applications: [] }]);
      ok('a USD cheque prints U.S. FUNDS below the box', usdRendered.includes('U.S. FUNDS'));
      ok('a CAD cheque on a CAD account prints no designation', !band.includes('FUNDS'));

      // ---- width caps: nothing may run into the bank's scan area ---------
      {
        const L = DEFAULT_PREPRINTED_LAYOUT;
        const scanLeft = 8.5 - CPA.amountScanWidthIn;           // 5.85in
        const payeeEnds = L.payee.left + (8.5 - L.payee.left - CPA.amountScanWidthIn - CPA.clearAreaIn);
        ok('payee block stops one clear area before the scan area',
          payeeEnds <= scanLeft - CPA.clearAreaIn + 1e-9, `${payeeEnds.toFixed(2)} vs ${(scanLeft - CPA.clearAreaIn).toFixed(2)}`);

        // A payee name long enough to have overrun it before the cap existed.
        const longPayee = {
          ...sample,
          payeeName: 'CROSS MILES CARRIER TRANSPORTATION SERVICES INCORPORATED OF ONTARIO',
          payeeAddress: 'Unit 14, 4120 Something Very Long Boulevard\nMississauga ON L5N 8K9\nCanada',
          note: 'Advance for August fuel, trailer repair, border crossing fees and detention',
        };
        const html = buildPreprintedSheetsHtml([{ cheque: longPayee, spec, applications: [] }]);
        const cband = html.split('class="band stub"')[0];
        ok('a long payee is width-capped, not left to run into the scan area', /width:4\.3000in/.test(cband), cband.match(/width:[0-9.]+in/g)?.join(','));
        ok('a long memo is width-capped and clipped to one line',
          /white-space:nowrap/.test(cband) && /overflow:hidden/.test(cband));
        ok('the long payee is still height-clipped above the MICR band', /max-height:/.test(cband));

        // Shrink-to-fit: a long payee keeps more of its address rather than
        // being clipped at one fixed size. The address is what shows through
        // the window envelope, so losing it means the cheque cannot be mailed.
        const { fitPayeeSize } = require('../utils/chequeHtml');
        // Deliberately does NOT recompute the available height: duplicating the
        // geometry here is how a test starts agreeing with itself instead of
        // with the renderer. The observable behaviour is asserted instead.
        ok('a short payee keeps the full-size type',
          fitPayeeSize(['40 WEST YARD INC.', '40 West Drive', 'Brampton ON L6T 3T6'], 4.30, 0.61, 1.32) === 11);
        ok('an absurd payee still stops at a legible floor',
          fitPayeeSize([('X').repeat(400)], 4.30, 0.05, 1.32) === 7.5);

        const shortHtml = buildPreprintedSheetsHtml([{ cheque: sample, spec, applications: [] }]).split('class="band stub"')[0];
        const sizeOf = (html) => {
          const m = html.match(/font-size:([0-9.]+)pt;font-weight:bold;[^"]*max-height/) // payee carries max-height
            || html.match(/font-size:([0-9.]+)pt[^"]*max-height/);
          return m ? Number(m[1]) : null;
        };
        const oneLine = buildPreprintedSheetsHtml([{ cheque: { ...sample, payeeAddress: '40 West Drive' }, spec, applications: [] }]).split('class="band stub"')[0];
        const tinySize = sizeOf(oneLine);
        const shortSize = sizeOf(shortHtml);
        const longSize = sizeOf(cband);
        // The band has about half an inch here on real stock, so a three-line
        // payee legitimately does not fit at the full size. What must hold is
        // that the fitter never grows a longer block, never drops below a
        // legible floor, and only shrinks when it has to.
        ok('a two-line payee renders at the full size', tinySize === 11, String(tinySize));
        ok('more payee lines never render LARGER', shortSize <= tinySize && longSize <= shortSize,
          `${tinySize} / ${shortSize} / ${longSize}`);
        ok('a long payee is shrunk rather than clipped at full size', longSize < tinySize, String(longSize));
        ok('every rendered size stays legible', [tinySize, shortSize, longSize].every((n) => n >= 7.5),
          `${tinySize} / ${shortSize} / ${longSize}`);
      }

      const align = buildAlignmentSheetHtml(spec, null, { name: 'RBC Operating' });
      ok('alignment sheet warns it is plain paper', /plain paper/i.test(align));
      ok('alignment sheet marks the MICR band', /MICR band/i.test(align));
      ok('alignment sheet states the date order to check', /date order/i.test(align) && /never slashes/i.test(align));
    }

    // ---------------------------------------------------------------- pre-printed stock, end to end
    r = await A.post('/bank-accounts/add', {
      name: 'RBC Cheque Book', accountNo: '000114471', chequeStart: 887,
      printMode: 'preprinted', chequePosition: 'top', chequeHeightIn: 3.5, offsetYmm: 2,
    });
    const stockAcct = r.data.account;
    ok('account saves its print settings', r.data.status === true
      && stockAcct.printMode === 'preprinted' && stockAcct.offsetYmm === 2, JSON.stringify(r.data.account));
    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { chequeHeightIn: 9, offsetXmm: 999 });
    ok('out-of-range stock values are clamped, not rejected',
      r.data.account?.chequeHeightIn === 3.75 && r.data.account?.offsetXmm === 25,
      JSON.stringify({ h: r.data.account?.chequeHeightIn, x: r.data.account?.offsetXmm }));
    // Field overrides are interpolated into a style attribute, so they are
    // validated key by key rather than stored as given.
    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { layoutOverrides: { date: { align: 'left" onload=x', left: 'abc' } } });
    ok('a layout override that could break out of the style attribute is dropped',
      !r.data.account?.layoutOverrides, JSON.stringify(r.data.account?.layoutOverrides));
    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { layoutOverrides: { date: { left: 1.5, align: 'right' }, evil: { left: 1 } } });
    ok('a valid override is kept and an unknown field dropped',
      r.data.account?.layoutOverrides?.date?.left === 1.5 && !r.data.account?.layoutOverrides?.evil,
      JSON.stringify(r.data.account?.layoutOverrides));
    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { layoutOverrides: { date: { left: 999 } } });
    ok('an out-of-range override is clamped onto the sheet', r.data.account?.layoutOverrides?.date?.left === 8.5);
    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { layoutOverrides: null });
    ok('overrides can be cleared back to the spec defaults', r.data.account?.layoutOverrides === null);

    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { dateFormat: 'DDMMYYYY' });
    ok('date order is settable per account', r.data.account?.dateFormat === 'DDMMYYYY');
    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { dateFormat: 'MM/DD/YY' });
    ok('an invalid date order is ignored, not stored', r.data.account?.dateFormat === 'DDMMYYYY');
    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { dateFormat: 'YYYYMMDD' });
    r = await A.post(`/bank-accounts/update/${stockAcct._id}`, { notes: 'unchanged' });
    ok('a partial update leaves print settings alone', r.data.account?.printMode === 'preprinted');

    r = await A.get(`/bank-accounts/${stockAcct._id}/alignment-sheet`, { responseType: 'arraybuffer' });
    ok('alignment sheet renders a PDF', pdfSkipped || isPdf(r), r.status);
    r = await S.get(`/bank-accounts/${stockAcct._id}/alignment-sheet`);
    ok('staff blocked from the alignment sheet', r.status === 403);
    r = await A2.get(`/bank-accounts/${stockAcct._id}/alignment-sheet`);
    ok('cross-tenant alignment sheet 404', r.status === 404);

    const stockCheque = (await add({ bankAccount: stockAcct._id, amount: 2520 })).data.cheque;
    ok('cheque on the stock account takes its book number', stockCheque.chequeNo === '887', stockCheque.chequeNo);
    r = await A.get(`/cheques/${stockCheque._id}/pdf?preview=true`, { responseType: 'arraybuffer' });
    ok('pre-printed cheque renders a PDF', pdfSkipped || isPdf(r), r.status);

    // A batch cannot span two kinds of paper — the tray would have to change.
    const plainCheque = (await add({ amount: 40 })).data.cheque;
    r = await A.post('/cheques/print-batch', { ids: [stockCheque._id, plainCheque._id], preview: true });
    ok('mixed plain/pre-printed batch refused', r.status === 409 && r.data.code === 'mixed_stock', r.status);
    r = await A.post('/cheques/print-batch', { ids: [stockCheque._id], preview: true }, { responseType: 'arraybuffer' });
    ok('single-stock batch still prints', pdfSkipped || isPdf(r), r.status);

    // On numbered stock the sheet order is fixed by the paper, not the clicks.
    {
      const { _test } = require('../controllers/chequeController');
      const mk = (no) => ({ cheque: { chequeNo: no }, spec: { printMode: 'preprinted' } });
      const clicked = [mk('0890'), mk('0887'), mk('0889'), mk('0888')];
      const sorted = _test.orderForStock(clicked).map((e) => e.cheque.chequeNo);
      ok('a pre-printed batch prints in cheque-number order, not click order',
        sorted.join(',') === '0887,0888,0889,0890', sorted.join(','));
      const lettered = [mk('B-2'), mk('A-1')];
      ok('a lettered cheque book keeps the caller order (no order to infer)',
        _test.orderForStock(lettered).map((e) => e.cheque.chequeNo).join(',') === 'B-2,A-1');
      ok('gaps in the stack are reported', _test.stackGaps(['0887', '0888', '0891']).join(',') === '0889,0890');
      ok('a contiguous stack reports no gaps', _test.stackGaps(['0887', '0888']).length === 0);
    }

    // ---------------------------------------------------------------- global search
    const g = async (q) => (await A.get(`/search/global?q=${encodeURIComponent(q)}`)).data;
    let d = await g('Second Vendor');
    ok('search finds vendor', (d.results?.vendors || []).length === 1);
    d = await g('Bay Area');
    ok('multi-token AND', (d.results?.customers || []).length === 1);
    d = await g('4165559090');
    ok('customer by unformatted phone', (d.results?.customers || []).length === 1);
    d = await g('1234 Main');
    ok('street number + word (digits must not force a phone match)', (d.results?.customers || []).length === 1);
    d = await g('M5V 2T6');
    ok('postal code', (d.results?.customers || []).length === 1);
    d = await g('MC1');
    ok('carrier mc code', (d.results?.carriers || []).length === 1);
    d = await S.get('/search/global?q=Second Vendor');
    ok('staff sees no vendors in search', (d.data.results?.vendors || []).length === 0);

    // ---------------------------------------------------------------- audit
    await sleep(800);
    const logs = await ActivityLog.find({ tenantId: 't1', module: { $in: ['cheque', 'vendor'] } }).lean();
    ok('audit entries written', logs.length >= 8, logs.length);
    ok('void of a printed cheque logged critical', logs.some((l) => l.critical && /voided/.test(l.description || '')));
  } catch (err) {
    // Includes fixture failures — they used to run outside the try, so a bad
    // fixture skipped teardown and poisoned the next run.
    console.error('TEST SUITE RUNTIME ERROR:', err);
    fail += 1;
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    await teardown();
    process.exit(fail ? 1 : 0);
  }
})().catch(async (e) => { console.error('SCRIPT ERROR', e); await teardown(); process.exit(2); });
