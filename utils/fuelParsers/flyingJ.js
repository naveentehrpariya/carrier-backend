'use strict';
/**
 * Flying J (CAD) pricing worksheet — PDF.
 *
 * Layout: one row per site, CAD per litre, 4 decimals. The location address wraps
 * onto a second line on some rows, which is why `address` is a wrap column.
 * Column x-ranges below were measured off the real vendor file; an item landing
 * outside all of them is reported as `column_outside_template` rather than guessed.
 */

const { parseLooseDate } = require('./shared');
const { parsePdfTable } = require('./pdfTable');

const columns = [
  { key: 'site_number', label: 'Site #',        kind: 'text',  xMin: 40,  xMax: 82,  role: 'info' },
  { key: 'name',        label: 'Name',          kind: 'text',  xMin: 100, xMax: 210, role: 'info' },
  { key: 'location',    label: 'Location',      kind: 'text',  xMin: 212, xMax: 308, role: 'info' },
  { key: 'address',     label: 'Address',       kind: 'text',  xMin: 310, xMax: 445, role: 'info' },
  { key: 'region',      label: 'Prov.',         kind: 'text',  xMin: 446, xMax: 484, role: 'info' },
  { key: 'product',     label: 'Product',       kind: 'text',  xMin: 488, xMax: 548, role: 'info' },
  { key: 'price_ex_tax', label: 'Price excl. GST/HST', kind: 'money', xMin: 552, xMax: 612, role: 'base' },
  { key: 'gst',         label: 'GST/HST',       kind: 'money', xMin: 615, xMax: 668, role: 'tax' },
  { key: 'pst',         label: 'PST',           kind: 'money', xMin: 670, xMax: 708, role: 'tax' },
  { key: 'total',       label: 'Total',         kind: 'money', xMin: 712, xMax: 762, role: 'total' },
];

const spec = {
  vendor: 'flying_j_cad',
  label: 'Flying J (CAD)',
  fileTypes: ['pdf'],
  unit: 'per_litre',
  currency: 'CAD',
  dp: 4,
  baseColumn: 'price_ex_tax',
  taxColumns: ['gst', 'pst'],
  totalColumn: 'total',
  columns,
  wrapKeys: ['name', 'location', 'address'],
  requiredText: ['site_number', 'region'],

  signature: (text) => /FLYING\s*J/i.test(text) && /PRICING WORKSHEET/i.test(text),

  isAnchor: (cols) => {
    const site = cols.site_number.map((i) => i.str).join('');
    return /^\d{2,6}$/.test(site) && cols.price_ex_tax.length > 0 && cols.total.length > 0;
  },

  identities: [
    { label: 'Total = Price excl. tax + GST/HST + PST', left: ['total'], right: ['price_ex_tax', 'gst', 'pst'], tolerance: 100 },
  ],

  // second, independent reading: the four money columns as printed at the end of the line
  rowRegex: /(\d+\.\d{4})\s+(\d+\.\d{4})\s+(\d+\.\d{4})\s+(\d+\.\d{4})\s*$/,
  regexFields: ['price_ex_tax', 'gst', 'pst', 'total'],

  ignorePatterns: [
    /RETAIL PRICES ARE SUBJECT TO CHANGE/i,
    /CONFIDENTIAL/i,
    /PRICING WORKSHEET/i,
    /^SITE NUMBER/i,
    /^Price$/i,
    /^GST\/HST$/i,
    /^Excluding$/i,
  ],

  readMeta: (text) => ({
    effectiveDate: parseLooseDate((/Price Effective\s*:?\s*([^*\n]+)/i.exec(text) || [])[1] || ''),
    sourceTitle: (/(FLYING J[^\n]*)/i.exec(text) || [])[1] || '',
    confidentialNotice: /CONFIDENTIAL/i.test(text),
  }),
};

module.exports = {
  spec,
  parse: (buffer) => parsePdfTable(buffer, spec),
};
