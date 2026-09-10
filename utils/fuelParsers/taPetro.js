'use strict';
/**
 * TA / Petro pricing worksheet — PDF.
 *
 * US sheet: USD per GALLON. Nothing here converts it to litres or to CAD — the row
 * carries its own unit and currency, and any conversion is a deliberate, separate
 * setting. Two units on one screen with nothing saying which is which is how a
 * margin gets applied to the wrong number.
 *
 * Two layout quirks, both handled by wrap columns:
 *   - the product name is always printed across TWO lines, one above and one below
 *     the row's own baseline ("DIESEL ULTRA" / "LOW SULFUR"), so the anchor band
 *     carries no product text at all;
 *   - a long "City, ST" wraps its state onto a second line.
 *
 * `Your Actual Price` is the base column — it is what the client actually pays, and
 * therefore what a margin is added to. `Retail` is the pump price and `Savings` is
 * the vendor's discount; both are kept for the identity check.
 */

const { parseLooseDate } = require('./shared');
const { parsePdfTable } = require('./pdfTable');

const columns = [
  { key: 'location_no',   label: 'Location #',        kind: 'text',  xMin: 36,  xMax: 76,  role: 'info' },
  { key: 'travel_center', label: 'Travel Center',     kind: 'text',  xMin: 82,  xMax: 255, role: 'info' },
  { key: 'region',        label: 'ST',                kind: 'text',  xMin: 256, xMax: 290, role: 'info' },
  { key: 'merchant_id',   label: 'Merchant ID',       kind: 'text',  xMin: 292, xMax: 354, role: 'info' },
  { key: 'city_state',    label: 'City/State',        kind: 'text',  xMin: 356, xMax: 465, role: 'info' },
  { key: 'product',       label: 'Product',           kind: 'text',  xMin: 466, xMax: 554, role: 'info' },
  { key: 'retail',        label: 'Retail',            kind: 'money', xMin: 556, xMax: 606, role: 'reference' },
  { key: 'actual',        label: 'Your Actual Price', kind: 'money', xMin: 608, xMax: 706, role: 'base' },
  { key: 'savings',       label: 'Savings',           kind: 'money', xMin: 708, xMax: 762, role: 'reference' },
];

const spec = {
  vendor: 'ta_petro',
  label: 'TA / Petro (USD)',
  fileTypes: ['pdf'],
  unit: 'per_gallon',
  currency: 'USD',
  dp: 3, // the base column is printed to 3 decimals; computed prices follow it
  baseColumn: 'actual',
  taxColumns: [],
  totalColumn: null,
  columns,
  wrapKeys: ['travel_center', 'city_state', 'product'],
  requiredText: ['location_no', 'region', 'product'],

  signature: (text) => /TA\s*\/\s*PETRO/i.test(text) && /PRICING WORKSHEET/i.test(text),

  isAnchor: (cols) => {
    const site = cols.location_no.map((i) => i.str).join('');
    return /^\d{3,6}$/.test(site) && cols.retail.length > 0 && cols.actual.length > 0;
  },

  identities: [
    { label: 'Retail = Your Actual Price + Savings', left: ['retail'], right: ['actual', 'savings'], tolerance: 1000 },
  ],

  rowRegex: /(\d+\.\d{3,4})\s+(\d+\.\d{3,4})\s+(-?\d+\.\d{3,4})\s*$/,
  regexFields: ['retail', 'actual', 'savings'],

  ignorePatterns: [
    /CONFIDENTIAL/i,
    /RETAIL PRICES ARE SUBJECT TO CHANGE/i,
    /DISCOUNT AVAILABLE/i,
    /PRICING WORKSHEET/i,
    /Oregon/i,
    /Weight Tax/i,
    /^Location #/i,
    /^Product$/i,
    /^Retail$/i,
    /^Savings$/i,
    /Your Actual Price/i,
    /Merchant ID/i,
    /^Travel Center/i,
  ],

  readMeta: (text) => ({
    effectiveDate: parseLooseDate((/Effective Date\s*:?\s*([^*\n]+)/i.exec(text) || [])[1] || ''),
    sourceTitle: (/(TA \/ PETRO[^\n]*)/i.exec(text) || [])[1] || '',
    confidentialNotice: /CONFIDENTIAL/i.test(text),
    notices: (text.match(/\*\*\*[^*\n]+\*\*\*/g) || []).map((s) => s.replace(/\*/g, '').trim()),
  }),
};

module.exports = { spec, parse: (buffer) => parsePdfTable(buffer, spec) };
