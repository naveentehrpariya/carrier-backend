/**
 * Carrier setup packet — the filled document the carrier reviews and signs.
 *
 * One renderer for both the on-screen preview (HTML in an iframe) and the signed
 * PDF, so the carrier signs exactly what they were shown. Every value goes
 * through esc(); the two images (logo, signatures) are accepted only as
 * data:image/(png|jpeg);base64 URIs, because they sit in an attribute where
 * escaping would break the payload.
 */
const {
  SECTIONS, DOCUMENTS, ACKNOWLEDGEMENTS, PAYMENT_OPTIONS, BANK_METHODS, FIELD_BY_KEY,
  isShown, displayValue, conditionMet,
} = require('./carrierOnboardingSpec');
const { agreementClauses, TEMPLATE_VERSION } = require('./carrierAgreementText');

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const IMG_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;
const safeImg = (v) => (typeof v === 'string' && IMG_RE.test(v) ? v : '');

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-');
    return `${m}/${day}/${y}`;
  }
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' });
}
function fmtStamp(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : `${dt.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

const val = (data, key) => {
  const f = FIELD_BY_KEY[key];
  const v = f?.type === 'date' ? fmtDate(data?.[key]) : displayValue(f, data?.[key]);
  return esc(v) || '<span class="blank">—</span>';
};

function fieldTable(section, data) {
  const rows = section.fields.filter((f) => isShown(f, data)).map((f) => `
    <tr><th>${esc(f.label)}</th><td>${val(data, f.key)}</td></tr>`).join('');
  return `<table class="kv">${rows}</table>`;
}

function signatureBox({ image, name, title, date, label, signed }) {
  const img = safeImg(image);
  return `
    <div class="sig">
      <div class="sig-label">${esc(label)}</div>
      <div class="sig-img">${img ? `<img src="${img}" alt="signature" />` : (signed ? '' : '<span class="sig-empty">Not signed yet</span>')}</div>
      <div class="sig-line"></div>
      <div class="sig-meta"><b>${esc(name) || '&nbsp;'}</b>${title ? ` · ${esc(title)}` : ''}</div>
      <div class="sig-meta">Date: ${esc(fmtDate(date)) || '__________'}</div>
    </div>`;
}

function buildCarrierPacketHtml({ data = {}, files = [], broker = {}, signature = {}, logo, mode = 'preview', submittedAt }) {
  const carrierName = data.legalName || 'Carrier';
  const B = broker.name || 'Broker';
  const signed = mode === 'signed';
  const signDate = signature.signedAt || submittedAt || null;
  const logoImg = safeImg(logo);
  const section = (k) => SECTIONS.find((s) => s.key === k);

  const payment = PAYMENT_OPTIONS.map((p) => `
    <tr class="${data.paymentMethod === p.value ? 'picked' : ''}">
      <td class="box">${data.paymentMethod === p.value ? '☒' : '☐'}</td>
      <td>${esc(p.label)}</td><td>${esc(p.period)}</td><td>${esc(p.charge)}</td>
      <td>${p.needsBank ? 'Direct deposit form required' : ''}</td>
    </tr>`).join('');

  const bankRows = BANK_METHODS.includes(data.paymentMethod)
    ? ['bankName', 'accountName', 'accountType', 'routingNumber', 'accountNumber']
      .map((k) => `<tr><th>${esc(FIELD_BY_KEY[k].label)}</th><td>${val(data, k)}</td></tr>`).join('')
    : '';

  const docs = DOCUMENTS.filter((d) => !d.showIf || conditionMet(d.showIf, data)).map((d) => {
    const got = files.filter((f) => f.kind === d.kind);
    return `<tr><th>${esc(d.label)}</th><td>${got.length ? got.map((f) => `☒ ${esc(f.name || f.filename)}`).join('<br/>') : '<span class="blank">Not attached</span>'}</td></tr>`;
  }).join('');

  const acks = ACKNOWLEDGEMENTS.map((a) => `<li>${data.acknowledgements?.[a.key] ? '☒' : '☐'} ${esc(a.label)}</li>`).join('');

  const clauses = agreementClauses(broker).map((c) => `
    <p>${c.heading ? `<b>${esc(c.heading)}</b> ` : ''}${esc(c.text)}</p>`).join('');

  const carrierAddress = [data.address, data.city, data.state, data.zip, data.country].filter(Boolean).join(', ');

  const carrierSig = signatureBox({ image: signature.image, name: signature.name, title: signature.title, date: signDate, label: 'CARRIER', signed });

  const header = `
    <div class="head">
      ${logoImg ? `<img class="logo" src="${logoImg}" alt="" />` : `<div class="brand">${esc(B)}</div>`}
      <div class="head-r">Carrier Setup Packet<br/><span>${esc(carrierName)}</span></div>
    </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>Carrier Setup Packet — ${esc(carrierName)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #111; font: 10pt/1.4 Arial, Helvetica, sans-serif; }
  .page { padding: 18px 32px; ${signed ? '' : 'position: relative;'} }
  .page + .page { break-before: page; page-break-before: always; }
  .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 18px; }
  .logo { max-height: 46px; max-width: 220px; }
  .brand { font-weight: 700; font-size: 15pt; }
  .head-r { text-align: right; font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: .08em; }
  .head-r span { color: #111; font-weight: 700; text-transform: none; letter-spacing: 0; font-size: 10.5pt; }
  h1 { font-size: 20pt; margin: 0 0 6px; }
  h2 { font-size: 12pt; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  p { margin: 0 0 9px; text-align: justify; }
  table { width: 100%; border-collapse: collapse; }
  .kv th { width: 42%; text-align: left; font-weight: 600; color: #333; padding: 3.5px 8px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  .kv td { padding: 3.5px 8px; border-bottom: 1px solid #e5e5e5; }
  tr { break-inside: avoid; }
  .grid th, .grid td { border: 1px solid #bbb; padding: 5px 7px; text-align: left; font-size: 9.5pt; }
  .grid th { background: #f2f2f2; }
  .grid tr.picked td { background: #eef6ff; font-weight: 600; }
  .box { width: 26px; text-align: center; font-size: 12pt; }
  .blank { color: #999; }
  .note { background: #f6f6f6; border-left: 3px solid #111; padding: 8px 12px; font-size: 9.5pt; margin: 10px 0; }
  ul.acks { list-style: none; padding: 0; margin: 8px 0; }
  ul.acks li { margin: 4px 0; }
  .sigs { display: flex; gap: 28px; margin-top: 26px; break-inside: avoid; }
  .sig { flex: 1; }
  .sig-label { font-size: 8.5pt; font-weight: 700; letter-spacing: .08em; color: #555; }
  .sig-img { height: 70px; display: flex; align-items: flex-end; }
  .sig-img img { max-height: 66px; max-width: 100%; }
  .sig-empty { color: #bbb; font-style: italic; }
  .sig-line { border-top: 1px solid #111; margin-top: 2px; }
  .sig-meta { font-size: 9.5pt; margin-top: 3px; }
  .agreement p { font-size: 9.5pt; line-height: 1.42; }
  .cert td, .cert th { font-size: 9pt; padding: 4px 8px; border-bottom: 1px solid #e5e5e5; text-align: left; vertical-align: top; }
  .cert th { width: 30%; }
  .wm { position: fixed; top: 42%; left: 0; right: 0; text-align: center; font-size: 72pt; font-weight: 800; color: rgba(200,0,0,.08); transform: rotate(-24deg); pointer-events: none; z-index: 0; }
</style></head><body>
${signed ? '' : '<div class="wm">PREVIEW — NOT SIGNED</div>'}

<section class="page">
  ${header}
  <h1>Carrier Setup Packet</h1>
  <p>Carrier: <b>${esc(carrierName)}</b>${data.mcNumber ? ` · MC# ${esc(data.mcNumber)}` : ''}${data.dotNumber ? ` · USDOT# ${esc(data.dotNumber)}` : ''}</p>
  <p>Broker: <b>${esc(B)}</b>${broker.mc ? ` · MC# ${esc(broker.mc)}` : ''}${broker.dot ? ` · USDOT# ${esc(broker.dot)}` : ''}</p>

  <h2>Carrier profile</h2>
  ${fieldTable(section('company'), data)}
</section>

<section class="page">
  ${header}
  <h2>Carrier safety questionnaire</h2>
  ${fieldTable(section('safety'), data)}
  <div class="sigs">${carrierSig}<div class="sig"></div></div>
</section>

<section class="page">
  ${header}
  <h2>Insurance certificate request</h2>
  <div class="note">ATTENTION CARRIER APPLICANT: this page is addressed to your insurance agent.</div>
  <table class="kv">
    <tr><th>To (carrier's insurance agent)</th><td>${val(data, 'agentName')}${data.agencyName ? ` — ${esc(data.agencyName)}` : ''}</td></tr>
    <tr><th>Phone / Fax</th><td>${val(data, 'agentPhone')} / ${val(data, 'agentFax')}</td></tr>
    <tr><th>Email</th><td>${val(data, 'agentEmail')}</td></tr>
    <tr><th>Insured (carrier's company name)</th><td>${esc(carrierName)}</td></tr>
  </table>
  <p style="margin-top:12px">Dear Insurance Agent: this is to request a signed Certificate of Insurance on the above Insured.</p>
  <p><b>1. Insurance requirement:</b> Auto liability (minimum $1,000,000 policy); General liability (minimum $1,000,000 policy — required by many of our shippers/customers); Cargo liability (minimum $100,000 policy); Worker’s Compensation as required by applicable state law.</p>
  <p><b>2. Please make out the certificate to:</b> ${esc(B)}${broker.phone ? `, contact ${esc(broker.phone)}` : ''}${broker.address ? `, ${esc(broker.address)}` : ''}.</p>
  <p><b>3.</b> The company above must be named as <b>CERTIFICATE HOLDER</b> with a 30-day cancellation notice. The certificate must be signed.</p>
  ${broker.email ? `<p>Note to agents — please email the certificate to <b>${esc(broker.email)}</b>.</p>` : ''}
  <h2>Insurance on file</h2>
  ${fieldTable(section('insurance'), data)}
</section>

<section class="page">
  ${header}
  <h2>Tax, workers' compensation & authority</h2>
  ${fieldTable(section('compliance'), data)}

  <h2>Factoring information</h2>
  <table class="kv">
    <tr><th>Do you use a factoring company?</th><td>${val(data, 'usesFactoring')}</td></tr>
  </table>
  ${data.usesFactoring === 'yes' ? `
  <h2>Notice of assignment</h2>
  <p>Date: <b>${esc(fmtDate(signDate)) || '__________'}</b></p>
  <p>To: ${esc(B)}${broker.mc ? ` (MC-${esc(broker.mc)})` : ''}</p>
  <p>Please remit all payments for services performed by ${esc(carrierName)} to: <b>${val(data, 'factoringCompany')}</b>, ${val(data, 'factoringAddress')}.
  ${data.factoringContact ? `Contact: ${esc(data.factoringContact)}. ` : ''}${data.factoringPhone ? `Phone: ${esc(data.factoringPhone)}. ` : ''}${data.factoringEmail ? `Email: ${esc(data.factoringEmail)}.` : ''}</p>
  <p>Please contact us should you have any questions, and we thank you for your cooperation. Very truly yours,</p>
  <div class="sigs">${carrierSig}<div class="sig"></div></div>` : ''}
</section>

<section class="page">
  ${header}
  <h2>Payment options</h2>
  <p>Motor carriers are paid within 30 days after receipt of CARRIER INVOICE along with the ORIGINAL SIGNED BOL. Carrier must fax or email Invoice, Rate Confirmation and BOL.</p>
  <table class="grid">
    <tr><th class="box">Select</th><th>Method</th><th>Time period</th><th>Charges</th><th></th></tr>
    ${payment}
  </table>
  ${bankRows ? `<h2>Direct deposit</h2><table class="kv">${bankRows}</table>` : ''}
  <h2>Invoice options</h2>
  <p>Please email the POD and invoice to <b>${esc(broker.email) || '__________'}</b>.${data.invoiceEmail ? ` Invoices will be sent from ${esc(data.invoiceEmail)}.` : ''}</p>
  <h2>Double brokering</h2>
  <p>${esc(B)} does not allow or engage in double brokering of freight. By filling and signing our carrier packet, you agree that you are not double brokering freight with ${esc(B)}.</p>
  <h2>Documents attached</h2>
  <table class="kv">${docs}</table>
</section>

<section class="page agreement">
  ${header}
  <h2 style="margin-top:0">Broker / Carrier Agreement</h2>
  <p>This Agreement shall govern the services provided by <b>${esc(carrierName)}</b>, address <b>${esc(carrierAddress) || '__________'}</b>, a licensed and authorized motor carrier pursuant to USDOT # <b>${esc(data.dotNumber) || '______'}</b> &amp; Docket No. MC# <b>${esc(data.mcNumber) || '______'}</b> (hereinafter referred to as “Carrier”) and <b>${esc(B)}</b>, USDOT # <b>${esc(broker.dot) || '______'}</b> &amp; Docket No. MC# <b>${esc(broker.mc) || '______'}</b> (hereinafter referred to as “Broker”), a licensed property broker. Broker and Carrier agree that notwithstanding other provisions, carriage documents or regulation to the contrary, this Agreement shall govern Carrier’s performance and obligations pertaining to transportation services for freight tendered to Carrier hereunder.</p>
  ${clauses}
  <h2>Confirmations</h2>
  <ul class="acks">${acks}</ul>
  <div class="sigs">${carrierSig}<div class="sig"></div></div>
</section>

${signed ? `
<section class="page">
  ${header}
  <h2>Electronic signature record</h2>
  <table class="cert">
    <tr><th>Signed by</th><td>${esc(signature.name)}${signature.title ? `, ${esc(signature.title)}` : ''}</td></tr>
    <tr><th>On behalf of</th><td>${esc(carrierName)}${data.mcNumber ? ` (MC# ${esc(data.mcNumber)})` : ''}</td></tr>
    <tr><th>Signed at</th><td>${esc(fmtStamp(signDate))}</td></tr>
    <tr><th>IP address</th><td>${esc(signature.ip)}</td></tr>
    <tr><th>Browser</th><td>${esc(signature.userAgent)}</td></tr>
    <tr><th>Agreement version</th><td>${esc(TEMPLATE_VERSION)}</td></tr>
    <tr><th>Sensitive values</th><td>Bank account and tax id numbers are shown masked in this copy.</td></tr>
  </table>
  <p style="margin-top:12px;font-size:9pt;color:#555">The SHA-256 hash of this document was recorded by ${esc(B)} at the moment of signing.</p>
</section>` : ''}
</body></html>`;
}

module.exports = { buildCarrierPacketHtml, safeImg, fmtDate, esc };
