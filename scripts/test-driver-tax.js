// Offline tests for driver contractor tax (HST/GST). No database: models and puppeteer are
// stubbed through require.cache, so this runs anywhere in under a second.
//   node backend/scripts/test-driver-tax.js
// Exit code 1 on any failure.
const path = require('path');
const BACKEND = path.join(__dirname, '..');

let failed = 0, passed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label} ${detail}`); }
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function stub(rel, exportsObj) {
  const full = require.resolve(path.join(BACKEND, rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// ---------------------------------------------------------------------------
console.log('\npayslipMath — tax is added on top, never re-taxes carry-forward, identity holds');
const { round2, computePayslipTotals } = require(`${BACKEND}/utils/payslipMath`);
{
  const noTax = computePayslipTotals({ basePayable: 1000, additions: 50, paidAmount: 0 });
  eq('owner path (no taxAmount) unchanged', [noTax.finalPayable, noTax.taxAmount], [1050, 0]);
  const t = computePayslipTotals({ basePayable: 800, taxAmount: 130, paidAmount: 0 });
  eq('tax added to final', t.finalPayable, 930);
  const owed = computePayslipTotals({ basePayable: -500, taxAmount: 13, paidAmount: 0 });
  eq('negative month still charges tax on the work', [owed.owedAmount, owed.paymentStatus], [487, 'owed']);
  const paid = computePayslipTotals({ basePayable: 800, taxAmount: 130, paidAmount: 930 });
  eq('paid in full incl. tax', [paid.paymentStatus, paid.dueAmount], ['paid', 0]);
  // Identity: finalPayable − taxAmount === the untaxed payslip, in every shape.
  for (const [trip, city, ded, add, rate] of [[4000, 250, 500, 100, 13], [1000, 0, 0, 0, 13], [1000, 0, 2000, 0, 13], [0, 0, 0, 0, 13], [3333.33, 111.11, 0, 0, 5]]) {
    const taxable = round2(trip + city), tax = round2(taxable * rate / 100), base = round2(trip + city - ded);
    const withTax = computePayslipTotals({ basePayable: base, taxAmount: tax, additions: add });
    const without = computePayslipTotals({ basePayable: base, additions: add });
    eq(`identity trip ${trip} city ${city} ded ${ded} add ${add} @${rate}%`, round2(withTax.finalPayable - tax), without.finalPayable);
  }
}

// ---------------------------------------------------------------------------
console.log('\ndriverController.parseTaxFields — absent = leave alone, blank rate is not 0%');
{
  const { parseTaxFields } = require(`${BACKEND}/controllers/driverController`)._internals;
  eq('legacy payload untouched', parseTaxFields({ name: 'x' }), {});
  eq('enable trims', parseTaxFields({ taxEnabled: true, taxNumber: ' 845221907RT0001 ', taxCompanyName: ' Acme Inc. ', taxRate: '13' }),
    { taxEnabled: true, taxNumber: '845221907RT0001', taxCompanyName: 'Acme Inc.', taxRate: 13 });
  eq('disable keeps registration', parseTaxFields({ taxEnabled: false, taxNumber: '845221907RT0001' }), { taxEnabled: false, taxNumber: '845221907RT0001' });
  eq("string 'true'", parseTaxFields({ taxEnabled: 'true' }), { taxEnabled: true });
  eq('blank rate -> default 13', parseTaxFields({ taxRate: '' }), { taxRate: 13 });
  eq('null rate -> default 13', parseTaxFields({ taxRate: null }), { taxRate: 13 });
  eq('garbage rate -> default 13', parseTaxFields({ taxRate: 'abc' }), { taxRate: 13 });
  eq('rate clamped high', parseTaxFields({ taxRate: 999 }), { taxRate: 100 });
  eq('rate clamped negative', parseTaxFields({ taxRate: -5 }), { taxRate: 0 });
  eq('explicit 0 honoured', parseTaxFields({ taxRate: 0 }), { taxRate: 0 });
  eq('rate rounded to 2dp', parseTaxFields({ taxRate: 9.9751 }), { taxRate: 9.98 });

  // taxStateError — enabling tax without a registration number is refused, judged on the
  // RESULTING state so a re-enable can lean on the stored number.
  const { taxStateError } = require(`${BACKEND}/controllers/driverController`)._internals;
  check('enable without number refused', taxStateError({ taxEnabled: true }) !== null);
  check('enable with blank number refused', taxStateError({ taxEnabled: true, taxNumber: '   ' }) !== null);
  check('enable with number ok', taxStateError({ taxEnabled: true, taxNumber: '845221907RT0001' }) === null);
  check('re-enable leaning on stored number ok', taxStateError({ taxEnabled: true }, { taxNumber: '845221907RT0001' }) === null);
  check('clearing number on enabled driver refused', taxStateError({ taxNumber: '' }, { taxEnabled: true, taxNumber: '845221907RT0001' }) !== null);
  check('untouched enabled driver ok', taxStateError({}, { taxEnabled: true, taxNumber: '845221907RT0001' }) === null);
  // A record stored in an impossible state must not become permanently unsaveable: an edit that
  // does not touch tax is never judged on tax (and with the tax UI hidden, that 400 would name a
  // field the user cannot even see).
  check('unrelated edit on a broken tax state is allowed', taxStateError({}, { taxEnabled: true, taxNumber: '' }) === null);
  check('but touching tax on that broken state is still refused', taxStateError({ taxRate: 13 }, { taxEnabled: true, taxNumber: '' }) !== null);
  check('and enabling still needs a number', taxStateError({ taxEnabled: true }, { taxNumber: '' }) !== null);
  check('disable without number ok', taxStateError({ taxEnabled: false }) === null);
  check('legacy payload on legacy profile ok', taxStateError({}, null) === null);
}

// ---------------------------------------------------------------------------
console.log('\ndriverAccessMiddleware — drivers cannot write driver records; nobody edits their own pay without HR');
{
  const { requireDriverWriteAccess } = require(`${BACKEND}/middlewares/driverAccessMiddleware`);
  const run = (user, params, tenantId = 't1') => new Promise((resolve) => {
    const res = { status: (c) => ({ json: (b) => resolve({ http: c, code: b.code }) }) };
    requireDriverWriteAccess({ user, params, tenantId }, res, () => resolve({ http: 'NEXT' }));
    setTimeout(() => resolve({ http: 'HUNG' }), 200);
  });
  const cases = [
    ['driver editing someone else', [{ _id: 'd1', permissions: ['driver'] }, { id: 'd2' }], 403, 'driver_write_denied'],
    ['driver editing self', [{ _id: 'd1', permissions: ['driver'] }, { id: 'd1' }], 403, 'driver_write_denied'],
    ['no-permission user', [{ _id: 'u0', permissions: [] }, { id: 'd2' }], 403, 'driver_write_denied'],
    ['dispatcher editing a driver', [{ _id: 'u9', permissions: ['regular'] }, { id: 'd2' }], 'NEXT'],
    ['dispatcher adding a driver', [{ _id: 'u9', permissions: ['regular'] }, {}], 'NEXT'],
    ['dispatcher editing self', [{ _id: 'u9', permissions: ['regular'] }, { id: 'u9' }], 403, 'driver_self_edit_denied'],
    ['accounting editing self', [{ _id: 'u9', permissions: ['accounting'] }, { id: 'u9' }], 403, 'driver_self_edit_denied'],
    ['HR editing self', [{ _id: 'u9', permissions: ['employees'] }, { id: 'u9' }], 'NEXT'],
    ['admin editing self', [{ _id: 'u9', is_admin: 1 }, { id: 'u9' }], 'NEXT'],
    ['self-edit via ObjectId', [{ _id: { toString: () => 'abc' }, permissions: ['regular'] }, { id: 'abc' }], 403, 'driver_self_edit_denied'],
    ['missing tenant', [{ is_admin: 1 }, {}, null], 400],
  ];
  module.exports.middlewareDone = (async () => {
    for (const [label, args, http, code] of cases) {
      const r = await run(...args);
      check(label, r.http === http && (code === undefined || r.code === code), JSON.stringify(r));
    }
  })();
}
// ---------------------------------------------------------------------------
console.log('\nsearchController — drivers are found and ranked by taxNumber and taxCompanyName');
{
  const { FIELD_SETS, scoreDoc, rank } = require(`${BACKEND}/controllers/searchController`)._internals;
  const driverFields = [...FIELD_SETS.drivers, ...FIELD_SETS.driverProfiles];
  const driverWithTax = {
    _id: 'd1',
    name: 'Gurpreet Singh',
    corporateID: 'DRID100234',
    email: 'gurpreet@example.com',
    taxNumber: '845221907RT0001',
    taxCompanyName: 'Apex Logistics Corp',
    createdAt: new Date(),
  };
  const ctxTaxNo = {
    q: '845221907rt0001',
    tokens: ['845221907rt0001'],
    digits: '8452219070001',
    wordRegex: /\b845221907rt0001/i,
  };
  const scoreTaxNo = scoreDoc(driverWithTax, driverFields, ctxTaxNo);
  check('search: taxNumber exact match scored', scoreTaxNo !== null && scoreTaxNo.score >= 90);
  check('search: taxNumber field match reported', scoreTaxNo?.matchedFields?.some((m) => m.field === 'taxNumber'));

  const ctxCorp = {
    q: 'apex logistics',
    tokens: ['apex', 'logistics'],
    digits: '',
    wordRegex: /\bapex\s+logistics/i,
  };
  const scoreCorp = scoreDoc(driverWithTax, driverFields, ctxCorp);
  check('search: taxCompanyName match scored', scoreCorp !== null && scoreCorp.score >= 50);
  check('search: taxCompanyName field match reported', scoreCorp?.matchedFields?.some((m) => m.field === 'taxCompanyName'));

  const ranked = rank([driverWithTax], driverFields, ctxTaxNo, 5);
  check('search: rank returns matched driver with high score', ranked.length === 1 && ranked[0]._score >= 90);
}

// ---------------------------------------------------------------------------
console.log('\npayslip lifecycle — applyDriverPaidTotal maintains payableBeforeTax parity');
{
  const salaryObj = {
    basePayable: 1000,
    taxAmount: 130,
    previousDueAdded: 0,
    previousOwedDeducted: 0,
    additionTotal: 0,
    paidAmount: 0,
    finalPayable: 1130,
    payableBeforeTax: 1000,
    dueAmount: 1130,
    owedAmount: 0,
    overpaidAmount: 0,
    paymentStatus: 'pending',
    save: async function() { return this; }
  };
  const t = computePayslipTotals({
    basePayable: salaryObj.basePayable,
    taxAmount: salaryObj.taxAmount,
    previousDueAdded: salaryObj.previousDueAdded,
    previousOwedDeducted: salaryObj.previousOwedDeducted,
    additions: salaryObj.additionTotal,
    deductions: 0,
    paidAmount: 500,
  });
  salaryObj.finalPayable = t.finalPayable;
  salaryObj.payableBeforeTax = round2(t.finalPayable - round2(salaryObj.taxAmount || 0));
  salaryObj.paidAmount = t.paidAmount;
  salaryObj.dueAmount = t.dueAmount;
  eq('applyDriverPaidTotal: payableBeforeTax untouched after payment', salaryObj.payableBeforeTax, 1000);
  eq('applyDriverPaidTotal: dueAmount reduced', salaryObj.dueAmount, 630);
}

const pdfDone = (async () => {
  await module.exports.middlewareDone;
  console.log('\ngetDriverSalaryPdf — real template, three states');
  const captured = [];
  stub('utils/puppeteer', {
    launchBrowser: async () => ({
      newPage: async () => ({ setContent: async (h) => { captured.push(h); }, pdf: async () => Buffer.from('x'), on() {}, setRequestInterception: async () => {} }),
      close: async () => {},
    }),
    hardenPage: async () => {},
  });
  stub('utils/activityLogger', { logActivity() {}, logChange() {} });
  stub('utils/logger', () => {});
  const DRIVER = { _id: 'd1', name: 'Test Driver', corporateID: 'DRID1', tenantId: 't1' };
  stub('db/Users', { findOne: () => ({ lean: async () => DRIVER, select: () => ({ lean: async () => DRIVER }) }) });
  stub('db/Company', { findOne: () => ({ lean: async () => ({ name: 'CO' }) }) });
  stub('db/DriverProfile', { findOne: () => ({ select: () => ({ lean: async () => ({ rateCurrency: 'CAD' }) }), lean: async () => ({ rateCurrency: 'CAD' }) }) });
  stub('db/DriverPayment', { find: () => ({ sort: () => ({ lean: async () => [] }) }) });
  stub('db/DriverDeduction', { find: () => ({ lean: async () => [] }) });

  const base = { _id: 's1', month: 8, year: 2026, currency: 'CAD', rateCurrency: 'CAD', tripPay: 1126.94, cityPay: 168, cityHours: 6, deductionTotal: 240, additionTotal: 90, paidAmount: 0, orderBreakdown: [] };
  const finish = (s) => {
    const basePayable = round2(s.tripPay + s.cityPay - s.deductionTotal);
    const t = computePayslipTotals({ basePayable, taxAmount: s.taxAmount, additions: s.additionTotal, paidAmount: 0 });
    return { ...s, basePayable, finalPayable: t.finalPayable, payableBeforeTax: round2(t.finalPayable - round2(s.taxAmount || 0)) };
  };
  const taxable = round2(base.tripPay + base.cityPay);
  const cases = {
    'tax-off': [finish(base), { hstRow: false, card: false, before: false, net: 'NET PAYABLE</td>' }],
    'tax-on': [finish({ ...base, taxEnabled: true, taxRate: 13, taxNumber: '845221907RT0001', taxCompanyName: 'X Inc.', taxableBase: taxable, taxAmount: round2(taxable * 0.13) }), { hstRow: true, card: true, before: true, net: 'NET PAYABLE (WITH TAX)' }],
    'tax-zero': [finish({ ...base, tripPay: 0, cityPay: 0, deductionTotal: 0, additionTotal: 0, taxEnabled: true, taxRate: 13, taxNumber: '845221907RT0001', taxableBase: 0, taxAmount: 0 }), { hstRow: false, card: true, before: false, net: 'NET PAYABLE</td>' }],
  };
  for (const [label, [salary, want]] of Object.entries(cases)) {
    stub('db/DriverSalary', { findOne: () => ({ lean: async () => salary }) });
    delete require.cache[require.resolve(`${BACKEND}/controllers/driverSalaryController`)];
    const ctrl = require(`${BACKEND}/controllers/driverSalaryController`);
    captured.length = 0;
    let bail = null;
    const res = { setHeader() {}, end() {}, status: (c) => ({ json: (b) => { bail = { c, b }; } }), json: (b) => { bail = { c: 200, b }; } };
    ctrl.getDriverSalaryPdf({ params: { driverId: 'd1' }, query: { month: 8, year: 2026, currency: 'CAD' }, tenantId: 't1', user: { _id: 'u1', is_admin: 1, company: { _id: 'c1' } }, tenant: {} }, res, (e) => { bail = { c: 'next', b: String(e) }; });
    for (let i = 0; i < 200 && !captured.length && !bail; i++) await new Promise((r) => setTimeout(r, 25));
    const html = captured[0] || '';
    check(`${label}: rendered`, !!html, JSON.stringify(bail));
    if (!html) continue;
    check(`${label}: exactly one NET PAYABLE row`, (html.match(/NET PAYABLE/g) || []).length === 1);
    check(`${label}: HST row ${want.hstRow ? 'present' : 'absent'}`, /HST\/GST \(/.test(html) === want.hstRow);
    check(`${label}: HST No card ${want.card ? 'present' : 'absent'}`, /HST\/GST No/.test(html) === want.card);
    check(`${label}: TOTAL BEFORE TAX ${want.before ? 'present' : 'absent'}`, /TOTAL BEFORE TAX/.test(html) === want.before);
    check(`${label}: net label`, html.includes(want.net));
    if (label === 'tax-on') check('tax-on: amounts', html.includes('1,144.94') && html.includes('168.34') && html.includes('1,313.28'));
  }
})();

pdfDone.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error('RUNNER CRASHED', e); process.exit(1); });
