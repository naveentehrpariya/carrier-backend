// Server-side customer invoice.
//
// The invoice used to be rendered in the browser and POSTed to /order/generate-pdf as raw HTML.
// That made the `invoices` permission unenforceable: the check keyed off a client-declared
// `docType`, so omitting it skipped the gate entirely, and the endpoint would render whatever
// markup it was handed. Building the document here from the order id means the permission check,
// the tenant scope and the numbers are all decided on the server.
//
// Markup mirrors frontend/src/pages/dashboard/order/CustomerInvoice.jsx so the download matches
// what the page shows.

const CUR_SYMBOL = { USD: '$', CAD: 'C$', INR: '₹' };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const normCur = (c) => {
  const code = String(c || 'USD').trim().toUpperCase();
  return ['USD', 'CAD', 'INR'].includes(code) ? code : 'USD';
};

const fmtMoney = (amount, currency) => {
  const cur = normCur(currency);
  const n = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${CUR_SYMBOL[cur] || ''}${n} ${cur}`;
};

const fmtDate = (d) => {
  if (!d) return '';
  // A stop date is stored as a bare 'YYYY-MM-DD'; parsing it as local time shifts it a day west
  // of UTC, so the invoice would print the day before the truck was actually there.
  const dt = (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? new Date(`${d}T00:00:00Z`) : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const fmtDateTime = (d) => {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/**
 * Invoice number for an order. DETERMINISTIC on purpose: the old client-side version mixed in
 * Math.random(), so the same invoice downloaded twice carried two different numbers — and the
 * footer tells the customer that number must appear on all payments. Shape is unchanged
 * (`<serial>-<MMDD><3 digits>`); the last three digits now come from the order id instead.
 */
function buildInvoiceNo(order, issuedAt = new Date()) {
  const d = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  const stamp = `${d.getMonth() + 1}${d.getDate()}`;
  const idTail = String(order?._id || '').replace(/\D/g, '').slice(-3).padStart(3, '0');
  return `${order?.serial_no ?? ''}-${stamp}${idTail}`;
}

/**
 * The amounts a customer invoice shows: whatever was typed at order entry, in the currency it was
 * quoted in. `revenue_items[].rate` is stored base-converted, so it is scaled back by the same
 * input/base ratio the total carries. Nothing is live-converted — an invoice is a statement of
 * what was agreed, not of today's FX.
 */
function invoiceAmounts(order) {
  const hasInput = Number(order?.input_total_amount) > 0;
  const currency = normCur(hasInput ? (order?.input_currency || 'USD') : (order?.revenue_currency || 'USD'));
  const factor = (hasInput && Number(order?.total_amount) > 0)
    ? Number(order.input_total_amount) / Number(order.total_amount)
    : 1;
  const total = hasInput ? Number(order.input_total_amount) : Number(order?.total_amount || 0);
  return { currency, factor, total };
}

const LABEL = 'font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#6b7280;margin-bottom:2px;';
const VALUE = 'font-size:11px;font-weight:600;color:#111827;';
const SECTION = 'font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#2563eb;margin-bottom:8px;';
const TD = 'padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:11px;vertical-align:top;';
const TH = `${TD}font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #e5e7eb;`;

const field = (label, value) => `<div><div style="${LABEL}">${esc(label)}</div><div style="${VALUE}">${esc(value)}</div></div>`;

function stopBlock(loc, kind, num) {
  const isPick = kind === 'pickup';
  const accent = isPick ? '#2563eb' : '#dc2626';
  return `
    <div style="display:flex;gap:10px;margin-bottom:8px;">
      <div style="width:4px;flex-shrink:0;border-radius:2px;background:${accent};align-self:stretch;"></div>
      <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:9px 12px;">
        <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${accent};margin-bottom:3px;">${isPick ? 'PICKUP' : 'STOP'} ${num}</div>
        <div style="font-weight:600;color:#111827;font-size:12px;">${esc(loc?.location || loc?.address || '')}</div>
        ${loc?.customer ? `<div style="font-size:10px;color:#374151;margin-top:1px;font-weight:600;">Customer: ${esc(loc.customer)}</div>` : ''}
        <div style="font-size:10px;color:#6b7280;margin-top:2px;">${esc(fmtDate(loc?.date))}${loc?.appointment ? `<span style="font-weight:600;margin-left:8px;">&middot; Appt: ${esc(loc.appointment)}</span>` : ''}</div>
        ${loc?.referenceNo ? `<div style="font-size:10px;color:#9ca3af;margin-top:1px;">Ref #: ${esc(loc.referenceNo)}</div>` : ''}
      </div>
    </div>`;
}

function buildCustomerInvoiceHtml({ order, company, invoiceNo, issuedAt = new Date(), logoBase64 = '' }) {
  const { currency, factor, total } = invoiceAmounts(order);
  const orderNo = `#CMC${order?.serial_no ?? ''}`;

  const shipping = (Array.isArray(order?.shipping_details) ? order.shipping_details : []).map((s) => {
    const meta = [
      ['Order No', orderNo],
      (order?.order_type === 'regular' && order?.customer_order_no) ? ['Customer Order No', order.customer_order_no] : null,
      ['Commodity', s?.commodity?.value || s?.commodity || ''],
      s?.reference ? ['Commodity Ref', s.reference] : null,
      ['Equipment', s?.equipment?.value || ''],
      ['Weight', `${s?.weight || ''}${s?.weight_unit || ''}`],
    ].filter(Boolean).map(([l, v]) => field(l, v)).join('');

    let pc = 0;
    let sc = 0;
    const stops = (Array.isArray(s?.locations) ? s.locations : []).map((l) => {
      // A relay is a planning artefact, not a customer stop — it is numbered with the others as
      // "STOP n" exactly like the on-screen invoice does.
      const isPick = String(l?.type || l?.location_type || '').toLowerCase() === 'pickup';
      if (isPick) pc += 1; else sc += 1;
      return stopBlock(l, isPick ? 'pickup' : 'stop', isPick ? pc : sc);
    }).join('');

    return `
      <div style="padding:0 36px;">
        <div style="display:flex;flex-wrap:wrap;gap:20px;padding:14px 0;border-bottom:1px solid #e5e7eb;">${meta}</div>
        <div style="padding:12px 0;border-bottom:1px solid #e5e7eb;">${stops}</div>
      </div>`;
  }).join('');

  const chargeRows = (Array.isArray(order?.revenue_items) ? order.revenue_items : []).map((r, i) => {
    const rate = Number(((Number(r?.rate) || 0) * factor).toFixed(2));
    const qty = Number(r?.quantity) || 0;
    return `
      <tr style="background:${i % 2 === 0 ? '#fff' : '#fafafa'};">
        <td style="${TD}">${esc(r?.revenue_item || '')}</td>
        <td style="${TD}color:#6b7280;">${esc(r?.note || '')}</td>
        <td style="${TD}">${esc(`${CUR_SYMBOL[currency] || ''}${rate}`)}&times;${qty}</td>
        <td style="${TD}text-align:right;font-weight:600;">${esc(fmtMoney(rate * qty, currency))}</td>
      </tr>`;
  }).join('');

  const processedBy = order?.created_by ? `
    <div style="padding:12px 36px 10px;border-top:1px solid #e5e7eb;">
      <div style="${SECTION}">Processed By</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${field('Employee Name', order.created_by?.name || 'N/A')}
        ${field('Employee ID', order.created_by?.corporateID || 'N/A')}
        ${field('Email', order.created_by?.email || '')}
        ${field('Phone', order.created_by?.phone || 'N/A')}
      </div>
    </div>` : '';

  const remitTo = company?.remittance_primary_email || company?.email || '';
  const bank = order?.order_type !== 'regular' ? `
    <div style="padding:12px 36px 10px;border-top:1px solid #e5e7eb;">
      <div style="${SECTION}">Bank &mdash; ${esc(company?.bank_name || 'Royal Bank of Canada')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:12px 14px;">
        ${field('Bank Name', company?.bank_name || '—')}
        ${field('Account Name', company?.account_name || '—')}
        ${field('Account Number', company?.account_number || '—')}
        ${field('Routing Number', company?.routing_number || '—')}
      </div>
    </div>` : '';

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { width: 794px; font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111827; }
  table { width: 100%; border-collapse: collapse; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  img { max-width: 100%; height: auto; display: block; }
</style></head>
<body>
  <div style="padding:28px 36px 20px;border-bottom:2px solid #111827;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <div style="font-size:22px;font-weight:700;color:#111827;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Invoice</div>
        <div style="font-size:12px;color:#374151;font-weight:500;">${esc(company?.name || '')}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">${esc(company?.address || '')}</div>
        <div style="font-size:11px;color:#6b7280;">${esc(company?.email || '')} &middot; PH: ${esc(company?.phone || '')}</div>
      </div>
      <div style="text-align:right;">
        ${logoBase64 ? `<img src="${logoBase64}" alt="logo" style="height:44px;width:auto;object-fit:contain;margin-left:auto;margin-bottom:8px;" />` : ''}
        <div style="font-size:13px;font-weight:700;color:#111827;">INV # ${esc(invoiceNo)}</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px;">${esc(fmtDateTime(issuedAt))}</div>
      </div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;padding:16px 36px;border-bottom:1px solid #e5e7eb;">
    <div style="padding-right:24px;border-right:1px solid #e5e7eb;">
      <div style="${SECTION}">Bill To</div>
      <div style="font-size:12px;font-weight:600;color:#111827;text-transform:uppercase;margin-bottom:3px;">
        ${esc(order?.customer?.name || '')}
        ${order?.customer?.customerCode ? `<span style="font-size:10px;color:#6b7280;font-weight:400;text-transform:none;margin-left:6px;">Ref: ${esc(order.customer.customerCode)}</span>` : ''}
      </div>
      <div style="font-size:11px;color:#6b7280;line-height:1.7;">
        <div>${esc(order?.customer?.address || '')}</div>
        <div>${esc(order?.customer?.email || '')}</div>
        <div>${esc(order?.customer?.phone || '')}</div>
      </div>
    </div>
    <div style="padding-left:24px;">
      <div style="${SECTION}">Invoice Details</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><div style="${LABEL}">Order No</div><div style="${VALUE}color:#2563eb;">${esc(orderNo)}</div></div>
        ${(order?.order_type === 'regular' && order?.customer_order_no) ? field('Cust. Order No', order.customer_order_no) : ''}
        ${field('Invoice Date', fmtDate(issuedAt))}
        ${field('Amount Due', fmtMoney(total, currency))}
      </div>
    </div>
  </div>

  ${shipping}

  <div style="padding:14px 36px;">
    <div style="${SECTION}">Charges</div>
    <table>
      <thead>
        <tr>
          <th align="left" style="${TH}">Charges</th>
          <th align="left" style="${TH}">Notes</th>
          <th align="left" style="${TH}">Rate</th>
          <th style="${TH}text-align:right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${chargeRows}
        <tr style="background:#f9fafb;border-top:2px solid #111827;">
          <td colspan="3" style="${TD}font-weight:700;text-align:right;border-bottom:none;">Total</td>
          <td style="${TD}font-weight:700;text-align:right;font-size:13px;border-bottom:none;">${esc(fmtMoney(total, currency))}</td>
        </tr>
      </tbody>
    </table>
  </div>

  ${processedBy}

  <div style="padding:12px 36px 10px;border-top:1px solid #e5e7eb;">
    <div style="${SECTION}">Remittance</div>
    <div style="font-size:11px;color:#374151;">
      Please send remittance to <span style="color:#2563eb;font-weight:600;">${esc(remitTo)}</span>
      ${company?.remittance_secondary_email ? `<span style="color:#6b7280;margin-left:6px;">(cc: ${esc(company.remittance_secondary_email)})</span>` : ''}
    </div>
  </div>

  ${bank}

  <div style="padding:16px 36px 24px;border-top:1px solid #e5e7eb;display:flex;justify-content:flex-end;">
    <div style="text-align:right;">
      <div style="font-weight:700;font-size:13px;color:#111827;">INV# ${esc(invoiceNo)}</div>
      <div style="font-size:10px;color:#6b7280;margin-top:2px;">${esc(fmtDateTime(issuedAt))}</div>
      <div style="font-size:9px;color:#9ca3af;margin-top:2px;">INVOICE# ${esc(invoiceNo)} must appear on all payments</div>
    </div>
  </div>

  <div style="height:3px;background:#111827;"></div>
</body></html>`;
}

module.exports = { buildCustomerInvoiceHtml, buildInvoiceNo, invoiceAmounts, fmtMoney };
