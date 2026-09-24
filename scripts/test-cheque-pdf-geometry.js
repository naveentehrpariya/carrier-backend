/**
 * Where does the ink ACTUALLY land on a pre-printed cheque?
 *
 * test-cheques.js checks the HTML the renderer writes. That is not the same
 * thing as the PDF: Chrome decides line breaks, glyph widths and page breaks,
 * and a field that is correct in CSS can still run past its box once real text
 * is in it. This suite renders through the production code path
 * (chequeController._test.htmlToChequePdf — fit script, refusal and page
 * options included), reads every text run back out of the PDF with pdfjs, and
 * asserts positions in inches on the paper:
 *
 *   - the amount in figures sits inside the CPA 006 convenience-amount scan area
 *   - nothing else enters that scan area
 *   - nothing enters the MICR band (bottom 0.625in of the cheque)
 *   - nothing is closer than 0.25in to the paper edge (where a printer drops it)
 *   - the amount in words stays ONE text run (never wraps into a second amount)
 *   - a nudge moves the ink by exactly the nudge
 *   - a legal amount too long to fit is REFUSED, not printed
 *   - a batch prints one sheet per cheque, in cheque-number order
 *
 * Needs Chrome (via utils/puppeteer). No database.
 *   node scripts/test-cheque-pdf-geometry.js
 */
const path = require('path');
const BankAccount = require('../db/BankAccount');
const { buildPreprintedSheetsHtml, buildAlignmentSheetHtml, amountToWords, CPA, NUDGE_MAX_MM } = require('../utils/chequeHtml');
const { _test } = require('../controllers/chequeController');
const pdfjs = require(path.join(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.js'));

const PAGE_W = 8.5;
const PAGE_H = 11;
const PRINTER_MARGIN_IN = 0.25;

let passed = 0;
let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; return; }
  failed++;
  console.log(`FAIL ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};

const specOf = (fields) => new BankAccount({ tenantId: 't', name: 'RBC Operating', currency: 'CAD', printMode: 'preprinted', ...fields }).printSpec();

const BASE = {
  _id: 'x', paymentDate: new Date('2026-08-28T00:00:00Z'), amount: 2520, currency: 'CAD',
  chequeNo: '0887', payeeName: '40 WEST YARD INC.', payeeAddress: '40 West Drive\nBrampton ON L6T 3T6',
  note: 'Fuel advance August', referenceNo: 'INV-2211', status: 'issued',
};
const LONG = {
  payeeName: 'CROSS MILES CARRIER TRANSPORTATION SERVICES INCORPORATED OF ONTARIO',
  payeeAddress: 'Unit 14, 4120 Something Very Long Boulevard\nMississauga ON L5N 8K9\nCanada\nATTN: Accounts Payable',
  note: 'Advance for August fuel, trailer repair, border crossing fees and detention charges',
};
const entry = (cheque, spec) => ({ cheque: { ...cheque, amountInWords: amountToWords(cheque.amount) }, spec, applications: [] });

async function readPdf(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.filter((i) => i.str.trim()).map((i) => {
      const size = Math.hypot(i.transform[2], i.transform[3]) / 72;
      const x = i.transform[4] / 72;
      const baseline = PAGE_H - i.transform[5] / 72;
      return { s: i.str, x0: x, x1: x + i.width / 72, top: baseline - 0.8 * size, bot: baseline + 0.2 * size };
    }));
  }
  return pages;
}

const render = async (entries) => readPdf(await _test.htmlToChequePdf(buildPreprintedSheetsHtml(entries)));

/** Every geometric rule for one rendered cheque sheet. */
function checkSheet(name, items, spec) {
  const dx = spec.offsetXmm / 25.4;
  const dy = spec.offsetYmm / 25.4;
  const bandTop = spec.bandTopIn + dy;
  const bandBottom = bandTop + spec.chequeHeightIn;
  const micrTop = bandBottom - CPA.micrBandIn;
  const scan = {
    x0: PAGE_W - CPA.amountScanWidthIn + dx, x1: PAGE_W + dx,
    top: bandBottom - CPA.amountUpperFromBottomIn, bot: bandBottom - CPA.amountLowerFromBottomIn,
  };
  const inBand = items.filter((t) => t.bot > bandTop && t.top < bandBottom);
  const amt = inBand.find((t) => /^\*+[0-9,]+\.[0-9]{2}$/.test(t.s));

  ok(`${name}: amount in figures printed`, !!amt, JSON.stringify(inBand.map((t) => t.s)));
  if (amt) {
    ok(`${name}: amount in figures inside the CPA scan area`,
      amt.x0 >= scan.x0 - 1e-3 && amt.x1 <= scan.x1 + 1e-3 && amt.top >= scan.top - 1e-3 && amt.bot <= scan.bot + 1e-3,
      `${amt.s} x ${amt.x0.toFixed(2)}-${amt.x1.toFixed(2)} y ${amt.top.toFixed(2)}-${amt.bot.toFixed(2)} vs scan ${scan.x0.toFixed(2)}-${scan.x1.toFixed(2)} / ${scan.top.toFixed(2)}-${scan.bot.toFixed(2)}`);
    ok(`${name}: amount in figures carries no letters`, !/[A-Za-z]/.test(amt.s), amt.s);
  }
  const words = inBand.filter((t) => /\/100$/.test(t.s));
  ok(`${name}: amount in words is one line`, words.length === 1, JSON.stringify(words.map((t) => t.s)));

  for (const t of inBand) {
    if (/^V ?O ?I ?D$/.test(t.s.replace(/\s+/g, ' ').trim())) continue; // the watermark is meant to cross everything
    ok(`${name}: "${t.s}" stays out of the MICR band`, t.bot <= micrTop + 0.01, `bottom ${t.bot.toFixed(3)} > ${micrTop.toFixed(3)}`);
    if (t !== amt) {
      const intrudes = t.x1 > scan.x0 + 0.01 && t.x0 < scan.x1 && t.bot > scan.top + 0.01 && t.top < scan.bot - 0.01;
      ok(`${name}: "${t.s}" stays out of the scan area`, !intrudes,
        `x ${t.x0.toFixed(2)}-${t.x1.toFixed(2)} y ${t.top.toFixed(2)}-${t.bot.toFixed(2)}`);
    }
    ok(`${name}: "${t.s}" is not slashed-date`, !/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t.s));
  }
  for (const t of items) {
    ok(`${name}: "${t.s}" is printable (>= ${PRINTER_MARGIN_IN}in from every edge)`,
      t.x0 >= PRINTER_MARGIN_IN - 0.01 && t.x1 <= PAGE_W - PRINTER_MARGIN_IN + 0.01 && t.top >= PRINTER_MARGIN_IN - 0.05 && t.bot <= PAGE_H - PRINTER_MARGIN_IN + 0.01,
      `x ${t.x0.toFixed(2)}-${t.x1.toFixed(2)} y ${t.top.toFixed(2)}-${t.bot.toFixed(2)}`);
  }
  return { amt, inBand };
}

(async () => {
  // ---- every band position x every legal height ------------------------
  for (const pos of ['top', 'middle', 'bottom']) {
    for (const h of [2.75, 3.0, 3.25, 3.5, 3.75]) {
      const spec = specOf({ chequePosition: pos, chequeHeightIn: h });
      const pages = await render([entry(BASE, spec)]);
      ok(`${pos} ${h}: one sheet`, pages.length === 1, pages.length);
      const { inBand } = checkSheet(`${pos} ${h}`, pages[0] || [], spec);
      // Stub text belongs to the stubs, never to the cheque band.
      ok(`${pos} ${h}: no remittance text on the cheque`,
        !inBand.some((t) => /remittance|office copy|payee copy/i.test(t.s)), JSON.stringify(inBand.map((t) => t.s)));
    }
  }

  // ---- the awkward cheques ----------------------------------------------
  const spec35 = specOf({ chequePosition: 'top', chequeHeightIn: 3.5 });
  const awkward = [
    ['long payee + memo, USD, six figures', { ...BASE, ...LONG, currency: 'USD', amount: 123456.78 }],
    ['one cent', { ...BASE, amount: 0.01 }],
    ['no address, no memo', { ...BASE, payeeAddress: '', note: '' }],
    ['void', { ...BASE, status: 'void' }],
    ['markup in every text field', { ...BASE, payeeName: '<b>ACME</b> & "Sons"', payeeAddress: '<script>x</script>\nToronto', note: '</div><div>' }],
  ];
  for (const [name, cheque] of awkward) {
    const pages = await render([entry(cheque, spec35)]);
    checkSheet(name, pages[0] || [], spec35);
    if (name === 'void') ok('void: VOID is on the sheet', (pages[0] || []).some((t) => /V\s*O\s*I\s*D/.test(t.s)));
    if (name.startsWith('long')) ok('long: U.S. FUNDS printed', (pages[0] || []).some((t) => t.s === 'U.S. FUNDS'));
    if (name.startsWith('markup')) {
      ok('markup: the payee name printed literally', (pages[0] || []).some((t) => t.s.includes('<b>ACME</b>')));
    }
  }

  // ---- the cheque number, when the stock does not carry one -------------
  for (const h of [2.75, 3.5]) {
    const spec = specOf({ chequeHeightIn: h, printChequeNumber: true });
    const pages = await render([entry(BASE, spec)]);
    checkSheet(`cheque no ${h}`, pages[0] || [], spec);
    ok(`cheque no ${h}: printed`, (pages[0] || []).some((t) => t.s === '0887'));
  }

  // ---- date orders --------------------------------------------------------
  for (const [fmt, want] of [['YYYYMMDD', '2026 08 28'], ['MMDDYYYY', '08 28 2026'], ['DDMMYYYY', '28 08 2026']]) {
    const spec = specOf({ dateFormat: fmt });
    const pages = await render([entry(BASE, spec)]);
    ok(`date ${fmt}: prints ${want}`, (pages[0] || []).some((t) => t.s === want), JSON.stringify((pages[0] || []).map((t) => t.s).slice(0, 3)));
  }

  // ---- the nudge moves the ink by exactly the nudge ---------------------
  const plain = checkSheet('nudge reference', (await render([entry(BASE, spec35)]))[0] || [], spec35);
  for (const [x, y] of [[3, -2], [NUDGE_MAX_MM, NUDGE_MAX_MM], [-NUDGE_MAX_MM, -NUDGE_MAX_MM], [NUDGE_MAX_MM, -NUDGE_MAX_MM]]) {
    for (const pos of ['top', 'bottom']) {
      const spec = specOf({ chequePosition: pos, offsetXmm: x, offsetYmm: y });
      const ref = pos === 'top' ? plain : checkSheet('nudge ref bottom', (await render([entry(BASE, specOf({ chequePosition: pos }))]))[0] || [], specOf({ chequePosition: pos }));
      const moved = checkSheet(`nudge ${x},${y} ${pos}`, (await render([entry(BASE, spec)]))[0] || [], spec);
      if (moved.amt && ref.amt) {
        ok(`nudge ${x},${y} ${pos}: ink moved by exactly the nudge`,
          Math.abs((moved.amt.x0 - ref.amt.x0) - x / 25.4) < 0.01 && Math.abs((moved.amt.top - ref.amt.top) - y / 25.4) < 0.01,
          `${(moved.amt.x0 - ref.amt.x0).toFixed(3)},${(moved.amt.top - ref.amt.top).toFixed(3)}`);
      }
    }
  }
  ok('a stored nudge beyond the limit is clamped on read', specOf({ offsetXmm: 25, offsetYmm: -40 }).offsetXmm === NUDGE_MAX_MM
    && specOf({ offsetYmm: -40 }).offsetYmm === -NUDGE_MAX_MM);

  // ---- a legal amount that cannot fit is refused ------------------------
  let refused = null;
  try { await render([entry({ ...BASE, amount: 777777777.77 }, spec35)]); } catch (e) { refused = e; }
  ok('an amount in words too long for the line is refused, not printed', refused?.code === 'field_too_long', refused?.message);
  ok('the refusal names the field', refused?.detail?.includes('amountWords'), JSON.stringify(refused?.detail));

  // The largest "worst case" (all sevens — the longest words) that still prints.
  let largest = null;
  for (const amount of [777.77, 7777.77, 77777.77, 777777.77, 7777777.77, 77777777.77]) {
    try { await render([entry({ ...BASE, amount }, spec35)]); largest = amount; } catch (e) { break; }
  }
  ok('every cheque up to 777,777.77 (the longest six-figure words) prints', largest >= 777777.77, String(largest));
  console.log(`  longest worst-case amount that fits on one words line: ${largest?.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

  // ---- a batch: one sheet per cheque, in number order -------------------
  const nos = ['0890', '0887', '0889', '0888'];
  const ordered = _test.orderForStock(nos.map((n, i) => entry({ ...BASE, chequeNo: n, amount: 1000 + i }, specOf({ printChequeNumber: true }))));
  const batch = await render(ordered);
  ok('batch: one sheet per cheque', batch.length === 4, batch.length);
  const printedNos = batch.map((p) => (p.find((t) => /^08\d\d$/.test(t.s)) || {}).s);
  ok('batch: sheets come out in cheque-number order', printedNos.join(',') === '0887,0888,0889,0890', printedNos.join(','));
  ok('batch: each sheet carries its own cheque\'s amount',
    batch.every((p, i) => p.some((t) => t.s === `***${(1000 + nos.indexOf(printedNos[i])).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)));

  // ---- the alignment sheet shows the fields where the cheque prints them -
  for (const h of [2.75, 3.5]) {
    const spec = specOf({ chequeHeightIn: h });
    const [alignPage] = await readPdf(await _test.htmlToChequePdf(buildAlignmentSheetHtml(spec, null, { name: 'RBC' })));
    const [chequePage] = await render([entry({ ...BASE, amount: 2520, paymentDate: new Date() }, spec)]);
    const alignAmt = alignPage.find((t) => /^\*+2,520\.00$/.test(t.s));
    const chequeAmt = chequePage.find((t) => /^\*+2,520\.00$/.test(t.s));
    ok(`alignment ${h}: sample amount lands where the real amount lands`,
      alignAmt && chequeAmt && Math.abs(alignAmt.x0 - chequeAmt.x0) < 0.01 && Math.abs(alignAmt.top - chequeAmt.top) < 0.01,
      alignAmt && chequeAmt ? `${alignAmt.x0.toFixed(2)},${alignAmt.top.toFixed(2)} vs ${chequeAmt.x0.toFixed(2)},${chequeAmt.top.toFixed(2)}` : 'missing');
    const today = alignPage.find((t) => /^\d{4} \d{2} \d{2}$/.test(t.s));
    const realDate = chequePage.find((t) => /^\d{4} \d{2} \d{2}$/.test(t.s));
    ok(`alignment ${h}: sample date lands where the real date lands`,
      today && realDate && Math.abs(today.x1 - realDate.x1) < 0.01 && Math.abs(today.top - realDate.top) < 0.01);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  if (e?.code === 'chrome_missing') { console.log('SKIP — Chrome not available:', e.message); process.exit(0); }
  console.error('SCRIPT ERROR', e);
  process.exit(1);
});
