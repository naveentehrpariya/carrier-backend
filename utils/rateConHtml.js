/**
 * Server-side RATE CONFIRMATION — for one LEG, to one carrier.
 *
 * An order used to have one carrier, so one rate confirmation for the whole load was the same
 * document either way. An order can now be split across two carriers and our own truck, and a
 * rate confirmation is a contract with ONE carrier for the work THEY do: their stops, their miles,
 * their money. Sending a carrier the whole order's paperwork would tell them about stops they never
 * see and a rate that is not theirs.
 *
 * Built on the server from the order and trip ids, like the customer invoice and for the same
 * reason: the permission check, the tenant scope and the numbers are then all decided here rather
 * than posted in as markup (see orderController.customerInvoicePdf).
 *
 * CURRENCY. The document states the one amount that was agreed, in the currency it was agreed in.
 * Nothing is live-converted — same rule as the invoice and the cheque.
 */

const { getOrderNumber } = require('./orderNumber');

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

// A stop date is stored as a bare 'YYYY-MM-DD'. Parsing that as local time shifts it a day west of
// UTC, so the document would print the day before the truck is actually due. Same rule as the
// invoice and the cheque.
const fmtDate = (d) => {
  if (!d) return '';
  const dt = (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? new Date(`${d}T00:00:00Z`) : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/**
 * Rate confirmation number. DETERMINISTIC — the same leg downloaded twice must carry the same
 * number, because that number is what the carrier quotes back on their invoice. (The old
 * client-side invoice number mixed in Math.random(); do not repeat that here.)
 *
 * Shape: `<ORDER NUMBER>-L<leg no>`, e.g. `CMC-1013-L2`. An order with a single carrier leg still
 * reads naturally, and a second carrier's document is visibly a different one.
 */
function buildRateConNo({ order, trip, company, tenantId }) {
  const orderNo = getOrderNumber({ order, company, tenantId });
  const legNo = Number(trip?.trip_no || 1);
  return `${orderNo}-L${legNo}`;
}

const DEFAULT_TERMS = `Carrier is responsible to confirm the actual weight and count received from the shipper before transit.
Additional fees such as loading/unloading, pallet exchange, etc., are included in the agreed rate.
POD must be submitted within 5 days of delivery.
Freight charges include $100 for MacroPoint tracking. Non-compliance may lead to deduction.
Cross-border shipments require custom stamps or deductions may apply.`;

const LABEL = 'font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#6b7280;margin-bottom:2px;';
const VALUE = 'font-size:11px;font-weight:600;color:#111827;';
const SECTION = 'font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#2563eb;margin-bottom:8px;';
const TD = 'padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:11px;vertical-align:top;';
const TH = `${TD}font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #e5e7eb;`;
const NOBREAK = 'page-break-inside:avoid;break-inside:avoid;';

/**
 * The logo is the one value interpolated into an HTML ATTRIBUTE rather than into text, so it cannot
 * go through `esc` without breaking the base64 payload. It is accepted only as a `data:` image URI —
 * which is what utils/pdfBranding.js produces — and rejected if it contains a quote or angle bracket
 * that could close the attribute and inject markup into the rendered document.
 */
const safeLogo = (v) => {
  const s = String(v || '');
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*$/.test(s)) return '';
  return s;
};

const field = (label, value) => (value === '' || value === null || value === undefined
  ? ''
  : `<div><div style="${LABEL}">${esc(label)}</div><div style="${VALUE}">${esc(value)}</div></div>`);

/** Every stop of the order, flattened, with its position — leg indexes address stops by position. */
function flattenStops(order) {
  const out = [];
  (Array.isArray(order?.shipping_details) ? order.shipping_details : []).forEach((s) => {
    (Array.isArray(s?.locations) ? s.locations : []).forEach((l) => out.push(l));
  });
  return out;
}

/**
 * The stops THIS leg covers. `start_stop_index` / `end_stop_index` are positions into the flattened
 * stop list. Out-of-range indexes are clamped rather than silently producing an empty document —
 * a rate confirmation with no stops on it is worse than one that shows the whole route.
 */
function legStops(order, trip) {
  const all = flattenStops(order);
  if (!all.length) return [];
  const last = all.length - 1;
  let a = Number(trip?.start_stop_index);
  let b = Number(trip?.end_stop_index);
  if (!Number.isFinite(a)) a = 0;
  if (!Number.isFinite(b)) b = last;
  a = Math.min(Math.max(a, 0), last);
  b = Math.min(Math.max(b, 0), last);
  if (b < a) [a, b] = [b, a];
  return all.slice(a, b + 1);
}

/**
 * What this leg's carrier is owed, in the currency it was agreed in.
 *
 * `Trip.carrier_amount` is the admin-typed (or frozen, post-split) leg amount and is ALWAYS in the
 * order's input currency — see utils/carrierSettlement.js. Only when a leg carries none at all does
 * this fall back to the order's own carrier column, which is the single-carrier case where the
 * order amount IS the leg amount.
 */
/**
 * Does this leg carry an amount of its own?
 *
 * `null` means "take your share from the order's pot" — and `Number(null) === 0`, which
 * `Number.isFinite` then happily calls a number. Checking the raw value first is the only correct
 * test, and getting it wrong here made every rate confirmation print one lump sum instead of the
 * line items the carrier was quoted.
 */
const hasLegAmount = (trip) => {
  const v = trip?.carrier_amount;
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
};

function legAmount(order, trip) {
  const hasInput = Number(order?.input_carrier_amount) > 0;
  const currency = normCur(hasInput ? (order?.input_currency || 'USD') : (order?.revenue_currency || 'USD'));

  if (hasLegAmount(trip)) {
    return { amount: Number(trip.carrier_amount), currency, fromLeg: true };
  }

  const total = hasInput ? Number(order.input_carrier_amount) : Number(order?.carrier_amount || 0);
  return { amount: total, currency, fromLeg: false };
}

/**
 * Line items for the leg. A leg may carry its own `carrier_revenue_items`; otherwise the order's
 * are shown, scaled back from base into the quoted currency by the same ratio the invoice uses.
 * When neither exists the document still prints one line — the agreed amount — because a rate
 * confirmation with a total and no line is not a document a carrier can invoice against.
 */
function legLineItems(order, trip, amount) {
  const legItems = Array.isArray(trip?.carrier_revenue_items) ? trip.carrier_revenue_items : [];
  if (legItems.length) {
    // Leg items are typed in the order's currency already (they are entered against the leg).
    return legItems.map((r) => ({
      label: r?.revenue_item || 'Freight',
      note: r?.note || '',
      value: Number(r?.rate || 0) * Number(r?.quantity || 0),
    }));
  }

  const orderItems = Array.isArray(order?.carrier_revenue_items) ? order.carrier_revenue_items : [];
  // The order's lines describe the order's carrier cost. They belong on this document only while
  // this leg IS the whole carrier cost — i.e. the leg has no amount of its own. On a leg that carries
  // its own frozen share, printing the order's lines would quote another carrier's money.
  if (orderItems.length && !hasLegAmount(trip)) {
    const hasInput = Number(order?.input_carrier_amount) > 0;
    const factor = (hasInput && Number(order?.carrier_amount) > 0)
      ? Number(order.input_carrier_amount) / Number(order.carrier_amount)
      : 1;
    return orderItems.map((r) => ({
      label: r?.revenue_item || 'Freight',
      note: r?.note || '',
      value: Number(r?.rate || 0) * Number(r?.quantity || 0) * factor,
    }));
  }

  return [{ label: 'Agreed rate for this leg', note: '', value: amount }];
}

/**
 * Stops are labelled from the CARRIER's point of view, not ours.
 *
 * The first stop on their leg is where they collect and the last is where they deliver — whatever
 * we call it internally. A leg often starts at a relay, and printing "RELAY 1" on a carrier's
 * contract tells them nothing: relay is our word for handing a load between our own legs, and the
 * carrier is not part of that. They see a pickup.
 */
function stopBlock(loc, idx, total) {
  const isFirst = idx === 0;
  const isLast = idx === total - 1;
  // A single-stop leg is a pickup (there is nowhere yet to deliver to).
  const heading = isFirst ? 'PICKUP' : isLast ? 'DELIVERY' : `STOP ${idx + 1}`;
  const accent = isFirst ? '#059669' : isLast ? '#dc2626' : '#2563eb';

  // The typed address usually already contains the city and province — Places autocomplete writes
  // the whole thing into `location` — so appending them again printed
  // "55 Dock Rd, London, ON, Canada, London" on a document going to a carrier. Only add a part the
  // address does not already say. Same reason `shortStop()` exists on the payslip side.
  const base = String(loc?.location || loc?.address || '').trim();
  const seen = base.toLowerCase();
  const address = [base, loc?.city, loc?.state, loc?.zip]
    .map((v) => String(v ?? '').trim())
    .filter((v, i) => v && (i === 0 || !seen.includes(v.toLowerCase())))
    .join(', ');

  return `<div style="${NOBREAK}padding:12px 0;border-bottom:1px solid #f3f4f6;">
    <div style="display:flex;gap:12px;align-items:flex-start;">
      <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:${accent};min-width:84px;padding-top:2px;">
        ${esc(heading)}<span style="color:#9ca3af;font-weight:600;"> ${idx + 1}/${total}</span>
      </div>
      <div style="flex:1;">
        <div style="font-size:11px;font-weight:600;color:#111827;">${esc(address || 'Address not set')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin-top:6px;">
          ${field('Date', fmtDate(loc?.date))}
          ${field('Time', loc?.time || '')}
          ${field('Reference', loc?.referenceNo || '')}
          ${field('Weight', loc?.weight || '')}
          ${field('Qty', loc?.quantity || '')}
        </div>
        ${loc?.instruction ? `<div style="margin-top:6px;font-size:10px;color:#6b7280;">${esc(loc.instruction)}</div>` : ''}
      </div>
    </div>
  </div>`;
}

/**
 * @param {object}  opts
 * @param {object}  opts.order        lean order, `carrier` populated is not required
 * @param {object}  opts.trip         the leg this confirmation is for, `carrier` populated
 * @param {object}  opts.company      our company
 * @param {number}  opts.legMiles     real miles for this leg (derived, not trip.miles)
 * @param {boolean} opts.isPartial    true when the order has legs this carrier does NOT run
 */
function buildRateConHtml({
  order, trip, company, rateConNo, issuedAt = new Date(),
  logoBase64 = '', legMiles = 0, isPartial = false, tenantId = '',
}) {
  const carrier = trip?.carrier && typeof trip.carrier === 'object' ? trip.carrier : (order?.carrier || {});
  const { amount, currency } = legAmount(order, trip);
  const items = legLineItems(order, trip, amount);
  const total = items.reduce((a, r) => a + Number(r.value || 0), 0);
  const stops = legStops(order, trip);
  const orderNo = getOrderNumber({ order, company, tenantId });
  const terms = String(company?.rate_confirmation_terms || DEFAULT_TERMS)
    .split('\n').map((l) => l.trim()).filter(Boolean);

  const carrierAddress = [carrier?.location, carrier?.address, carrier?.city, carrier?.state, carrier?.zip]
    .filter(Boolean).join(', ');

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  /* An explicit light scheme: a Chrome running a dark colour-scheme preference otherwise inverts
     the whole document, which is how a printed cheque came out black. */
  :root { color-scheme: light; }
  @page { margin: 0; size: A4; }
  * { box-sizing: border-box; }
  body { margin:0; background:#fff; color:#111827; font-family:'IBM Plex Sans', Arial, Helvetica, sans-serif; font-size:11px; }
</style></head>
<body>
<div style="width:794px;background:#fff;">

  <div style="${NOBREAK}padding:28px 36px 20px;border-bottom:2px solid #111827;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <div style="font-size:22px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Rate Confirmation</div>
        <div style="font-size:12px;color:#374151;font-weight:500;">${esc(company?.name || '')}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px;">${esc(company?.address || '')}</div>
        <div style="font-size:11px;color:#6b7280;">${esc([company?.email, company?.phone].filter(Boolean).join(' · '))}</div>
      </div>
      <div style="text-align:right;">
        ${safeLogo(logoBase64) ? `<img src="${safeLogo(logoBase64)}" alt="" style="height:44px;width:auto;object-fit:contain;display:block;margin-left:auto;margin-bottom:8px;" />` : ''}
        <div style="font-size:13px;font-weight:700;">${esc(rateConNo)}</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px;">Order ${esc(orderNo)}</div>
        <div style="font-size:10px;color:#6b7280;">${esc(fmtDate(issuedAt))}</div>
      </div>
    </div>
  </div>

  ${isPartial ? `<div style="${NOBREAK}margin:0;padding:10px 36px;background:#fffbeb;border-bottom:1px solid #fde68a;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#92400e;">Part of a larger order</div>
    <div style="font-size:11px;color:#78350f;margin-top:3px;">
      This confirmation covers leg ${esc(trip?.trip_no || 1)} only. The rest of order ${esc(orderNo)} is moved separately;
      the stops and the rate below are the ones you are contracted for.
    </div>
  </div>` : ''}

  <div style="${NOBREAK}display:grid;grid-template-columns:1fr 1fr;padding:16px 36px;border-bottom:1px solid #e5e7eb;">
    <div style="padding-right:24px;border-right:1px solid #e5e7eb;">
      <div style="${SECTION}">FROM</div>
      <div style="font-size:12px;font-weight:600;margin-bottom:3px;">${esc(company?.name || '')}</div>
      <div style="font-size:11px;color:#6b7280;line-height:1.7;">
        <div>${esc(company?.email || '')}</div><div>${esc(company?.phone || '')}</div><div>${esc(company?.address || '')}</div>
      </div>
    </div>
    <div style="padding-left:24px;">
      <div style="${SECTION}">CARRIER</div>
      <div style="font-size:12px;font-weight:600;margin-bottom:3px;text-transform:uppercase;">
        ${esc(carrier?.name || 'Carrier not set')}
        ${carrier?.mc_code ? `<span style="font-size:10px;color:#6b7280;font-weight:500;margin-left:6px;text-transform:none;">MC${esc(carrier.mc_code)}</span>` : ''}
      </div>
      <div style="font-size:11px;color:#6b7280;line-height:1.7;">
        <div>${esc([carrier?.phone, carrier?.secondary_phone].filter(Boolean).join(', '))}</div>
        <div>${esc(String(carrier?.email || '').trim())}</div>
        <div>${esc(carrierAddress)}</div>
      </div>
    </div>
  </div>

  <div style="${NOBREAK}display:flex;flex-wrap:wrap;gap:20px;padding:14px 36px;border-bottom:1px solid #e5e7eb;">
    ${field('Order No', orderNo)}
    ${field('Leg', `${trip?.trip_no || 1}`)}
    ${field('Leg distance', legMiles > 0 ? `${Number(legMiles).toFixed(2)} mi` : '')}
    ${field('Customer Order No', order?.customer_order_no || '')}
    ${field('Equipment', trip?.trailer?.type || order?.equipment || '')}
  </div>

  <div style="padding:0 36px;">
    <div style="padding-top:14px;"><div style="${SECTION}">Stops on this leg</div></div>
    ${stops.length
      ? stops.map((l, i) => stopBlock(l, i, stops.length)).join('')
      : '<div style="padding:12px 0;font-size:11px;color:#6b7280;">No stops recorded for this leg.</div>'}
  </div>

  <div style="${NOBREAK}padding:18px 36px;">
    <div style="${SECTION}">Agreed rate</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr><th style="${TH}text-align:left;">Item</th><th style="${TH}text-align:left;">Note</th><th style="${TH}text-align:right;">Amount</th></tr></thead>
      <tbody>
        ${items.map((r) => `<tr>
          <td style="${TD}">${esc(r.label)}</td>
          <td style="${TD}color:#6b7280;">${esc(r.note)}</td>
          <td style="${TD}text-align:right;font-weight:600;">${esc(fmtMoney(r.value, currency))}</td>
        </tr>`).join('')}
        <tr>
          <td style="${TD}border-bottom:none;"></td>
          <td style="${TD}border-bottom:none;text-align:right;font-weight:700;">Total</td>
          <td style="${TD}border-bottom:none;text-align:right;font-weight:700;font-size:13px;">${esc(fmtMoney(total, currency))}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div style="${NOBREAK}padding:0 36px 18px;">
    <div style="${SECTION}">Terms &amp; Conditions</div>
    ${terms.map((l) => `<div style="font-size:10px;color:#4b5563;line-height:1.7;">• ${esc(l)}</div>`).join('')}
  </div>

  <div style="${NOBREAK}padding:0 36px 32px;display:grid;grid-template-columns:1fr 1fr;gap:36px;">
    <div>
      <div style="font-size:10px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Carrier Signature</div>
      <div style="border-bottom:1px solid #9ca3af;height:34px;"></div>
      <div style="font-size:10px;color:#9ca3af;margin-top:4px;">Authorized signature required</div>
    </div>
    <div>
      <div style="font-size:10px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">Date</div>
      <div style="border-bottom:1px solid #9ca3af;height:34px;"></div>
    </div>
  </div>

</div>
</body></html>`;
}

module.exports = { buildRateConHtml, buildRateConNo, legStops, legAmount, legLineItems };
