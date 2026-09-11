'use strict';
/**
 * Petro-Canada Petro-Pass price list — XLSX.
 *
 * CAD per litre, 4 decimals. The workbook holds ONE SHEET PER DAY (the sample file
 * carries "Aug. 24th Pricing" and "Aug. 25th - Pricing"), so a caller must say which
 * day it wants. Parsing the first sheet and ignoring the rest silently would publish
 * yesterday's prices under today's date, so every other sheet is reported in
 * `meta.availableSheets` and a warning is raised while more than one exists.
 *
 * Blank rows separate provinces and are expected — they are skipped, not flagged.
 *
 * Second, independent reading: XLSX gives both the stored number (`v`) and the text
 * Excel actually displays (`w`). Both are read and compared, which catches a column
 * whose displayed value has been rounded away from what is stored underneath.
 */


const { numberToMoney, parseMoney, parseLooseDate, checkIdentity, makeLedger, looksLikeData, loadXlsx } = require('./shared');

const columns = [
  { key: 'site_name', label: 'Site Name', kind: 'text',  col: 'A', role: 'info' },
  { key: 'region',    label: 'Prv',       kind: 'text',  col: 'B', role: 'info' },
  { key: 'price_ex_sales_tax', label: 'Price excl. GST/HST/PST', kind: 'money', col: 'C', role: 'base' },
  { key: 'fct_fet',   label: 'FCT + FET', kind: 'money', col: 'D', role: 'reference' },
  { key: 'cbn_pft_utt', label: 'CBN + PFT + UTT', kind: 'money', col: 'E', role: 'reference' },
  { key: 'base_ex_all_tax', label: 'Base price excl. tax', kind: 'money', col: 'F', role: 'reference' },
];

const IDENTITY = {
  label: 'Price excl. sales tax = Base excl. tax + FCT/FET + CBN/PFT/UTT',
  left: ['price_ex_sales_tax'],
  right: ['base_ex_all_tax', 'fct_fet', 'cbn_pft_utt'],
  tolerance: 100,
};

const spec = {
  vendor: 'petro_canada',
  label: 'Petro-Canada Petro-Pass',
  fileTypes: ['xlsx', 'xls'],
  unit: 'per_litre',
  currency: 'CAD',
  dp: 4,
  baseColumn: 'price_ex_sales_tax',
  taxColumns: [],
  totalColumn: null,
  columns,
};

function cellText(ws, ref) {
  const c = ws[ref];
  if (!c) return '';
  if (c.w !== undefined && c.w !== null) return String(c.w).trim();
  if (c.v === undefined || c.v === null) return '';
  return String(c.v).trim();
}

function cellRaw(ws, ref) {
  const c = ws[ref];
  if (!c || c.v === undefined || c.v === null || c.v === '') return null;
  return c.v;
}

function signature(workbook) {
  const names = workbook.SheetNames || [];
  for (const n of names) {
    const ws = workbook.Sheets[n];
    const head = ['A1', 'A2', 'A3'].map((r) => cellText(ws, r)).join(' ');
    if (/Petro-?Canada/i.test(head) && /Petro-?Pass/i.test(head)) return true;
  }
  return false;
}

function sheetMeta(ws) {
  const a1 = cellText(ws, 'A1');
  const a2 = cellText(ws, 'A2');
  const a3 = cellText(ws, 'A3');
  return {
    effectiveDate: parseLooseDate((/As of\s*:?\s*([^)]+)/i.exec(a2) || [])[1] || ''),
    createdOn: parseLooseDate((/Created on\s*:?\s*([^\s]+)/i.exec(a2) || [])[1] || ''),
    product: (/Product\s*:\s*(.+)$/i.exec(a3) || [])[1] || '',
    sourceTitle: a1,
    unitNotice: /Canadian \$\/Litre/i.test(a1) ? 'Canadian $/Litre' : '',
  };
}

/**
 * @param {Buffer} buffer
 * @param {Object} [opts]
 * @param {string|number} [opts.sheet] sheet name, or 0-based index. Defaults to the first.
 */
function parse(buffer, opts = {}) {
  const led = makeLedger();
  const XLSX = loadXlsx();
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellText: true });

  if (!signature(workbook)) {
    const err = new Error(`This file does not look like a ${spec.label} price list.`);
    err.code = 'vendor_signature_mismatch';
    throw err;
  }

  const availableSheets = workbook.SheetNames.map((name, index) => {
    const m = sheetMeta(workbook.Sheets[name]);
    return { index, name, effectiveDate: m.effectiveDate };
  });

  let chosen = 0;
  if (opts.sheet !== undefined && opts.sheet !== null && opts.sheet !== '') {
    const byName = workbook.SheetNames.indexOf(String(opts.sheet));
    const byIndex = Number(opts.sheet);
    if (byName >= 0) chosen = byName;
    else if (Number.isInteger(byIndex) && byIndex >= 0 && byIndex < workbook.SheetNames.length) chosen = byIndex;
    else {
      const err = new Error(`This workbook has no sheet "${opts.sheet}".`);
      err.code = 'sheet_not_found';
      throw err;
    }
  }

  const sheetName = workbook.SheetNames[chosen];
  const ws = workbook.Sheets[sheetName];
  const meta = Object.assign(
    { vendor: spec.vendor, label: spec.label, unit: spec.unit, currency: spec.currency, dp: spec.dp },
    sheetMeta(ws),
    { sheetName, sheetIndex: chosen, availableSheets },
  );

  if (availableSheets.length > 1) {
    led.warn('multiple_sheets',
      `This workbook holds ${availableSheets.length} price sheets (${availableSheets.map((s) => s.name).join(', ')}). Only "${sheetName}" was read — check you picked the right day.`,
      { availableSheets });
  }

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  const lastRow = range.e.r + 1;

  // locate the header row so a template change is noticed rather than absorbed
  let headerRow = 0;
  for (let r = 1; r <= Math.min(lastRow, 40); r += 1) {
    if (/^SITE NAME$/i.test(cellText(ws, `A${r}`))) { headerRow = r; break; }
  }
  if (!headerRow) {
    const err = new Error('Could not find the "SITE NAME" header row — the Petro-Canada template may have changed.');
    err.code = 'header_not_found';
    throw err;
  }

  const rows = [];
  let blank = 0;
  let drift = { count: 0, maxDelta: 0, rows: [] }; // see the note in pdfTable.js
  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const site = cellText(ws, `A${r}`);
    const prv = cellText(ws, `B${r}`);
    if (!site && !prv) { blank += 1; continue; }
    if (/^-+$/.test(site)) continue;                     // the dashed rule under the header
    if (/^SITE NAME$/i.test(site)) continue;             // a repeated page header
    if (/Petro-?Canada|As of|Product\s*:|Region\s*:/i.test(site)) continue; // repeated page banner

    const money = {};
    let fatal = false;
    const mismatches = [];
    spec.columns.filter((c) => c.kind === 'money').forEach((c) => {
      const raw = cellRaw(ws, `${c.col}${r}`);
      const asNumber = numberToMoney(raw, spec.dp);
      if (!asNumber) { fatal = true; money[c.key] = null; return; }
      money[c.key] = asNumber;
      // second reading: what the cell displays
      const shown = parseMoney(cellText(ws, `${c.col}${r}`));
      if (shown && Math.abs(shown.int - asNumber.int) > 100) {
        mismatches.push(`${c.key}: stored ${asNumber.int / 1e6} vs displayed ${shown.int / 1e6}`);
      }
    });

    if (fatal) {
      const line = `${site} ${prv} ${['C', 'D', 'E', 'F'].map((c) => cellText(ws, `${c}${r}`)).join(' ')}`.trim();
      if (looksLikeData(line, { minNumbers: 1 })) {
        led.warn('unreadable_number', `Row ${r}: a price column could not be read.`, { row: r, text: line });
        led.dropped(line, { row: r, reason: 'unreadable_number' });
      }
      continue;
    }

    const row = {
      rowNo: rows.length + 1,
      page: 1,
      sourceRow: r,
      text: { site_name: site, region: prv },
      money,
      rawLine: `${site} | ${prv} | ${['C', 'D', 'E', 'F'].map((c) => cellText(ws, `${c}${r}`)).join(' | ')}`,
      flags: [],
    };

    if (!prv) {
      row.flags.push({ code: 'missing_field', message: 'region is empty' });
      led.warn('missing_field', `Row ${r}: province is empty.`, { row: r, text: row.rawLine });
    }

    mismatches.forEach((msg) => {
      row.flags.push({ code: 'cross_check_mismatch', message: msg });
      led.warn('cross_check_mismatch', `Row ${r}: ${msg}.`, { row: r, text: row.rawLine });
    });

    const res = checkIdentity(money, IDENTITY);
    if (res.ok && res.delta > 0) {
      drift.count += 1;
      drift.maxDelta = Math.max(drift.maxDelta, res.delta);
      if (drift.rows.length < 20) drift.rows.push(rows.length + 1);
      row.flags.push({ code: 'vendor_rounding_drift', message: `${IDENTITY.label} is off by ${res.delta / 1e6} in the vendor's own columns`, severity: 'info' });
    }
    if (!res.ok) {
      row.flags.push({ code: 'identity_failed', message: `${IDENTITY.label} off by ${res.delta / 1e6}` });
      led.warn('identity_failed',
        `Row ${r}: ${IDENTITY.label} does not add up (off by ${res.delta / 1e6}).`,
        { row: r, text: row.rawLine });
    }

    rows.push(row);
  }

  if (drift.count) {
    led.warn('vendor_rounding_drift',
      `On ${drift.count} of ${rows.length} rows the vendor's own columns do not add up exactly (${IDENTITY.label}; up to ${drift.maxDelta / 1e6} out).`,
      drift);
  }

  return led.result({
    meta,
    columns: spec.columns.map((c) => ({ key: c.key, label: c.label, kind: c.kind, role: c.role })),
    baseColumn: spec.baseColumn,
    rows,
    stats: {
      pages: 1,
      rows: rows.length,
      blankRows: blank,
      flagged: rows.filter((x) => x.flags.some((f) => f.severity !== 'info')).length,
      vendorRoundingDrift: drift.count,
      unparsed: led.unparsed.length,
    },
  });
}

module.exports = { spec, parse, IDENTITY };
