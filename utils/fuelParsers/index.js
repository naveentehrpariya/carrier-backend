'use strict';
/**
 * Vendor parser registry.
 *
 * Adding a vendor means adding a file here — never loosening an existing parser to
 * "also handle" a second layout. A file we cannot positively identify is refused;
 * guessing which vendor a sheet came from would mean guessing which column the
 * client's margin gets added to.
 */

const petroCanada = require('./petroCanada');
const avaalEsso = require('./avaalEsso');
const flyingJ = require('./flyingJ');
const taPetro = require('./taPetro');
const genericTable = require('./genericTable');
const { extractPdfBands, fullText } = require('./shared');

const PARSERS = [petroCanada, avaalEsso, flyingJ, taPetro];

const VENDORS = PARSERS.map((p) => ({
  vendor: p.spec.vendor,
  label: p.spec.label,
  fileTypes: p.spec.fileTypes,
  unit: p.spec.unit,
  currency: p.spec.currency,
  dp: p.spec.dp,
  baseColumn: p.spec.baseColumn,
  baseColumnLabel: (p.spec.columns.find((c) => c.key === p.spec.baseColumn) || {}).label || p.spec.baseColumn,
  taxColumns: p.spec.taxColumns || [],
  totalColumn: p.spec.totalColumn || null,
  columns: p.spec.columns.map((c) => ({ key: c.key, label: c.label, kind: c.kind, role: c.role || 'info' })),
}));

function byVendor(vendor) {
  if (vendor === 'generic') return genericTable;
  return PARSERS.find((p) => p.spec.vendor === vendor) || null;
}

function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Identify which vendor a file came from.
 * Returns { vendor, label, parser }. Throws when nothing matches, or when more than
 * one parser claims the file (which would mean the signatures need tightening).
 */
async function detectVendor(buffer, filename) {
  const ext = extOf(filename);

  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    const matches = PARSERS.filter((p) => p.spec.fileTypes.includes(ext) && p.spec.columns);
    const hits = [];
    for (const p of matches) {
      try { p.parse(buffer, { probe: true }); hits.push(p); } catch (e) {
        if (e.code !== 'vendor_signature_mismatch') throw e;
      }
    }
    if (hits.length === 1) return { vendor: hits[0].spec.vendor, label: hits[0].spec.label, parser: hits[0] };
    if (hits.length > 1) throw fail('vendor_ambiguous', `More than one vendor template matched this workbook (${hits.map((h) => h.spec.label).join(', ')}).`);
    // Not a layout we know: read it as a plain table and have a person confirm which
    // column is the price. Refusing the file outright would mean the app only works
    // for four vendors; guessing the price column would be worse than refusing.
    return { vendor: 'generic', label: genericTable.spec.label, parser: genericTable, generic: true };
  }

  if (ext === 'pdf' || !ext) {
    const pages = await extractPdfBands(buffer);
    const text = fullText(pages);
    if (!text.trim()) {
      throw fail('pdf_has_no_text', 'This PDF contains no text — it is a scan or an image. A scanned sheet cannot be priced; ask the vendor for the original PDF or spreadsheet.');
    }
    const hits = PARSERS.filter((p) => p.spec.fileTypes.includes('pdf') && p.spec.signature && p.spec.signature(text));
    if (hits.length === 1) return { vendor: hits[0].spec.vendor, label: hits[0].spec.label, parser: hits[0] };
    if (hits.length > 1) throw fail('vendor_ambiguous', `More than one vendor template matched this PDF (${hits.map((h) => h.spec.label).join(', ')}).`);
    return { vendor: 'generic', label: genericTable.spec.label, parser: genericTable, generic: true };
  }

  throw fail('unsupported_file_type', `Cannot read a .${ext} file. Upload the vendor's PDF or XLSX.`);
}

/**
 * Parse a vendor sheet.
 * @param {Buffer} buffer
 * @param {Object} opts
 * @param {string} [opts.filename] used for file-type detection
 * @param {string} [opts.vendor]   skip detection and use this parser
 * @param {string|number} [opts.sheet] which worksheet (XLSX vendors only)
 */
async function parseSheet(buffer, opts = {}) {
  if (!buffer || !buffer.length) throw fail('empty_file', 'The uploaded file is empty.');
  let parser = opts.vendor ? byVendor(opts.vendor) : null;
  let detected = null;
  if (opts.vendor && !parser) throw fail('unknown_vendor', `Unknown vendor "${opts.vendor}".`);
  if (!parser) {
    detected = await detectVendor(buffer, opts.filename);
    parser = detected.parser;
  }
  const result = await parser.parse(buffer, { sheet: opts.sheet, filename: opts.filename });
  result.meta.detected = !opts.vendor;
  return result;
}

/**
 * A stable identity for one row across two uploads of the same vendor's sheet.
 *
 * Used to compare this week's prices with last week's: the vendor keys on a site
 * number, a human keys on the name, and the same site can sell two products — so the
 * key is site + region + product. Without this there is no way to catch the failure
 * that actually happens in the wild, which is a vendor typo in ONE row.
 */
function rowKey(row) {
  const t = (row && row.text) || {};
  const site = t.site_id || t.site_number || t.location_no || t.site_name || t.name || '';
  const region = t.region || '';
  const product = t.product || '';
  return `${String(site).trim().toUpperCase()}|${String(region).trim().toUpperCase()}|${String(product).trim().toUpperCase()}`;
}

/**
 * Keys for a whole sheet, de-duplicated.
 *
 * Petro-Canada gives no site id and genuinely lists two separate locations under one
 * town name (ALDERSYDE AB appears twice), so a name-based key collides. Repeats get
 * an occurrence suffix, which is stable because the vendor sorts its sheet the same
 * way every day. If a vendor ever reorders its rows, a repeated name could pair with
 * the wrong twin — the comparison it feeds is a WARNING, never a price, so the worst
 * case is a movement note about the wrong one of two identically-priced sites.
 */
function rowKeys(rows) {
  const seen = new Map();
  return (rows || []).map((row) => {
    const base = rowKey(row);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

module.exports = {
  PARSERS, VENDORS, byVendor, detectVendor, parseSheet, rowKey, rowKeys,
  GENERIC: genericTable.spec,
};
