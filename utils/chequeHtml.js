// Cheque PDF markup + amount-in-words.
//
// Layout mirrors standard 3-per-page cheque stock: the same content printed
// three times (cheque + two record stubs). Server-authored HTML only — rendered
// through launchBrowser()/hardenPage() like every other PDF route.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALE = ['', 'Thousand', 'Million', 'Billion'];

function threeDigitsToWords(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest >= 20) {
    const t = TENS[Math.floor(rest / 10)];
    const o = ONES[rest % 10];
    parts.push(o ? `${t} ${o}` : t);
  } else if (rest > 0) {
    parts.push(ONES[rest]);
  }
  return parts.join(' ');
}

// 2520.00 -> "Two Thousand Five Hundred Twenty and 00/100"
function amountToWords(amount) {
  const n = Math.round(Number(amount || 0) * 100);
  const dollars = Math.floor(n / 100);
  const cents = n % 100;
  let words;
  if (dollars === 0) {
    words = 'Zero';
  } else {
    const chunks = [];
    let rem = dollars;
    let scaleIdx = 0;
    while (rem > 0 && scaleIdx < SCALE.length) {
      const chunk = rem % 1000;
      if (chunk) {
        const w = threeDigitsToWords(chunk);
        chunks.unshift(scaleIdx ? `${w} ${SCALE[scaleIdx]}` : w);
      }
      rem = Math.floor(rem / 1000);
      scaleIdx += 1;
    }
    words = chunks.join(' ');
  }
  return `${words} and ${String(cents).padStart(2, '0')}/100`;
}

// Formatted in UTC, deliberately.
//
// The form sends a bare 'YYYY-MM-DD', which is stored as UTC midnight. Read back
// with the server's LOCAL getDate(), any server west of UTC (all of Canada and
// the US) renders that as the day before — a cheque dated Aug 31 in the register
// printed 08/30/26 on the paper. The register reads it as UTC; the cheque that
// people actually bank must agree with it.
const fmtChequeDate = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const yy = String(dt.getUTCFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
};

const fmtAmount = (amount, currency) => {
  const n = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${String(currency || 'CAD').toUpperCase()} ${n}`;
};

function chequeSegment(cheque) {
  const words = cheque.amountInWords || amountToWords(cheque.amount);
  // Asterisk fill after the words line, like machine-printed cheques.
  const addressLines = String(cheque.payeeAddress || '')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  return `
    <div class="segment">
      <div class="top">
        <div class="meta">
          <div class="date"><span class="lbl">Date:</span> ${esc(fmtChequeDate(cheque.paymentDate))}</div>
          <div class="amt">${esc(fmtAmount(cheque.amount, cheque.currency))}</div>
          <div class="chq">Cheque No. ${esc(cheque.chequeNo || '')}</div>
        </div>
        <div class="words">${esc(words)}<span class="fill">***************</span></div>
      </div>
      <div class="payee">
        <div class="payee-name">${esc(cheque.payeeName || '')}</div>
        ${addressLines.map((l) => `<div class="payee-line">${esc(l)}</div>`).join('')}
      </div>
      ${cheque.note ? `<div class="memo">Memo: ${esc(cheque.note)}</div>` : ''}
      ${cheque.status === 'void' ? '<div class="void">VOID</div>' : ''}
      ${cheque.status === 'bounced' ? '<div class="void">BOUNCED</div>' : ''}
    </div>`;
}

function buildChequeHtml(cheque) {
  return buildChequeBatchHtml([cheque]);
}

// One page per cheque (three identical segments each), page-broken so a batch
// print never splits a cheque across sheets.
function buildChequeBatchHtml(cheques) {
  const pages = (cheques || []).map((c) => `<div class="sheet">${chequeSegment(c)}${chequeSegment(c)}${chequeSegment(c)}</div>`).join('');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { margin: 0; size: Letter; }
  /* A cheque is printed on paper: force the light palette so a Chrome running
     with a dark colour-scheme preference does not invert the document. */
  :root { color-scheme: light; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #ffffff; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 12px; }
  .segment {
    position: relative;
    height: 3.66in;
    padding: 0.55in 0.6in 0.3in 0.6in;
    overflow: hidden;
  }
  .segment + .segment { border-top: 1px dashed #d0d0d0; }
  /* Each cheque owns a sheet: a batch never splits one across two pages. */
  .sheet { break-after: page; page-break-after: always; }
  .sheet:last-child { break-after: auto; page-break-after: auto; }
  .top { position: relative; }
  .meta { position: absolute; right: 0; top: -0.18in; text-align: right; }
  .date { font-size: 12px; margin-bottom: 6px; }
  .date .lbl { color: #444; }
  .amt { font-weight: bold; font-size: 13px; }
  .chq { color: #999; font-size: 9px; margin-top: 4px; }
  .words { font-weight: bold; font-size: 12.5px; max-width: 5.6in; padding-top: 0.15in; }
  .words .fill { letter-spacing: 1px; }
  .payee { margin-top: 0.5in; line-height: 1.45; }
  .payee-name { font-weight: bold; }
  .memo { margin-top: 0.25in; color: #555; font-size: 10.5px; }
  .void {
    position: absolute; top: 40%; left: 50%;
    transform: translate(-50%, -50%) rotate(-18deg);
    font-size: 60px; font-weight: 900; color: rgba(200, 30, 30, 0.28);
    letter-spacing: 12px;
  }
</style>
</head>
<body>
  ${pages}
</body>
</html>`;
}

module.exports = { buildChequeHtml, buildChequeBatchHtml, amountToWords, fmtChequeDate };

/* ================================================================== *
 * Pre-printed cheque stock
 * ==================================================================
 *
 * On real bank stock the bank name, logo, security pattern, signature
 * line, MICR line and the cheque number are ALREADY on the paper. We
 * print ONLY the variable fields into the empty boxes, and we never
 * draw any of the pre-printed marks — that paper is the bank's, not
 * ours. (Same rule as the document frames: a record, never a
 * reproduction.)
 *
 * Geometry comes from CPA Standard 006 "Specifications for Imageable
 * MICR-Encoded Payment Items" (Payments Canada), which every Canadian
 * cheque must comply with — so these positions hold on any compliant
 * stock rather than being guessed from one photo.
 *
 *   Business-size convenience amount (amount in figures), §5.4.3:
 *     scan area 1.55in high x 2.65in long
 *     lower edge 1.20in from the Aligning Edge  (= the cheque's BOTTOM)
 *     upper edge 2.75in from the Aligning Edge
 *     right edge at the Leading Edge            (= the cheque's RIGHT)
 *     clear area >= 0.25in all round
 *   MICR band, §5: the bottom 0.625in (5/8"). Nothing may print there.
 *   Amount in words (§9) may share the figures' line on a business
 *   cheque so the payee name and address fall in a window envelope —
 *   which is the layout this stock uses ("use with window envelope").
 *
 * Every measurement below is from the CHEQUE BAND's own edges, so the
 * same numbers hold whether the band sits at the top, middle or bottom
 * of the sheet.
 */

/**
 * CPA 006 formatting rules for the fields that actually go to a bank.
 *
 * These apply to PRE-PRINTED mode only. Blank-paper mode is a record of a
 * payment, not a negotiable instrument, so it keeps the friendlier
 * "CAD 2,520.00" / "08/28/26" forms. A real cheque has to obey the standard or
 * the bank's readers misread it.
 */

// §6: "Acceptable numeric representation for the date field on all cheques is
// in the form of YYYYMMDD, MMDDYYYY and DDMMYYYY... Spaces, dashes or dots are
// permitted between elements... Slashes or other symbols are NOT permitted."
//
// So `08/28/26` — what the register shows and what this renderer used to print
// — is invalid twice over: slashes, and a 2-digit year. Which of the three
// orders a given stock expects is printed under its own guidance boxes, so it
// is a per-account setting rather than a guess.
const DATE_FORMATS = ['YYYYMMDD', 'MMDDYYYY', 'DDMMYYYY'];

function fmtChequeDateCPA(d, format = 'YYYYMMDD') {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  // UTC for the same reason fmtChequeDate is: the form sends a bare date.
  const Y = String(dt.getUTCFullYear());
  const M = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const D = String(dt.getUTCDate()).padStart(2, '0');
  const order = DATE_FORMATS.includes(format) ? format : 'YYYYMMDD';
  const parts = order === 'YYYYMMDD' ? [Y, M, D]
    : order === 'MMDDYYYY' ? [M, D, Y]
      : [D, M, Y];
  return parts.join(' ');
}

/**
 * The convenience amount, §8: "Only one amount in figures shall appear within
 * the Convenience Amount Scan Area" and "Alphabetic characters are not
 * permitted in this area". §11 says it outright: "A currency identifier is not
 * permitted to be printed beside the Amount in Figures."
 *
 * This renderer used to print "CAD 2,520.00" straight into the box the bank
 * scans — three alphabetic characters inside the one area that must hold only
 * the amount.
 *
 * §5.4.3: asterisks are the only symbol allowed in the rectangle, and only to
 * the LEFT of the amount. The dollar sign is already on the stock.
 */
function fmtAmountFiguresCPA(amount) {
  const n = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `***${n}`;
}

/**
 * The legal amount, §5.4.3: "Asterisks may be used in the legal amount field
 * (i.e. amount in words) and shall only be printed to the LEFT of the amount
 * in words (i.e. *******forty-five dollars)."
 *
 * They used to trail on the right, which the standard does not permit — and
 * leading fill is what actually stops an amount being prefixed.
 */
function fmtAmountWordsCPA(words) {
  return `***${words}`;
}

// Letter stock. The cheque band is as wide as the sheet.
const SHEET_WIDTH_IN = 8.5;

const CPA = {
  // Amount in figures — mandated, so this one is not a guess.
  amountScanRightIn: 0,      // scan area starts at the band's right edge
  amountScanWidthIn: 2.65,
  amountLowerFromBottomIn: 1.20,
  amountUpperFromBottomIn: 2.75,
  clearAreaIn: 0.25,
  micrBandIn: 0.625,         // bottom 5/8in — never print here
};

// Vertical centre of the convenience amount rectangle, from the band's bottom.
const AMOUNT_CENTRE_FROM_BOTTOM_IN =
  (CPA.amountLowerFromBottomIn + CPA.amountUpperFromBottomIn) / 2; // 1.975in

/**
 * Where each variable field prints, in inches from the cheque band's own
 * edges. `top` is from the band top, `bottom` from the band bottom, `left`
 * from the band left, `right` from the band right.
 *
 * The amount line is spec-derived. The date and payee positions are the ones
 * CPA 006 leaves "flexible", so they are the ones a given stock is most
 * likely to disagree with — which is what `layoutOverrides` and the alignment
 * sheet are for.
 */
const DEFAULT_PREPRINTED_LAYOUT = {
  // Amount in figures: right-aligned inside the convenience amount rectangle.
  amountFigures: { right: 0.62, bottomCentre: AMOUNT_CENTRE_FROM_BOTTOM_IN, align: 'right', size: 12, bold: true, probeWidth: 1.9 },
  // Amount in words: same line, ending one clear area before the scan area.
  // Small enough to hold a long amount on ONE line — a words line that wraps
  // reads as two amounts.
  amountWords: { left: 1.00, bottomCentre: AMOUNT_CENTRE_FROM_BOTTOM_IN, size: 10, bold: true, nowrap: true },
  // Payee name + address: below the amount line, positioned for a window
  // envelope. Anchored to the amount line rather than the band top so it keeps
  // its clearances on a shorter or taller band.
  // The width matters as much as the height. The payee block sits vertically
  // INSIDE the convenience amount scan area's band (1.20-2.75in from the
  // cheque's bottom), so a long payee name with no cap runs straight into the
  // rectangle the bank's reader scans — which must keep 0.25in clear all round.
  // Capped here and allowed to wrap; the height is capped separately.
  payee: { left: 1.30, belowAmount: 0.34, size: 11, lineHeight: 1.32, probeWidth: 3.4, widthTo: 'scanClear' },
  // Date: upper right, above the amount scan area's clear zone.
  date: { right: 0.62, top: 0.50, align: 'right', size: 11, probeWidth: 1.2 },
  // Memo: lower left, held clear of the MICR band.
  // Sits below the scan area, but shares its line with the currency
  // designation on the right — and has no vertical room to wrap (the MICR band
  // is 0.14in below it), so it is capped and clipped to one line.
  memo: { left: 0.70, aboveMicr: 0.14, size: 9.5, probeWidth: 3.2, widthTo: 'currencyNote', nowrap: true, clip: true },
  // Only printed when the stock does NOT already carry its number.
  chequeNo: { right: 0.62, top: 0.20, align: 'right', size: 11, probeWidth: 1.0 },
  // §11: a currency designation belongs BELOW the convenience amount
  // rectangle with at least 0.25in of clear space — never beside the figures.
  currencyNote: { right: 0.62, aboveMicr: 0.14, align: 'right', size: 8.5, probeWidth: 1.4 },
};

const mmToIn = (mm) => (Number(mm) || 0) / 25.4;

/** Merge a sparse per-account override map over the spec defaults. */
function resolveLayout(overrides) {
  const out = {};
  for (const [field, base] of Object.entries(DEFAULT_PREPRINTED_LAYOUT)) {
    out[field] = { ...base, ...((overrides && overrides[field]) || {}) };
  }
  return out;
}

/** Where the top of a field sits, in inches from the cheque band's top. */
function fieldTopIn(f, bandHeightIn) {
  const lineIn = (f.size || 11) * 1.25 / 72;
  const amountCentreTop = bandHeightIn - AMOUNT_CENTRE_FROM_BOTTOM_IN;
  if (f.top !== undefined) return f.top;
  // Centred on the spec's vertical centre for the amount rectangle.
  if (f.bottomCentre !== undefined) return bandHeightIn - f.bottomCentre - lineIn / 2;
  // Anchored to the amount line, so the gap survives a different band height.
  if (f.belowAmount !== undefined) return amountCentreTop + lineIn / 2 + f.belowAmount;
  // Anchored to the MICR band, which is the one place nothing may print.
  if (f.aboveMicr !== undefined) return bandHeightIn - CPA.micrBandIn - f.aboveMicr - lineIn;
  return 0;
}

/**
 * Room reserved on the right for the currency designation, so a long memo
 * cannot run into it. "U.S. FUNDS" is the longest form this prints.
 */
const CURRENCY_NOTE_RESERVE_IN = 1.5;

/**
 * Turn a symbolic width into inches. Derived from the CPA constants rather
 * than hardcoded, so the caps stay correct if the geometry is ever adjusted.
 */
function resolveWidth(f) {
  if (f.width !== undefined) return f.width;
  if (f.widthTo === 'scanClear') {
    // Stop one clear area short of the amount scan area.
    return SHEET_WIDTH_IN - (f.left || 0) - CPA.amountScanWidthIn - CPA.clearAreaIn;
  }
  if (f.widthTo === 'currencyNote') {
    const noteLeft = SHEET_WIDTH_IN - (DEFAULT_PREPRINTED_LAYOUT.currencyNote.right || 0) - CURRENCY_NOTE_RESERVE_IN;
    return Math.max(noteLeft - (f.left || 0) - 0.15, 0.5);
  }
  return undefined;
}

// A field box, positioned inside the cheque band.
function fieldStyle(f, bandHeightIn) {
  const parts = [`top:${fieldTopIn(f, bandHeightIn).toFixed(4)}in`];
  if (f.left !== undefined) parts.push(`left:${f.left}in`);
  if (f.right !== undefined) parts.push(`right:${f.right}in`);
  const w = resolveWidth(f);
  if (w !== undefined) parts.push(`width:${Number(w).toFixed(4)}in`);
  if (f.clip) parts.push('overflow:hidden');
  parts.push(`font-size:${f.size || 11}pt`);
  if (f.bold) parts.push('font-weight:bold');
  if (f.align) parts.push(`text-align:${f.align}`);
  if (f.lineHeight) parts.push(`line-height:${f.lineHeight}`);
  if (f.nowrap) parts.push('white-space:nowrap');
  return parts.join(';');
}

/**
 * How tall a field may grow before it would print inside the MICR band.
 *
 * A long payee address is clipped rather than allowed to run into that strip:
 * a cheque with ink across its MICR line is rejected by the bank outright,
 * which is worse than an address missing its last line — and the alignment
 * sheet shows the box, so the operator can see the limit before printing.
 */
function maxHeightToMicr(f, bandHeightIn, stopAt) {
  // Stop at whatever comes first: the field printed below this one, or the
  // MICR band. A payee block that grows into the memo line is just as unusable
  // as one that grows into the MICR strip.
  const floor = stopAt !== undefined
    ? Math.min(stopAt, bandHeightIn - CPA.micrBandIn - 0.06)
    : bandHeightIn - CPA.micrBandIn - 0.06;
  return Math.max(floor - fieldTopIn(f, bandHeightIn), 0.15);
}

/** The payee block's ceiling: the memo line when there is one, else the MICR band. */
function payeeMaxHeight(layout, bandHeightIn, hasMemo) {
  const stopAt = hasMemo ? fieldTopIn(layout.memo, bandHeightIn) - 0.04 : undefined;
  return maxHeightToMicr(layout.payee, bandHeightIn, stopAt);
}

/**
 * The variable data of ONE cheque, positioned for pre-printed stock.
 * Returns only the printed fields — no borders, no labels, no bank marks.
 */
/**
 * Pick the largest payee font that fits the block, down to a floor.
 *
 * The band genuinely has little room here — on real stock the "to the order
 * of" area is about half an inch — and the payee's address is what shows
 * through the window envelope, so losing its last lines means the cheque
 * cannot be mailed. Shrinking first keeps the whole address in far more cases
 * than clipping at one fixed size; clipping stays as the backstop, because
 * printing into the MICR band would have the bank reject the cheque outright.
 *
 * Line counts are estimated from an average Arial advance width (~0.55em for
 * the mixed and upper case a payee name uses). An estimate is enough: it only
 * decides the font size, and the CSS cap still holds whatever it picks.
 */
const PAYEE_SIZE_LADDER = [11, 10, 9, 8, 7.5];

function fitPayeeSize(nameAndLines, widthIn, availableHeightIn, lineHeight) {
  for (const size of PAYEE_SIZE_LADDER) {
    const charsPerLine = Math.max(Math.floor((widthIn * 72) / (size * 0.55)), 8);
    const lines = nameAndLines.reduce(
      (n, text) => n + Math.max(Math.ceil(String(text).length / charsPerLine), 1),
      0
    );
    if ((lines * size * lineHeight) / 72 <= availableHeightIn) return size;
  }
  return PAYEE_SIZE_LADDER[PAYEE_SIZE_LADDER.length - 1];
}

function preprintedChequeBand(cheque, spec, layout) {
  const bandH = spec.chequeHeightIn;
  const words = cheque.amountInWords || amountToWords(cheque.amount);
  const addressLines = String(cheque.payeeAddress || '')
    .split('\n').map((l) => l.trim()).filter(Boolean);

  // The words line must stop one clear area short of the amount scan area,
  // or a long payee amount would run into the box the bank's reader scans.
  const wordsRight = CPA.amountScanWidthIn + CPA.clearAreaIn;
  const wordsStyle = `${fieldStyle(layout.amountWords, bandH)};right:${wordsRight}in`;
  const currencyNote = currencyDesignation(cheque, spec);

  // Shrink the payee block to fit before letting the height cap clip it.
  const payeeRoom = payeeMaxHeight(layout, bandH, !!cheque.note);
  const payeeWidth = resolveWidth(layout.payee) || 4;
  const payeeSize = fitPayeeSize(
    [cheque.payeeName || '', ...addressLines],
    payeeWidth, payeeRoom, layout.payee.lineHeight || 1.32
  );
  const payeeStyle = `${fieldStyle({ ...layout.payee, size: payeeSize }, bandH)};max-height:${payeeRoom.toFixed(3)}in;overflow:hidden`;

  return `
    <div class="band" style="height:${bandH}in">
      <div class="f" style="${fieldStyle(layout.date, bandH)}">${esc(fmtChequeDateCPA(cheque.paymentDate, spec.dateFormat))}</div>
      <div class="f" style="${fieldStyle(layout.amountFigures, bandH)}">${esc(fmtAmountFiguresCPA(cheque.amount))}</div>
      <div class="f" style="${wordsStyle}">${esc(fmtAmountWordsCPA(words))}</div>
      ${currencyNote ? `<div class="f" style="${fieldStyle(layout.currencyNote, bandH)}">${esc(currencyNote)}</div>` : ''}
      <div class="f" style="${payeeStyle}">
        <div style="font-weight:bold">${esc(cheque.payeeName || '')}</div>
        ${addressLines.map((l) => `<div>${esc(l)}</div>`).join('')}
      </div>
      ${cheque.note ? `<div class="f" style="${fieldStyle(layout.memo, bandH)}">${esc(cheque.note)}</div>` : ''}
      ${spec.printChequeNumber ? `<div class="f" style="${fieldStyle(layout.chequeNo, bandH)}">${esc(cheque.chequeNo || '')}</div>` : ''}
      ${watermark(cheque)}
    </div>`;
}

/**
 * §11: "A currency designation is required on all US Dollar cheques drawn on a
 * domestic branch of a CPA member and encoded with a Canadian transit number."
 *
 * Printed whenever the cheque is not in the account's own currency, and always
 * for a US Dollar cheque — the case the standard names. Without it a USD
 * cheque drawn on a Canadian account is ambiguous about which dollars, and the
 * figures box cannot say so (alphabetic characters are banned in there).
 */
function currencyDesignation(cheque, spec) {
  const cur = String(cheque.currency || '').toUpperCase();
  if (!cur) return '';
  const accountCur = String(spec.currency || '').toUpperCase();
  if (cur === 'USD') return 'U.S. FUNDS';
  if (accountCur && cur !== accountCur) return `${cur} FUNDS`;
  return '';
}

function watermark(cheque) {
  if (cheque.status === 'void') return '<div class="void">VOID</div>';
  if (cheque.status === 'bounced') return '<div class="void">BOUNCED</div>';
  return '';
}

/**
 * A remittance stub. The stock's stubs are blank apart from a pre-printed
 * company name and cheque number, so this is the one place we have room to
 * say what the cheque actually paid for — which is the whole point of a stub
 * for the payee, and of the file copy for us.
 */
function preprintedStub(cheque, heightIn, applications, title) {
  const rows = (applications || []).map((a) => `
        <tr>
          <td>${esc(a.targetLabel || '')}</td>
          <td class="r">${esc(fmtAmount(a.amount, a.currency))}</td>
        </tr>`).join('');
  const applied = (applications || []).reduce((s, a) => s + Number(a.amount || 0), 0);
  const unapplied = Math.round((Number(cheque.amount || 0) - applied) * 100) / 100;

  return `
    <div class="band stub" style="height:${heightIn}in">
      <div class="stub-inner">
        <div class="stub-title">${esc(title)}</div>
        <table class="meta">
          <tr><td class="k">Date</td><td>${esc(fmtChequeDate(cheque.paymentDate))}</td>
              <td class="k">Cheque No.</td><td>${esc(cheque.chequeNo || '')}</td></tr>
          <tr><td class="k">Pay to</td><td colspan="3">${esc(cheque.payeeName || '')}</td></tr>
          ${cheque.referenceNo ? `<tr><td class="k">Reference</td><td colspan="3">${esc(cheque.referenceNo)}</td></tr>` : ''}
          ${(cheque.periodFrom || cheque.periodTo) ? `<tr><td class="k">Period</td><td colspan="3">${esc(fmtChequeDate(cheque.periodFrom))} to ${esc(fmtChequeDate(cheque.periodTo))}</td></tr>` : ''}
          ${cheque.note ? `<tr><td class="k">Memo</td><td colspan="3">${esc(cheque.note)}</td></tr>` : ''}
        </table>
        ${rows ? `<table class="apps">
          <tr><th>Applied to</th><th class="r">Amount</th></tr>${rows}
          ${unapplied > 0 ? `<tr class="unapplied"><td>Unapplied</td><td class="r">${esc(fmtAmount(unapplied, cheque.currency))}</td></tr>` : ''}
        </table>` : ''}
        <div class="stub-total">Cheque total <b>${esc(fmtAmount(cheque.amount, cheque.currency))}</b></div>
      </div>
    </div>`;
}

const PREPRINTED_CSS = `
  @page { margin: 0; size: Letter; }
  :root { color-scheme: light; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #ffffff; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; }
  .sheet { position: relative; width: 8.5in; height: 11in; overflow: hidden;
           break-after: page; page-break-after: always; }
  .sheet:last-child { break-after: auto; page-break-after: auto; }
  /* The whole sheet is nudged as one — printer feed drift moves every field
     by the same amount, so correcting it per field would be wrong. */
  .nudge { position: absolute; top: 0; left: 0; width: 8.5in; height: 11in; }
  .band { position: relative; width: 8.5in; }
  .f { position: absolute; }
  .fill { letter-spacing: 1px; }
  .stub-inner { position: absolute; top: 0.95in; left: 0.62in; right: 0.62in; font-size: 9.5pt; }
  .stub-title { font-size: 8pt; letter-spacing: .09em; text-transform: uppercase; color: #555;
                border-bottom: 1px solid #bbb; padding-bottom: 3px; margin-bottom: 7px; }
  table.meta { border-collapse: collapse; margin-bottom: 8px; }
  table.meta td { padding: 1.5px 14px 1.5px 0; vertical-align: top; }
  table.meta td.k { color: #555; font-size: 8pt; text-transform: uppercase;
                    letter-spacing: .05em; white-space: nowrap; }
  table.apps { border-collapse: collapse; width: 100%; max-width: 5.2in; margin-bottom: 8px; }
  table.apps th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: .05em;
                  color: #555; border-bottom: 1px solid #bbb; padding: 2px 0; }
  table.apps td { padding: 1.5px 0; border-bottom: 1px solid #eee; }
  table.apps .r, table.apps th.r { text-align: right; }
  table.apps tr.unapplied td { color: #666; font-style: italic; }
  .stub-total { margin-top: 6px; font-size: 10pt; }
  .void { position: absolute; top: 45%; left: 50%;
          transform: translate(-50%, -50%) rotate(-18deg);
          font-size: 58px; font-weight: 900; color: rgba(200,30,30,0.30); letter-spacing: 12px; }
`;

/**
 * One sheet of pre-printed stock per cheque: the cheque band in its configured
 * position, remittance stubs in the remaining bands.
 *
 * `entries` is [{cheque, spec, applications}] — spec comes from
 * BankAccount#printSpec(), so a batch spanning two accounts prints each
 * cheque against its own stock.
 */
function buildPreprintedSheetsHtml(entries) {
  const SHEET_H = 11;
  const sheets = (entries || []).map(({ cheque, spec, applications, layoutOverrides }) => {
    const layout = resolveLayout(layoutOverrides);
    const bandH = spec.chequeHeightIn;
    const bandTop = spec.bandTopIn;
    const cheque_ = preprintedChequeBand(cheque, spec, layout);

    // The bands the cheque does not occupy are stubs, split evenly.
    const above = bandTop;
    const below = SHEET_H - bandTop - bandH;
    const bands = [];
    if (above > 0.5) bands.push(preprintedStub(cheque, above, applications, 'Remittance advice'));
    bands.push(cheque_);
    if (below > 0.5) {
      // Two stubs when there is room for two, which is the common 3-band stock.
      if (below > 5) {
        const half = below / 2;
        bands.push(preprintedStub(cheque, half, applications, 'Remittance advice — payee copy'));
        bands.push(preprintedStub(cheque, half, applications, 'Office copy'));
      } else {
        bands.push(preprintedStub(cheque, below, applications, 'Remittance advice'));
      }
    }

    const dx = mmToIn(spec.offsetXmm);
    const dy = mmToIn(spec.offsetYmm);
    return `<div class="sheet"><div class="nudge" style="transform:translate(${dx.toFixed(4)}in,${dy.toFixed(4)}in)">${bands.join('')}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><style>${PREPRINTED_CSS}</style></head>
<body>${sheets}</body></html>`;
}

/**
 * The alignment sheet — printed on PLAIN paper, then held against a real
 * cheque up to the light. It shows exactly where each field will land, so the
 * operator can measure the drift and type it in as a nudge.
 *
 * This exists because cheque stock is numbered: every misfed sheet is a void
 * cheque that has to be recorded and destroyed. Calibrating on plain paper
 * costs nothing.
 */
function buildAlignmentSheetHtml(spec, layoutOverrides, account) {
  const SHEET_H = 11;
  const SHEET_W = 8.5;
  const layout = resolveLayout(layoutOverrides);
  const bandH = spec.chequeHeightIn;
  const bandTop = spec.bandTopIn;

  const sample = {
    paymentDate: new Date(),
    amount: 2520,
    currency: 'CAD',
    amountInWords: amountToWords(2520),
    payeeName: 'SAMPLE PAYEE INC.',
    payeeAddress: '123 Sample Street\nBrampton ON L6T 3T6',
    note: 'Alignment test — not a payment',
    chequeNo: '0000',
  };

  const box = (field, label) => {
    const f = layout[field];
    // Draw the box at the width the field will actually be capped to, so the
    // operator sees the real limit rather than a decorative outline.
    const real = resolveWidth(f);
    const w = real !== undefined ? '' : (f.probeWidth ? `width:${f.probeWidth}in;` : '');
    // The payee box is drawn at its real clipping height, so the operator can
    // see how many address lines actually fit above the MICR band.
    const h = field === 'payee' ? `height:${payeeMaxHeight(layout, bandH, true).toFixed(3)}in;` : '';
    return `<div class="probe" style="${fieldStyle(f, bandH)};${w}${h}"><span class="tag">${esc(label)}</span></div>`;
  };

  // Inch rulers down the left edge and across the top, so a field that lands
  // wrong can be measured rather than estimated.
  const ticks = [];
  for (let i = 0; i <= SHEET_H; i += 0.25) {
    const major = Number.isInteger(i);
    ticks.push(`<div class="tickY ${major ? 'maj' : ''}" style="top:${i}in">${major ? `<span>${i}"</span>` : ''}</div>`);
  }
  for (let i = 0; i <= SHEET_W; i += 0.25) {
    const major = Number.isInteger(i);
    ticks.push(`<div class="tickX ${major ? 'maj' : ''}" style="left:${i}in">${major ? `<span>${i}"</span>` : ''}</div>`);
  }

  const dx = mmToIn(spec.offsetXmm);
  const dy = mmToIn(spec.offsetYmm);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><style>
  ${PREPRINTED_CSS}
  .rule { position: absolute; inset: 0; }
  .tickY { position: absolute; left: 0; width: 0.16in; border-top: 0.5px solid #c8c8c8; }
  .tickY.maj { width: 0.34in; border-top: 1px solid #666; }
  .tickY span { position: absolute; left: 0.37in; top: -5px; font-size: 6.5pt; color: #666; }
  .tickX { position: absolute; top: 0; height: 0.16in; border-left: 0.5px solid #c8c8c8; }
  .tickX.maj { height: 0.34in; border-left: 1px solid #666; }
  .tickX span { position: absolute; top: 0.02in; left: 2px; font-size: 6.5pt; color: #666; }
  .bandline { position: absolute; left: 0; width: 8.5in; border-top: 1.5px dashed #d33; }
  .bandline span { position: absolute; right: 0.1in; top: -13px; font-size: 7.5pt; color: #d33; }
  .micr { position: absolute; left: 0; width: 8.5in; background: rgba(210,40,40,0.09);
          border-top: 1px dotted #d33; }
  .micr span { position: absolute; left: 0.6in; top: 3px; font-size: 7pt; color: #a22; }
  .scan { position: absolute; border: 1px dashed #2a7; }
  .scan span { position: absolute; left: 3px; top: -13px; font-size: 7pt; color: #2a7; }
  .probe { outline: 1px dashed #46c; background: rgba(70,100,200,0.07); min-height: 0.15in; }
  .probe .tag { position: absolute; top: -0.15in; left: 0; font-size: 6pt; color: #46c;
                letter-spacing: .04em; white-space: nowrap; font-weight: bold; }
  .hdr { position: absolute; left: 0.55in; right: 0.55in; font-size: 8.5pt; color: #333; }
  .hdr h1 { font-size: 12pt; margin-bottom: 4px; }
  .hdr p { margin: 2px 0; line-height: 1.4; }
  .hdr b { color: #000; }
</style></head>
<body>
  <div class="sheet">
    <div class="rule">${ticks.join('')}</div>

    <div class="nudge" style="transform:translate(${dx.toFixed(4)}in,${dy.toFixed(4)}in)">
      <!-- Where the cheque band is expected to be -->
      <div class="bandline" style="top:${bandTop}in"><span>cheque band TOP — ${bandTop}"</span></div>
      <div class="bandline" style="top:${bandTop + bandH}in"><span>cheque band BOTTOM — ${(bandTop + bandH).toFixed(2)}"</span></div>
      <div class="micr" style="top:${(bandTop + bandH - CPA.micrBandIn).toFixed(3)}in;height:${CPA.micrBandIn}in">
        <span>MICR band (5/8") — nothing prints here</span>
      </div>
      <div class="scan" style="top:${(bandTop + bandH - CPA.amountUpperFromBottomIn).toFixed(3)}in;
                               height:${(CPA.amountUpperFromBottomIn - CPA.amountLowerFromBottomIn).toFixed(3)}in;
                               right:0in;width:${CPA.amountScanWidthIn}in">
        <span>CPA convenience amount scan area</span>
      </div>

      <div class="band" style="position:absolute;top:${bandTop}in;height:${bandH}in">
        ${box('date', 'DATE')}
        ${box('amountFigures', 'AMOUNT IN FIGURES')}
        ${box('amountWords', 'AMOUNT IN WORDS')}
        ${box('payee', 'PAYEE NAME + ADDRESS')}
        ${box('memo', 'MEMO')}
        ${box('currencyNote', 'CURRENCY — only when not the account&rsquo;s own')}
        ${spec.printChequeNumber ? box('chequeNo', 'CHEQUE NO.') : ''}
        <div class="f" style="${fieldStyle(layout.date, bandH)};color:#111">${esc(fmtChequeDateCPA(sample.paymentDate, spec.dateFormat))}</div>
        <div class="f" style="${fieldStyle(layout.amountFigures, bandH)};color:#111">${esc(fmtAmountFiguresCPA(sample.amount))}</div>
        <div class="f" style="${fieldStyle(layout.amountWords, bandH)};right:${CPA.amountScanWidthIn + CPA.clearAreaIn}in;color:#111">${esc(fmtAmountWordsCPA(sample.amountInWords))}</div>
        <div class="f" style="${fieldStyle(layout.payee, bandH)};max-height:${payeeMaxHeight(layout, bandH, true).toFixed(3)}in;overflow:hidden;color:#111">
          <div style="font-weight:bold">${esc(sample.payeeName)}</div>
          ${sample.payeeAddress.split('\n').map((l) => `<div>${esc(l)}</div>`).join('')}
        </div>
        <div class="f" style="${fieldStyle(layout.memo, bandH)};color:#111">${esc(sample.note)}</div>
      </div>
    </div>

    <div class="hdr" style="top:${bandTop + bandH + 0.45}in">
      <h1>Cheque alignment test — ${esc(account?.name || 'this account')}</h1>
      <p><b>This is plain paper. Do not load cheque stock to print this.</b></p>
      <p>1. Hold this sheet on top of one blank cheque, both against a window or a lamp.</p>
      <p>2. The dashed blue boxes are where each field will print. The green box is where the bank's
         amount-scan area must be, and the red band is the MICR strip that must stay clear.</p>
      <p>3. If everything sits low by (say) 3&nbsp;mm, set <b>Vertical nudge = &minus;3</b>. If it sits
         right by 2&nbsp;mm, set <b>Horizontal nudge = &minus;2</b>. Use the inch rulers to measure.</p>
      <p>4. Print this test again and re-check. Only then print a real cheque.</p>
      <p style="margin-top:8px"><b>Check the date order against the guidance boxes on your cheque.</b>
         This prints <b>${esc(spec.dateFormat || 'YYYYMMDD')}</b> as
         <b>${esc(fmtChequeDateCPA(sample.paymentDate, spec.dateFormat))}</b>. CPA&nbsp;006 allows
         YYYYMMDD, MMDDYYYY or DDMMYYYY — never slashes, never a two-digit year.</p>
      <p style="margin-top:8px">Current settings — cheque band: <b>${esc(spec.chequePosition)}</b>,
         height <b>${spec.chequeHeightIn}"</b>, nudge <b>${spec.offsetXmm}&nbsp;mm</b> across /
         <b>${spec.offsetYmm}&nbsp;mm</b> down.</p>
    </div>
  </div>
</body></html>`;
}

module.exports.buildPreprintedSheetsHtml = buildPreprintedSheetsHtml;
module.exports.buildAlignmentSheetHtml = buildAlignmentSheetHtml;
module.exports.DEFAULT_PREPRINTED_LAYOUT = DEFAULT_PREPRINTED_LAYOUT;
module.exports.CPA = CPA;
module.exports.fitPayeeSize = fitPayeeSize;
module.exports.DATE_FORMATS = DATE_FORMATS;
module.exports.fmtChequeDateCPA = fmtChequeDateCPA;
module.exports.fmtAmountFiguresCPA = fmtAmountFiguresCPA;
module.exports.fmtAmountWordsCPA = fmtAmountWordsCPA;
module.exports.currencyDesignation = currencyDesignation;
