'use strict';
/**
 * AVAAL Blue / ESSO price feed — PDF.
 *
 * Prices are CENTS per litre (195.50 = $1.9550/L), 2 decimals. The unit is carried
 * on the sheet and never converted here: a number that silently changes unit is the
 * same class of bug as an order amount that silently changes currency.
 *
 * Each money cell is drawn as two text runs — a "$" and the number — and a zero is
 * printed as "-". Both are handled by the money column ranges + parseMoney.
 * Only page 1 carries the column header; pages 2-3 start straight into data, so the
 * column map is declared here rather than read off each page.
 */

const { parseLooseDate } = require('./shared');
const { parsePdfTable } = require('./pdfTable');

const columns = [
  { key: 'site_id',  label: 'Site ID',  kind: 'text',  xMin: 45,  xMax: 90,  role: 'info' },
  { key: 'location', label: 'Location', kind: 'text',  xMin: 90,  xMax: 280, role: 'info' },
  { key: 'region',   label: 'Prov.',    kind: 'text',  xMin: 280, xMax: 316, role: 'info' },
  { key: 'product',  label: 'Product',  kind: 'text',  xMin: 317, xMax: 382, role: 'info' },
  { key: 'price',    label: 'AVAAL Price', kind: 'money', xMin: 384, xMax: 448, role: 'base' },
  { key: 'gst',      label: 'GST/HST',  kind: 'money', xMin: 448, xMax: 496, role: 'tax' },
  { key: 'pst',      label: 'PST/QST',  kind: 'money', xMin: 497, xMax: 543, role: 'tax' },
  { key: 'gross',    label: 'Gross Price', kind: 'money', xMin: 544, xMax: 610, role: 'total' },
];

const spec = {
  vendor: 'avaal_blue_esso',
  label: 'AVAAL Blue (ESSO)',
  fileTypes: ['pdf'],
  unit: 'cents_per_litre',
  currency: 'CAD',
  dp: 2,
  baseColumn: 'price',
  taxColumns: ['gst', 'pst'],
  totalColumn: 'gross',
  columns,
  wrapKeys: ['location', 'product'],
  requiredText: ['site_id', 'region'],

  signature: (text) => /AVAAL/i.test(text) && /Price Feed/i.test(text),

  isAnchor: (cols) => {
    const site = cols.site_id.map((i) => i.str).join('');
    return /^\d{4,6}$/.test(site) && cols.price.length > 0 && cols.gross.length > 0;
  },

  identities: [
    { label: 'Gross = Price + GST/HST + PST/QST', left: ['gross'], right: ['price', 'gst', 'pst'], tolerance: 10000 },
  ],

  rowRegex: /\$\s*([\d.,]+|-)\s+\$\s*([\d.,]+|-)\s+\$\s*([\d.,]+|-)\s+\$\s*([\d.,]+|-)\s*$/,
  regexFields: ['price', 'gst', 'pst', 'gross'],

  ignorePatterns: [
    /CONFIDENTIAL/i,
    /Price Feed Canada/i,
    /^SITE ID/i,
  ],

  readMeta: (text) => {
    const range = /Effective Date\s*([\d/]+)\s*-\s*([\d/]+)/i.exec(text);
    return {
      effectiveDate: parseLooseDate(range ? range[1] : (/Effective Date\s*([^\n]+)/i.exec(text) || [])[1] || ''),
      effectiveTo: range ? parseLooseDate(range[2]) : null,
      sourceTitle: (/(Price Feed Canada[^\n]*)/i.exec(text) || [])[1] || '',
      confidentialNotice: /CONFIDENTIAL/i.test(text),
    };
  },
};

module.exports = { spec, parse: (buffer) => parsePdfTable(buffer, spec) };
