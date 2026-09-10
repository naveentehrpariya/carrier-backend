'use strict';
/**
 * Last-resort parser: read ANY tabular price sheet.
 *
 * The four named vendor parsers know their file exactly and verify it against the
 * vendor's own arithmetic. This one knows nothing, so it does the opposite: it works
 * out the table shape, reads every cell as text or number, and then REFUSES TO GUESS
 * which column is the price. A person picks that on screen (`/fuel/sheets/:id/mapping`)
 * and until they do, the sheet cannot be published.
 *
 * That split is deliberate. A sheet we recognise is trustworthy without anyone
 * checking it; a sheet we do not recognise is readable but unverified, and the screen
 * says so. What must never happen is a margin quietly landing on the wrong column.
 */

const XLSX = require('xlsx');
const {
  extractPdfBands, flatBands, fullText, parseMoney, numberToMoney,
  parseLooseDate, makeLedger, looksLikeData,
} = require('./shared');

const MAX_COLUMNS = 24;
const MIN_TABLE_ROWS = 3;

const spec = {
  vendor: 'generic',
  label: 'Other price sheet',
  fileTypes: ['pdf', 'xlsx', 'xls', 'csv'],
  // Nothing here is known until a person confirms it on screen.
  unit: null,
  currency: null,
  dp: null,
  baseColumn: null,
  generic: true,
};

// ---------------------------------------------------------------------------
// column discovery (PDF): cluster text items by x
// ---------------------------------------------------------------------------

/**
 * Group every text item on the page by its x position. Vendor tables are printed on a
 * grid, so the gaps between clusters ARE the column boundaries — no template needed.
 */
/**
 * A lone currency symbol or dash is not a column.
 * Vendors print money as two text runs — a "$" and the number — a few points apart,
 * which reads as two clusters and then merges the real money column into its
 * neighbour. Symbols are dropped from column discovery and folded into whichever cell
 * they touch when the row is assembled (parseMoney strips them anyway).
 */
const SYMBOL_ONLY = /^[$€£₹¥\s]*[-–—]?[$€£₹¥\s]*$/;
const isSymbol = (s) => SYMBOL_ONLY.test(String(s || ''));

function discoverColumns(bands) {
  const items = [];
  bands.forEach((b) => b.items.forEach((it) => {
    // banner lines span the page and would swallow every column
    if (it.str.length > 45) return;
    if (isSymbol(it.str)) return;
    items.push(it);
  }));
  if (!items.length) return [];

  items.sort((a, b) => a.x - b.x);
  const clusters = [];
  let cur = [items[0]];
  for (let i = 1; i < items.length; i += 1) {
    const gap = items[i].x - (cur[cur.length - 1].x);
    if (gap <= 8) cur.push(items[i]);
    else { clusters.push(cur); cur = [items[i]]; }
  }
  clusters.push(cur);

  // A column has to appear on many rows; a one-off label is not a column.
  const strong = clusters.filter((c) => c.length >= Math.max(3, Math.round(bands.length * 0.25)));
  const use = (strong.length >= 2 ? strong : clusters).slice(0, MAX_COLUMNS);

  return use.map((c, i) => {
    const xs = c.map((o) => o.x);
    const xe = c.map((o) => o.x + (o.w || 0));
    return {
      key: `col${i + 1}`,
      xMin: Math.min(...xs) - 4,
      xMax: Math.max(...xe) + 4,
      samples: c.slice(0, 40).map((o) => o.str),
    };
  });
}

/**
 * Turn clusters into non-overlapping columns by where each one STARTS.
 *
 * Ranges cannot simply be merged when they overlap: in a left-aligned table a long
 * value legitimately runs into the next column's space, and merging on overlap chains
 * every text column into one. A cell belongs to the last column that starts at or
 * before it, which is how a person reads the table too.
 */
function separate(cols) {
  const sorted = cols.slice().sort((a, b) => a.xMin - b.xMin);
  return sorted.map((c, i) => ({
    key: `col${i + 1}`,
    xMin: c.xMin,
    // up to (not into) the next column's start; the last column runs to the edge
    xMax: i + 1 < sorted.length ? sorted[i + 1].xMin - 0.01 : Number.MAX_SAFE_INTEGER,
    samples: c.samples,
  }));
}

const isNumeric = (s) => parseMoney(s) !== null;

/** A column is a money column when most of its values read as numbers. */
function classify(samples) {
  const vals = samples.filter((s) => String(s).trim());
  if (!vals.length) return 'text';
  const nums = vals.filter(isNumeric).length;
  return nums / vals.length >= 0.7 ? 'money' : 'text';
}

/**
 * The header row: the last band above the data whose cells are mostly non-numeric.
 * Used only for column LABELS — never to decide what a column means.
 */
function labelsFrom(bands, cols) {
  for (const band of bands) {
    const cells = cols.map((c) => band.items.filter((it) => it.x >= c.xMin && it.x <= c.xMax).map((it) => it.str).join(' ').trim());
    const filled = cells.filter(Boolean);
    if (filled.length < Math.max(2, Math.round(cols.length * 0.5))) continue;
    const numeric = filled.filter(isNumeric).length;
    if (numeric === 0) return cells;
  }
  return cols.map(() => '');
}

async function parsePdf(buffer, opts, led) {
  const pages = await extractPdfBands(buffer);
  const bands = flatBands(pages);
  const text = fullText(pages);
  if (!text.trim()) {
    const err = new Error('This PDF contains no text — it is a scan or an image, so its prices cannot be read. Ask the vendor for the original PDF or a spreadsheet.');
    err.code = 'pdf_has_no_text';
    throw err;
  }

  const cols = separate(discoverColumns(bands));
  if (cols.length < 2) {
    const err = new Error('No price table could be found in this PDF.');
    err.code = 'no_table_found';
    throw err;
  }

  const labels = labelsFrom(bands, cols);
  const columns = cols.map((c, i) => ({
    key: c.key,
    label: (labels[i] || '').replace(/\s+/g, ' ').trim() || `Column ${i + 1}`,
    kind: classify(c.samples),
    role: 'info',
    xMin: c.xMin,
    xMax: c.xMax,
  }));

  // a data row is a band that fills several columns and carries at least one number
  const rows = [];
  bands.forEach((band) => {
    const cells = {};
    let filled = 0;
    let numbers = 0;
    let stray = 0;
    band.items.forEach((it) => {
      const hit = columns.find((c) => it.x >= c.xMin && it.x <= c.xMax);
      if (!hit) {
        if (it.str.length <= 45) stray += 1;
        return;
      }
      // A lone "$" or "-" carries no value: parseMoney strips a currency symbol
      // anyway, and a dash standing for zero is honestly reported as "no number seen
      // here" — which a tax column treats as nothing to add. Keeping them turned one
      // cell into "9.78 $ - $" and made a readable row unreadable.
      if (isSymbol(it.str)) return;
      cells[hit.key] = `${cells[hit.key] ? `${cells[hit.key]} ` : ''}${it.str}`.trim();
    });
    Object.keys(cells).forEach((k) => {
      filled += 1;
      if (isNumeric(cells[k])) numbers += 1;
    });
    if (filled < 2 || numbers < 1) return;
    if (stray > 0) {
      led.warn('column_outside_template', 'A value on this line did not fit the table.', { page: band.page, text: band.text });
      led.dropped(band.text, { page: band.page, reason: 'column_outside_template' });
      return;
    }
    rows.push({ cells, page: band.page, rawLine: band.text });
  });

  return { columns, rows, text, pages: pages.length };
}

function parseWorkbook(buffer, opts, led) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellText: true });
  const names = workbook.SheetNames || [];
  if (!names.length) {
    const err = new Error('This workbook has no sheets in it.');
    err.code = 'no_table_found';
    throw err;
  }

  let chosen = 0;
  if (opts.sheet !== undefined && opts.sheet !== null && opts.sheet !== '') {
    const byName = names.indexOf(String(opts.sheet));
    const byIndex = Number(opts.sheet);
    if (byName >= 0) chosen = byName;
    else if (Number.isInteger(byIndex) && byIndex >= 0 && byIndex < names.length) chosen = byIndex;
    else {
      const err = new Error(`This workbook has no sheet "${opts.sheet}".`);
      err.code = 'sheet_not_found';
      throw err;
    }
  }

  const ws = workbook.Sheets[names[chosen]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false, defval: null });
  if (!grid.length) {
    const err = new Error('That sheet is empty.');
    err.code = 'no_table_found';
    throw err;
  }

  // The header row is the one above the widest run of rows that carry numbers.
  const score = grid.map((r) => (r || []).filter((c) => c !== null && String(c).trim() !== '').length);
  const width = Math.max(...score);
  let headerIdx = 0;
  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i] || [];
    const cells = row.filter((c) => c !== null && String(c).trim() !== '');
    if (cells.length < Math.max(2, Math.round(width * 0.5))) continue;
    const numeric = cells.filter((c) => typeof c === 'number' || isNumeric(c)).length;
    if (numeric === 0) { headerIdx = i; break; }
  }

  const header = grid[headerIdx] || [];
  const colCount = Math.min(Math.max(width, header.length), MAX_COLUMNS);
  const columns = [];
  for (let i = 0; i < colCount; i += 1) {
    const samples = grid.slice(headerIdx + 1, headerIdx + 60).map((r) => (r || [])[i]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    columns.push({
      key: `col${i + 1}`,
      label: String(header[i] === null || header[i] === undefined ? '' : header[i]).replace(/\s+/g, ' ').trim() || `Column ${i + 1}`,
      kind: samples.length && samples.filter((v) => typeof v === 'number' || isNumeric(v)).length / samples.length >= 0.7 ? 'money' : 'text',
      role: 'info',
      sourceIndex: i,
    });
  }

  const rows = [];
  grid.slice(headerIdx + 1).forEach((r, i) => {
    const row = r || [];
    const cells = {};
    let filled = 0;
    let numbers = 0;
    columns.forEach((c) => {
      const v = row[c.sourceIndex];
      if (v === null || v === undefined || String(v).trim() === '') return;
      cells[c.key] = v;
      filled += 1;
      if (typeof v === 'number' || isNumeric(v)) numbers += 1;
    });
    if (filled < 2 || numbers < 1) return; // blank or separator row
    rows.push({ cells, sourceRow: headerIdx + 2 + i, rawLine: columns.map((c) => cells[c.key] ?? '').join(' | ') });
  });

  return {
    columns: columns.map(({ sourceIndex, ...c }) => c),
    rows,
    sheetName: names[chosen],
    sheetIndex: chosen,
    availableSheets: names.map((name, index) => ({ index, name, effectiveDate: null })),
    text: [ws.A1?.w, ws.A1?.v, ws.A2?.w, ws.A2?.v].filter(Boolean).join(' '),
  };
}

/**
 * @param {Buffer} buffer
 * @param {Object} [opts] { filename, sheet }
 */
async function parse(buffer, opts = {}) {
  const led = makeLedger();
  const ext = (/\.([a-z0-9]+)$/i.exec(String(opts.filename || '')) || [])[1];
  const isSpreadsheet = ext === 'xlsx' || ext === 'xls' || ext === 'csv';

  const read = isSpreadsheet ? parseWorkbook(buffer, opts, led) : await parsePdf(buffer, opts, led);

  if (read.rows.length < MIN_TABLE_ROWS) {
    const err = new Error(`Only ${read.rows.length} row(s) of prices could be found in this file. Check it is the right sheet.`);
    err.code = 'no_table_found';
    throw err;
  }

  const moneyCols = read.columns.filter((c) => c.kind === 'money');
  if (!moneyCols.length) {
    const err = new Error('No column of prices could be found in this file.');
    err.code = 'no_price_column';
    throw err;
  }

  // Build rows. EVERY money column is kept; which one is the price is a decision a
  // person makes later, not something inferred here.
  const rows = read.rows.map((r, idx) => {
    const money = {};
    const text = {};
    let unreadable = 0;
    read.columns.forEach((c) => {
      const raw = r.cells[c.key];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        if (c.kind === 'text') text[c.key] = '';
        return;
      }
      if (c.kind === 'money') {
        const v = typeof raw === 'number' ? numberToMoney(raw, 4) : parseMoney(raw);
        if (v) money[c.key] = v;
        else { unreadable += 1; text[c.key] = String(raw).trim(); }
      } else {
        text[c.key] = String(raw).trim();
      }
    });
    const row = {
      rowNo: idx + 1,
      page: r.page || 1,
      sourceRow: r.sourceRow,
      text,
      money,
      rawLine: r.rawLine,
      flags: [],
    };
    if (unreadable) {
      row.flags.push({ code: 'unreadable_number', message: `${unreadable} value(s) in this row are not numbers` });
    }
    return row;
  });

  // No vendor identity to check against, so say so plainly instead of implying trust.
  led.warn('unverified_layout',
    'This sheet is not one of the vendor layouts this app knows, so its columns were worked out from the file itself. Check the prices below against the original before sending anything out.',
    { columns: read.columns.length, rows: rows.length });

  return led.result({
    meta: {
      vendor: 'generic',
      label: spec.label,
      unit: null,
      currency: null,
      dp: null,
      generic: true,
      mappingRequired: true,
      effectiveDate: parseLooseDate(read.text || ''),
      sourceTitle: String(read.text || '').slice(0, 160),
      confidentialNotice: /CONFIDENTIAL/i.test(read.text || ''),
      sheetName: read.sheetName,
      sheetIndex: read.sheetIndex,
      availableSheets: read.availableSheets || [],
      candidateColumns: read.columns.filter((c) => c.kind === 'money').map((c) => c.key),
    },
    columns: read.columns.map((c) => ({ key: c.key, label: c.label, kind: c.kind, role: 'info' })),
    baseColumn: null,
    rows,
    stats: {
      pages: read.pages || 1,
      rows: rows.length,
      flagged: rows.filter((r) => r.flags.length).length,
      vendorRoundingDrift: 0,
      unparsed: led.unparsed.length,
    },
  });
}

module.exports = { spec, parse, discoverColumns, classify, looksLikeData };
