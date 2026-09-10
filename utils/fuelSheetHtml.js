'use strict';
/**
 * Branded fuel price sheet markup.
 *
 * Server-authored HTML only, rendered through launchBrowser()/hardenPage() like every
 * other PDF route in this app. The only interpolation that is not escaped is the
 * logo, which is checked to be a data: URI by safeLogo() — the same rule as the rate
 * confirmation, where escaping would break the base64 payload.
 *
 * Two rules this document must keep:
 *   - it prints ONE unit and ONE currency, stated in the header, and never converts
 *     (an invoice states what was agreed; so does a price list);
 *   - the total it prints is the sum of the figures it prints, so a customer can add
 *     the columns up by hand and get the same answer.
 */

const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const { fmtMoney } = require('./fuelParsers/shared');
const { unitLabel } = require('./fuelMargin');

/** Only a data:image URI may reach the src attribute unescaped. */
function safeLogo(logo) {
  const s = String(logo || '');
  return /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(s) ? s : '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a bare YYYY-MM-DD as a printed date.
 * Parsed by hand and never through `new Date(...).toLocaleDateString()` — a printed
 * effective date is a calendar date, and any server west of UTC prints the day before.
 */
function fmtSheetDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

const CURRENCY_SYMBOL = { CAD: 'CA$', USD: 'US$', INR: '₹' };

function unitHeading(unit, currency) {
  const label = unitLabel(unit);
  if (unit === 'cents_per_litre') return `cents per litre (${currency})`;
  if (unit === 'per_gallon') return `${currency} per gallon`;
  if (unit === 'per_litre') return `${currency} per litre`;
  return `${currency}${label}`;
}

/**
 * @param {Object} out    a FuelSheetOutput-shaped object (or the live preview of one)
 * @param {Object} opts   { logo, company, preview }
 */
function buildFuelSheetHtml(out, opts = {}) {
  const company = opts.company || {};
  const logo = safeLogo(opts.logo);
  const dp = out.dp === undefined ? 4 : out.dp;
  const money = (int, d) => (int === null || int === undefined ? '—' : fmtMoney(int, d === undefined ? dp : d));

  // Which columns print, in order. The vendor's own cost is printed only when the
  // profile explicitly asked for it — a customer copy must not carry our cost.
  const textCols = (out.columns || []).filter((c) => c.kind === 'text');
  const taxCols = (out.taxColumns || []).map((k) => (out.columns || []).find((c) => c.key === k)).filter(Boolean);
  const showCost = !!out.showVendorCost;

  const head = [
    ...textCols.map((c) => `<th class="t">${esc(c.label)}</th>`),
    showCost ? '<th class="n muted">Vendor</th>' : '',
    showCost ? '<th class="n muted">Margin</th>' : '',
    '<th class="n price">Price</th>',
    ...taxCols.map((c) => `<th class="n">${esc(c.label)}</th>`),
    out.totalColumn ? '<th class="n total">Total</th>' : '',
  ].filter(Boolean).join('');

  const body = (out.rows || []).map((r) => {
    const cells = [
      ...textCols.map((c) => `<td class="t">${esc((r.text || {})[c.key] || '')}</td>`),
      showCost ? `<td class="n muted">${esc(money(r.baseInt))}</td>` : '',
      showCost ? `<td class="n muted">${r.marginInt > 0 ? '+' : ''}${esc(money(r.marginInt))}</td>` : '',
      `<td class="n price">${esc(money(r.finalInt))}</td>`,
      ...taxCols.map((c) => {
        const taxes = r.taxes instanceof Map ? Object.fromEntries(r.taxes) : (r.taxes || {});
        const v = taxes[c.key];
        return `<td class="n">${esc(money(v, undefined))}</td>`;
      }),
      out.totalColumn ? `<td class="n total">${esc(money(r.totalInt))}</td>` : '',
    ].filter(Boolean).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const colCount = textCols.length + (showCost ? 2 : 0) + 1 + taxCols.length + (out.totalColumn ? 1 : 0);
  const period = out.effectiveTo && out.effectiveTo !== out.effectiveDate
    ? `${fmtSheetDate(out.effectiveDate)} – ${fmtSheetDate(out.effectiveTo)}`
    : fmtSheetDate(out.effectiveDate);

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(out.title || 'Fuel Price Sheet')}</title>
<style>
  /* An explicit light scheme: without it a Chrome running a dark colour-scheme
     preference renders the whole sheet inverted. Same fix as the cheque. */
  :root { color-scheme: light; }
  @page { size: letter landscape; margin: 12mm 10mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #111; font: 10px/1.35 -apple-system, "Segoe UI", Arial, sans-serif; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 4px; }
  .brand { display: flex; gap: 10px; align-items: center; }
  .brand img { height: 42px; width: auto; }
  .co { font-size: 15px; font-weight: 700; letter-spacing: .2px; }
  .co small { display: block; font-size: 9px; font-weight: 400; color: #555; margin-top: 2px; }
  .meta { text-align: right; font-size: 9.5px; color: #333; }
  .meta .big { font-size: 13px; font-weight: 700; color: #111; }
  .unit { display: inline-block; margin-top: 3px; padding: 2px 7px; border: 1px solid #111; border-radius: 3px; font-weight: 700; font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead { display: table-header-group; }
  th, td { padding: 3.5px 6px; border-bottom: 1px solid #e3e3e3; }
  th { background: #f2f2f2; border-bottom: 1.5px solid #111; font-size: 8.5px; text-transform: uppercase; letter-spacing: .4px; text-align: left; }
  th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.t { color: #222; }
  th.price, td.price { font-weight: 700; }
  th.total, td.total { font-weight: 700; border-left: 1px solid #ddd; }
  .muted { color: #777; }
  tr { break-inside: avoid; }
  tbody tr:nth-child(even) td { background: #fafafa; }
  .foot { margin-top: 10px; padding-top: 6px; border-top: 1px solid #ccc; font-size: 8.5px; color: #555; display: flex; justify-content: space-between; gap: 12px; }
  .stamp { position: fixed; top: 42%; left: 0; right: 0; text-align: center; font-size: 78px; font-weight: 800; color: rgba(200,0,0,.12); letter-spacing: 8px; transform: rotate(-16deg); }
</style></head>
<body>
  ${opts.preview ? '<div class="stamp">PREVIEW</div>' : ''}
  <div class="head">
    <div class="brand">
      ${logo ? `<img src="${logo}" alt="">` : ''}
      <div class="co">${esc(company.name || company.company_name || '')}
        <small>${esc(company.address || '')}${company.email ? ` · ${esc(company.email)}` : ''}${company.phone ? ` · PH: ${esc(company.phone)}` : ''}</small>
      </div>
    </div>
    <div class="meta">
      <div class="big">${esc(out.title || 'Fuel Price Sheet')}</div>
      ${period ? `<div>Effective ${esc(period)}</div>` : ''}
      ${out.customerName ? `<div>Prepared for ${esc(out.customerName)}</div>` : ''}
      <div class="unit">${esc(unitHeading(out.unit, out.currency))}</div>
    </div>
  </div>
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="${colCount}" style="padding:18px;text-align:center;color:#777">No priced rows.</td></tr>`}</tbody>
  </table>
  <div class="foot">
    <div>
      ${esc(String(out.rows ? out.rows.length : 0))} location(s). All prices in ${esc(unitHeading(out.unit, out.currency))}.
      ${out.totalColumn ? ' Totals are the sum of the columns shown.' : ''}
      Prices are subject to change.
    </div>
    <div>${out.version ? `v${esc(out.version)} · ` : ''}${esc(fmtSheetDate(new Date().toISOString().slice(0, 10)))}</div>
  </div>
</body></html>`;
}

module.exports = { buildFuelSheetHtml, fmtSheetDate, unitHeading, safeLogo, CURRENCY_SYMBOL };
