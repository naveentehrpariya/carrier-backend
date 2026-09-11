'use strict';
/**
 * Shared machinery for fuel price sheet parsers.
 *
 * Design rules (do not soften these — they are what makes a parsed sheet trustworthy):
 *
 * 1. MONEY IS INTEGER. Every price is stored as an integer number of micro-units
 *    (1e-6 of a dollar / cent / whatever the sheet's unit is). 350 rows of float
 *    arithmetic drifts; integers do not. `dp` travels with the value so the output
 *    prints exactly as many decimals as the vendor printed.
 * 2. NOTHING IS SILENTLY DROPPED. A parser returns `rows`, `warnings` AND
 *    `unparsed`. Any line that looks like data but did not become a row lands in
 *    `unparsed`, and the caller must refuse to publish while that list is non-empty.
 * 3. THE VENDOR'S OWN ARITHMETIC VERIFIES THE PARSE. Every vendor sheet carries a
 *    tax identity (total = base + gst + pst, savings = retail - actual, ...). If a
 *    row's numbers were read out of the wrong columns the identity breaks. This is a
 *    stronger check than any regex, so it runs on every row.
 * 4. TWO INDEPENDENT READINGS MUST AGREE. Columns are read from text geometry
 *    (x/y coordinates) and, separately, by a regex over the flattened line. A
 *    disagreement flags the row instead of picking a winner.
 */

const SCALE = 1000000; // micro-units per whole unit

/** Round-half-up division, used only where a rate has to be applied. */
function divRound(n, d) {
  if (d === 0) throw new Error('divRound by zero');
  const neg = (n < 0) !== (d < 0);
  const a = Math.abs(n);
  const b = Math.abs(d);
  const q = Math.floor(a / b);
  const r = a - q * b;
  const up = r * 2 >= b ? 1 : 0;
  const out = q + up;
  return neg ? -out : out;
}

/**
 * (a * b) / d, rounded half-up, computed in BigInt.
 *
 * Doing this in doubles overflows silently: on the AVAAL feed prices are CENTS per
 * litre, so a base of 263.34 is 263,340,000 micro-units, and a 100% percent margin
 * (100 * SCALE) makes the product 2.6e16 — past Number.MAX_SAFE_INTEGER, where the
 * multiply loses precision without raising anything. That would write a wrong tax or
 * a wrong margin onto a sheet that goes to a customer, which is exactly the failure
 * this feature exists to remove. The result itself is always small, so it is returned
 * as a Number, and a result that would NOT be exact is refused instead of rounded.
 */
function mulDivRound(a, b, d) {
  if (!d) throw new Error('mulDivRound by zero');
  const sign = Math.sign(a || 1) * Math.sign(b || 1) * Math.sign(d);
  const A = BigInt(Math.abs(Math.round(a)));
  const B = BigInt(Math.abs(Math.round(b)));
  const D = BigInt(Math.abs(Math.round(d)));
  const num = A * B;
  const q = num / D;
  const r = num - q * D;
  const out = q + (r * 2n >= D ? 1n : 0n);
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) {
    const err = new Error('That margin produces a price too large to represent exactly.');
    err.code = 'price_out_of_range';
    throw err;
  }
  return Number(out) * (sign < 0 ? -1 : 1);
}

/**
 * Parse a money-ish token into integer micro-units.
 * Accepts: "195.50", "$ 195.50", "$195.50", "2.0090", "-", "$ -", "(1.25)", "1,234.56"
 * A dash is how these sheets print zero — it is a real zero, not a missing value.
 * Returns null when the token carries no number at all (caller decides if that is fatal).
 */
function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/\$/g, '').replace(/,/g, '').trim();
  if (s === '-' || s === '--' || s === '–' || s === '—') return { int: 0, dp: 2, text: '-' };
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const dp = frac.length;
  const digits = (whole + frac.padEnd(6, '0').slice(0, 6)).replace(/^0+(?=\d)/, '');
  if (frac.length > 6) return null; // more precision than we model — refuse rather than round silently
  const int = Number(digits);
  if (!Number.isSafeInteger(int)) return null;
  return { int: neg ? -int : int, dp, text: String(raw).trim() };
}

/** Turn a JS number that came from a spreadsheet cell into integer micro-units. */
function numberToMoney(value, dp) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, '').trim());
  if (!Number.isFinite(n)) return null;
  const int = Math.round(n * SCALE);
  if (!Number.isSafeInteger(int)) return null;
  return { int, dp: dp === undefined ? 4 : dp, text: String(value) };
}

function fmtMoney(int, dp) {
  if (int === null || int === undefined) return '';
  const neg = int < 0;
  const a = Math.abs(int);
  const whole = Math.floor(a / SCALE);
  const frac = String(a % SCALE).padStart(6, '0').slice(0, dp);
  return `${neg ? '-' : ''}${whole}${dp > 0 ? '.' + frac : ''}`;
}

/** Absolute difference in micro-units. */
function diff(a, b) { return Math.abs((a || 0) - (b || 0)); }

/**
 * Load the spreadsheet reader on FIRST USE, never at require time.
 *
 * `index.js` mounts the fuel routes at boot, so a top-level `require('xlsx')` made
 * the whole backend fail to start with MODULE_NOT_FOUND whenever the dependency was
 * missing — a deploy that skipped `npm install`, for instance. Every route then 502s,
 * including login, and the outage looks nothing like a fuel problem. One feature's
 * dependency must not be able to take authentication down.
 */
function loadXlsx() {
  try {
    // eslint-disable-next-line global-require
    return require('xlsx');
  } catch (e) {
    const err = new Error('Spreadsheets cannot be read on this server: the "xlsx" package is not installed. Run npm install in backend/ and restart. PDF sheets are unaffected.');
    err.code = 'xlsx_missing';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PDF text geometry
// ---------------------------------------------------------------------------

/**
 * Read a PDF into y-banded text items with x positions.
 * pdfjs hands back one item per drawn text run, which for these vendor sheets is
 * exactly one table cell — so a band (items sharing a baseline) is a visual row.
 */
async function extractPdfBands(buffer, { yTolerance = 2 } = {}) {
  // eslint-disable-next-line global-require
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(buffer);
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  } catch (e) {
    // A file we cannot open is never "an empty sheet" — say so with a code the API
    // can turn into a message, instead of letting a library error reach the user.
    const err = new Error(`This PDF could not be opened (${e.message}). It may be corrupt or password-protected.`);
    err.code = 'pdf_unreadable';
    throw err;
  }
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const raw = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        raw.push({
          x: it.transform[4],
          y: it.transform[5],
          w: it.width || 0,
          str: it.str.trim(),
        });
      }
      raw.sort((a, b) => (b.y - a.y) || (a.x - b.x));
      const bands = [];
      for (const it of raw) {
        const last = bands[bands.length - 1];
        if (last && Math.abs(last.y - it.y) <= yTolerance) {
          last.items.push(it);
          last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
        } else {
          bands.push({ y: it.y, items: [it] });
        }
      }
      bands.forEach((b) => {
        b.items.sort((a, c) => a.x - c.x);
        b.page = p;
        b.text = b.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      });
      pages.push({ pageNo: p, bands });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/** All bands, all pages, top-to-bottom, page order preserved. */
function flatBands(pages) {
  const out = [];
  pages.forEach((pg) => pg.bands.forEach((b) => out.push(b)));
  return out;
}

function fullText(pages) {
  return flatBands(pages).map((b) => b.text).join('\n');
}

/**
 * Assign every item of a band to a declared column by x range.
 * Returns { cols: {key: [items]}, stray: [items] }.
 * `stray` is the whole point: an item that falls outside every declared column means
 * the template moved, and the parser must say so instead of guessing.
 */
function splitByColumns(band, columns) {
  const cols = {};
  const stray = [];
  columns.forEach((c) => { cols[c.key] = []; });
  for (const it of band.items) {
    const mid = it.x + (it.w || 0) / 2;
    const hit = columns.find((c) => it.x >= c.xMin - 0.5 && (mid <= c.xMax || it.x <= c.xMax));
    if (hit) cols[hit.key].push(it);
    else stray.push(it);
  }
  return { cols, stray };
}

function joinCol(items) {
  return items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Group bands into logical rows.
 *
 * A band is an ANCHOR when `isAnchor(cols, band)` says so (typically: it carries a
 * site number and a price). A band that is not an anchor but whose every item sits
 * in one of `wrapKeys` is a CONTINUATION — a wrapped address, or a product name the
 * vendor printed across two lines — and is merged into the nearest anchor.
 *
 * Anything else is returned in `noise` for the caller to classify as header/footer
 * (harmless) or unparsed data (fatal).
 */
function groupRows(pages, { columns, isAnchor, wrapKeys = [], maxWrapDistance = 14 }) {
  const bands = flatBands(pages);
  const prepared = bands.map((band) => {
    const { cols, stray } = splitByColumns(band, columns);
    return { band, cols, stray };
  });

  const anchors = [];
  const pending = [];
  const noise = [];

  prepared.forEach((entry) => {
    if (entry.stray.length === 0 && isAnchor(entry.cols, entry.band)) {
      anchors.push({ ...entry, extras: [] });
      return;
    }
    const keys = Object.keys(entry.cols).filter((k) => entry.cols[k].length);
    const isWrap = entry.stray.length === 0 && keys.length > 0 && keys.every((k) => wrapKeys.includes(k));
    if (isWrap) pending.push(entry);
    else noise.push(entry);
  });

  // attach each continuation band to the nearest anchor on the same page
  pending.forEach((entry) => {
    let best = null;
    let bestDist = Infinity;
    anchors.forEach((a) => {
      if (a.band.page !== entry.band.page) return;
      const d = Math.abs(a.band.y - entry.band.y);
      if (d < bestDist) { bestDist = d; best = a; }
    });
    if (best && bestDist <= maxWrapDistance) best.extras.push(entry);
    else noise.push(entry);
  });

  // merge: top-to-bottom so a two-line product/address reads in printed order
  const rows = anchors.map((a) => {
    const group = [a, ...a.extras].sort((x, y) => y.band.y - x.band.y);
    const merged = {};
    columns.forEach((c) => {
      const parts = [];
      group.forEach((g) => { const t = joinCol(g.cols[c.key]); if (t) parts.push(t); });
      merged[c.key] = parts.join(' ').replace(/\s+/g, ' ').trim();
    });
    return {
      values: merged,
      anchorText: a.band.text,
      page: a.band.page,
      y: a.band.y,
      lines: group.map((g) => g.band.text),
      rawLine: group.map((g) => g.band.text).join(' | '),
    };
  });

  return { rows, noise };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** A line that carries several numbers is data. If we did not parse it, that is fatal. */
function looksLikeData(text, { minNumbers = 3 } = {}) {
  const nums = String(text).match(/\d+\.\d+/g) || [];
  return nums.length >= minNumbers;
}

/**
 * Check one row against the vendor's own arithmetic.
 * `identity` = { label, left: [keys], right: [keys], tolerance }  →  Σleft == Σright
 */
function checkIdentity(money, identity) {
  const sum = (keys) => keys.reduce((acc, k) => {
    const v = money[k];
    if (!v) return acc;
    return acc + v.int;
  }, 0);
  const left = sum(identity.left);
  const right = sum(identity.right);
  const delta = Math.abs(left - right);
  return {
    ok: delta <= (identity.tolerance || 0),
    label: identity.label,
    delta,
    left,
    right,
  };
}

/** Collector so every parser reports warnings in one shape. */
function makeLedger() {
  const warnings = [];
  const unparsed = [];
  return {
    warnings,
    unparsed,
    warn(code, message, context) { warnings.push({ code, message, context: context || null }); },
    dropped(text, context) { unparsed.push({ text, context: context || null }); },
    result(extra) {
      return Object.assign({ warnings, unparsed }, extra);
    },
  };
}


// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A fuel sheet's effective date is a CALENDAR date, so it is returned as a bare
 * "YYYY-MM-DD" string and never as a Date — the same rule the cheque and document
 * expiry dates follow. Timezone maths on a printed date is how a sheet dated the 9th
 * ends up filed on the 8th.
 * Handles: "September 9, 2026", "September 9th, 2026", "09/04/2026", "2026-08-24".
 */
function parseLooseDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  return null;
}

module.exports = {
  SCALE,
  divRound,
  mulDivRound,
  parseMoney,
  numberToMoney,
  fmtMoney,
  diff,
  extractPdfBands,
  flatBands,
  fullText,
  splitByColumns,
  joinCol,
  groupRows,
  looksLikeData,
  checkIdentity,
  makeLedger,
  parseLooseDate,
  loadXlsx,
};
