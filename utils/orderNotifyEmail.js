// "New load" email — sent to the office every time an order is created (typed or copied).
//
// Recipients are the order's company's `order_notification_emails` (Company Details page). Nothing
// set, or no SMTP, means the mail is skipped silently: a notification is never a reason for an
// order save to fail.
//
// The mail is INTERNAL — it carries revenue, cost and profit. Do not add a customer or carrier
// address to the recipient list; neither may see the other side's money.
//
// Amounts are the order's TYPED values in the currency they were typed in (`input_*`), the same
// rule as the order card: no conversion, so the mail and the screen print one number.
//
// Markup is table-based with inline styles only — mail clients strip <style> and flexbox.

const sendEmail = require('./Email');
const { getOrderNumber } = require('./orderNumber');

const C = {
  canvas: '#EEF1F4',
  paper: '#FFFFFF',
  ink: '#172430',
  muted: '#5B6875',
  rule: '#DCE2E7',
  lane: '#4B3FD8',
  pickup: '#0B7A55',
  delivery: '#B4232F',
  gain: '#0B7A55',
  loss: '#B4232F',
};
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const CUR_SYMBOL = { USD: '$', CAD: 'CA$', INR: '₹' };
const money = (amount, cur) => {
  const n = Number(amount || 0);
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : ''}${CUR_SYMBOL[cur] || ''}${s} ${cur}`;
};

// A stop date is a bare 'YYYY-MM-DD' stored as a calendar date — format in UTC or it prints the
// day before everywhere west of UTC (same rule as the invoice and the cheque).
const fmtDate = (d) => {
  if (!d) return '';
  const dt = (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? new Date(`${d}T00:00:00Z`) : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

const splitAddress = (text) => {
  const seen = new Set();
  return String(text || '').split(',').map((x) => x.trim()).filter(Boolean).filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// "Winnipeg, MB" out of "1485 Chevrier Blvd, Winnipeg, MB R3T 1Y6, Canada".
const placeOf = (loc) => {
  const parts = splitAddress(loc?.location || loc?.address);
  if (loc?.city) {
    const st = loc?.state ? `, ${loc.state}` : '';
    return `${loc.city}${st}`;
  }
  if (parts.length >= 4) return `${parts[parts.length - 3]}, ${String(parts[parts.length - 2]).split(' ')[0]}`;
  if (parts.length === 3) return `${parts[1]}, ${String(parts[2]).split(' ')[0]}`;
  return parts[0] || 'Address missing';
};

const kindOf = (loc) => String(loc?.type || loc?.location_type || '').toLowerCase();

const stopsOf = (order) => (Array.isArray(order?.shipping_details) ? order.shipping_details : [])
  .flatMap((b) => (Array.isArray(b?.locations) ? b.locations : []))
  .filter((l) => kindOf(l) !== 'relay');

const nameOf = (doc) => {
  if (!doc || typeof doc !== 'object') return '';
  return String(doc.name || doc.fullName || doc.companyName || doc.company_name || '').trim();
};

const plateOf = (truck) => {
  if (!truck || typeof truck !== 'object') return '';
  return [truck.unitNumber || truck.truckNumber, truck.plateNumber].filter(Boolean).join(' / ');
};

/** Revenue / cost / commission / profit in the order's typed currency. */
function orderFigures(order, creator) {
  const cur = String(order?.input_currency || order?.revenue_currency || 'usd').toUpperCase();
  const revenue = Number(order?.input_total_amount || 0);
  const isOutsourcing = order?.order_type === 'outsourcing';
  const cost = Number(order?.input_cost_amount
    || (isOutsourcing ? order?.input_carrier_amount : order?.input_settle_amount) || 0);
  // Commission is earned on brokered work only (Order.commission). A new order is never mixed.
  const rate = Number(creator?.staff_commision || 0);
  const commission = isOutsourcing && rate > 0 ? Math.max(0, (revenue - cost) * (rate / 100)) : 0;
  return { cur, revenue, cost, commission, profit: revenue - cost - commission, rate };
}

function runBy(order) {
  const rows = [];
  if (order?.order_type === 'outsourcing' || order?.carrier) {
    const c = order.carrier;
    if (nameOf(c)) rows.push(['Carrier', `${nameOf(c)}${c?.mc_code ? ` (MC ${c.mc_code})` : ''}`]);
  }
  if (order?.truck) rows.push(['Truck', plateOf(order.truck) || '—']);
  const drivers = (Array.isArray(order?.drivers) && order.drivers.length ? order.drivers : [order?.driver]).filter(Boolean);
  const driverNames = drivers.map(nameOf).filter(Boolean);
  if (driverNames.length) rows.push([driverNames.length > 1 ? 'Drivers' : 'Driver', driverNames.join(' and ')]);
  if (order?.isOwnerOperatedTruck && nameOf(order.ownerOperator)) rows.push(['Owner operator', nameOf(order.ownerOperator)]);
  if (order?.trailer) rows.push(['Trailer', plateOf(order.trailer) || '—']);
  if (!rows.length) rows.push(['Assigned to', 'Nobody yet']);
  return rows;
}

function buildNewOrderEmail({ order, orderNo, creator, companyName, copiedFromNo, appUrl }) {
  const stops = stopsOf(order);
  const first = stops[0];
  const last = stops.length > 1 ? stops[stops.length - 1] : null;
  const block = order?.shipping_details?.[0] || {};
  const miles = Number(order?.totalDistance || 0) * 0.621371;
  const fig = orderFigures(order, creator);
  const addedBy = nameOf(creator) || 'Someone';
  const createdAt = new Date(order?.createdAt || Date.now()).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  const laneEnd = (loc, label, color, align) => `
    <td valign="top" width="44%" style="padding:0;text-align:${align};">
      <div style="font-family:${SANS};font-size:12px;color:${color};font-weight:bold;">${label}</div>
      <div class="city" style="font-family:${SERIF};font-size:26px;line-height:30px;color:${C.ink};margin-top:4px;">${esc(loc ? placeOf(loc) : '—')}</div>
      <div style="font-family:${SANS};font-size:13px;color:${C.muted};margin-top:6px;">${esc(fmtDate(loc?.date)) || 'No date'}</div>
    </td>`;

  const laneMiddle = `
    <td valign="middle" width="12%" style="padding:18px 6px 0;text-align:center;">
      <div style="height:2px;background:${C.lane};line-height:2px;font-size:0;">&nbsp;</div>
      <div style="font-family:${SANS};font-size:11px;color:${C.lane};margin-top:6px;white-space:nowrap;">${miles > 0 ? `${Math.round(miles).toLocaleString('en-US')} mi` : ''}</div>
    </td>`;

  const stopRows = stops.map((l, i) => {
    const pick = kindOf(l) === 'pickup';
    const color = pick ? C.pickup : C.delivery;
    return `
      <tr>
        <td valign="top" width="22" style="padding:10px 0 0;">
          <div style="width:10px;height:10px;border-radius:5px;background:${color};font-size:0;line-height:0;">&nbsp;</div>
        </td>
        <td valign="top" style="padding:6px 0;border-bottom:${i === stops.length - 1 ? '0' : `1px solid ${C.rule}`};">
          <div style="font-family:${SANS};font-size:14px;color:${C.ink};"><b>${pick ? 'Pickup' : 'Delivery'}</b>&nbsp; ${esc(fmtDate(l?.date))}${l?.appointment ? ` at ${esc(l.appointment)}` : ''}</div>
          <div style="font-family:${SANS};font-size:13px;color:${C.muted};margin-top:2px;">${esc(splitAddress(l?.location || l?.address).join(', ')) || 'Address missing'}</div>
          ${l?.referenceNo ? `<div style="font-family:${SANS};font-size:12px;color:${C.muted};margin-top:2px;">Ref ${esc(l.referenceNo)}</div>` : ''}
        </td>
      </tr>`;
  }).join('');

  const kv = (rows) => rows.filter(Boolean).map(([k, v]) => `
    <tr>
      <td valign="top" width="38%" style="padding:7px 12px 7px 0;font-family:${SANS};font-size:13px;color:${C.muted};">${esc(k)}</td>
      <td valign="top" style="padding:7px 0;font-family:${SANS};font-size:14px;color:${C.ink};">${esc(v)}</td>
    </tr>`).join('');

  const loadRows = [
    ['Customer', nameOf(order?.customer) || '—'],
    order?.customer_order_no ? ['Customer order no', order.customer_order_no] : null,
    block?.reference ? ['Reference', block.reference] : null,
    ...runBy(order),
    (block?.commodity?.value || typeof block?.commodity === 'string') ? ['Commodity', block?.commodity?.value || block.commodity] : null,
    block?.equipment?.value ? ['Equipment', block.equipment.value] : null,
    block?.weight ? ['Weight', `${block.weight} ${block.weight_unit || ''}`.trim()] : null,
    order?.route_summary ? ['Route', `via ${order.route_summary}`] : null,
  ];

  const moneyCell = (label, value, color, emphasise) => `
    <td class="mcell" valign="top" width="33%" style="padding:14px 12px;${emphasise ? `background:${color === C.loss ? '#FCEDEE' : '#E8F5EF'};` : ''}">
      <div style="font-family:${SANS};font-size:12px;color:${C.muted};">${label}</div>
      <div class="amt" style="font-family:${SANS};font-size:${emphasise ? 20 : 17}px;font-weight:bold;color:${color};margin-top:4px;">${esc(money(value, fig.cur))}</div>
    </td>`;
  const profitColor = fig.profit < 0 ? C.loss : C.gain;
  const margin = fig.revenue > 0 ? `${((fig.profit / fig.revenue) * 100).toFixed(1)}% of revenue` : '';

  const link = appUrl ? `${appUrl.replace(/\/+$/, '')}/view/order/${order._id}` : '';
  const instructions = String(order?.instructions || '').trim();

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>New load ${esc(orderNo)}</title>
<style>
@media only screen and (max-width:480px){
  .px{padding-left:16px!important;padding-right:16px!important}
  .outer{padding:12px 6px!important}
  .city{font-size:20px!important;line-height:24px!important}
  .amt{font-size:15px!important}
  .mcell{padding:12px 8px!important}
}
</style></head>
<body style="margin:0;padding:0;background:${C.canvas};">
<div style="display:none;max-height:0;overflow:hidden;">${esc(`${first ? placeOf(first) : ''} to ${last ? placeOf(last) : ''} · ${money(fig.revenue, fig.cur)} · added by ${addedBy}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas};">
<tr><td class="outer" align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.paper};border-radius:10px;border-top:5px solid ${C.lane};">

  <tr><td class="px" style="padding:22px 28px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${SANS};font-size:13px;color:${C.muted};">${esc(companyName || '')}<br><span style="color:${C.ink};">New load added by <b>${esc(addedBy)}</b></span></td>
      <td align="right" valign="top" style="font-family:${SANS};font-size:22px;font-weight:bold;color:${C.ink};white-space:nowrap;">${esc(orderNo)}</td>
    </tr></table>
    ${copiedFromNo ? `<div style="margin-top:12px;padding:8px 12px;background:#F1EFFE;border-radius:6px;font-family:${SANS};font-size:13px;color:${C.lane};">Copied from ${esc(copiedFromNo)} — check the dates and reference before it is dispatched.</div>` : ''}
  </td></tr>

  <tr><td class="px" style="padding:24px 28px 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${laneEnd(first, 'Pickup', C.pickup, 'left')}
      ${laneMiddle}
      ${laneEnd(last, 'Delivery', C.delivery, 'right')}
    </tr></table>
  </td></tr>

  <tr><td style="padding:0 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.rule};border-radius:8px;border-collapse:separate;"><tr>
      ${moneyCell('Revenue', fig.revenue, C.ink, false)}
      ${moneyCell('Cost', fig.cost, C.ink, false)}
      ${moneyCell('Profit', fig.profit, profitColor, true)}
    </tr></table>
    <div style="font-family:${SANS};font-size:12px;color:${C.muted};padding:8px 2px 0;">
      ${fig.commission > 0 ? `After ${esc(money(fig.commission, fig.cur))} commission (${fig.rate}%). ` : ''}${margin}
    </div>
  </td></tr>

  ${stops.length > 2 ? `
  <tr><td class="px" style="padding:22px 28px 0;">
    <div style="font-family:${SANS};font-size:15px;font-weight:bold;color:${C.ink};padding-bottom:4px;">${stops.length} stops</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stopRows}</table>
  </td></tr>` : `
  <tr><td class="px" style="padding:22px 28px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stopRows}</table>
  </td></tr>`}

  <tr><td class="px" style="padding:18px 28px 0;">
    <div style="font-family:${SANS};font-size:15px;font-weight:bold;color:${C.ink};padding-bottom:2px;">Load details</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${kv(loadRows)}</table>
  </td></tr>

  ${instructions ? `
  <tr><td class="px" style="padding:14px 28px 0;">
    <div style="padding:12px 14px;background:#FFF7E6;border-left:3px solid #C77700;font-family:${SANS};font-size:13px;line-height:19px;color:${C.ink};">
      <b>Instructions for the driver / carrier</b><br>${esc(instructions).replace(/\n/g, '<br>')}
    </div>
  </td></tr>` : ''}

  <tr><td class="px" style="padding:24px 28px 26px;">
    ${link ? `<a href="${esc(link)}" style="display:inline-block;background:${C.lane};color:#FFFFFF;font-family:${SANS};font-size:14px;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:6px;">Open load ${esc(orderNo)}</a>` : ''}
    <div style="font-family:${SANS};font-size:12px;color:${C.muted};margin-top:16px;">Added ${esc(createdAt)}. This email shows revenue and profit — keep it inside the office.</div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
// Recipients are the COMPANY's own setting (Company.order_notification_emails), edited on the
// Company Details page — never an env var shared by every tenant.
const recipientsOf = (company) => [...new Set((Array.isArray(company?.order_notification_emails)
  ? company.order_notification_emails : [])
  .map((s) => String(s || '').trim().toLowerCase())
  .filter((s) => EMAIL_RE.test(s)))];

/**
 * Fire-and-forget. Call AFTER the response is sent; never awaits on the request path and never
 * throws. Re-reads the order populated, so the caller can pass the bare saved doc.
 */
function notifyNewOrder({ orderId, tenantId, creator, copiedFromNo = null }) {
  if (!sendEmail.isEmailConfigured()) return;
  setImmediate(async () => {
    try {
      const Order = require('../db/Order');
      const Company = require('../db/Company');
      const order = await Order.findOne({ _id: orderId, tenantId })
        .populate(['customer', 'carrier', 'driver', 'drivers', 'truck', 'trailer', 'ownerOperator'])
        .lean();
      if (!order) return;
      const company = order.company
        ? await Company.findOne({ _id: order.company, tenantId }).lean()
        : await Company.findOne({ tenantId }).lean();
      const to = recipientsOf(company);
      if (!to.length) return;
      const orderNo = getOrderNumber({ order, company, tenantId });
      const html = buildNewOrderEmail({
        order,
        orderNo,
        creator,
        companyName: company?.name || '',
        copiedFromNo,
        appUrl: process.env.APP_URL || process.env.DOMAIN_URL || '',
      });
      const first = stopsOf(order)[0];
      const all = stopsOf(order);
      const last = all.length > 1 ? all[all.length - 1] : null;
      const subject = `New load ${orderNo}: ${first ? placeOf(first) : '?'} to ${last ? placeOf(last) : '?'}${copiedFromNo ? ` (copy of ${copiedFromNo})` : ''}`;
      await Promise.allSettled(to.map((email) => sendEmail({ email, subject, message: html })));
    } catch (err) {
      console.error('New-load email failed:', err?.message || err);
    }
  });
}

module.exports = { notifyNewOrder, buildNewOrderEmail, orderFigures, placeOf, recipientsOf };
