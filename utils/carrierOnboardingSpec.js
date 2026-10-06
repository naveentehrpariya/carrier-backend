/**
 * Carrier setup packet — the ONE definition of what the form asks.
 *
 * The public page renders itself from this spec (served by the API), the server
 * sanitizes and validates against it, and the PDF + email print from it. Three
 * copies of a field list is how a question gets asked on screen and never printed.
 *
 * Conditions are declarative (`showIf: {field, in:[...]}`) so the spec can be
 * sent to the browser as JSON. A hidden field is never required and its value is
 * dropped — a carrier who answers "no factoring" must not leave a factoring
 * company on their record from an earlier answer.
 */

const YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

// From page 4 of the CMC packet. The source table's text layer is partly broken,
// so the values below are the best reading of it — keep them here, in one place.
const PAYMENT_OPTIONS = [
  { value: 'standard', label: 'Standard — Paper Check', period: 'Under 30 days', charge: 'No charge', needsBank: false },
  { value: 'quick_pay', label: 'Quick Pay', period: '5 business days', charge: '4%', needsBank: false },
  { value: 'efs', label: 'EFS Check', period: '1 day', charge: '5%', needsBank: false },
  { value: 'ach', label: 'ACH', period: '3 days', charge: '2%', needsBank: true },
  { value: 'direct_deposit', label: 'Direct Deposit', period: '3 days', charge: '3%', needsBank: true },
  { value: 'wire', label: 'Wire', period: '2 days', charge: '5%', needsBank: true },
];
const BANK_METHODS = PAYMENT_OPTIONS.filter((p) => p.needsBank).map((p) => p.value);

const EQUIPMENT = ['Dry Van', 'Reefer', 'Flatbed', 'Step Deck', 'Conestoga', 'RGN / Lowboy', 'Power Only', 'Tanker', 'Box Truck', 'Hotshot', 'Other']
  .map((v) => ({ value: v, label: v }));

const SECTIONS = [
  {
    key: 'company',
    title: 'Carrier profile',
    intro: 'Your company as it appears on your operating authority.',
    fields: [
      { key: 'legalName', label: 'Carrier legal name', required: true, max: 160 },
      { key: 'dbaName', label: 'DBA (if any)', max: 160 },
      { key: 'mcNumber', label: 'MC #', required: true, max: 20 },
      { key: 'dotNumber', label: 'USDOT #', required: true, max: 20 },
      { key: 'address', label: 'Street address', required: true, max: 200, full: true },
      { key: 'city', label: 'City', required: true, max: 80 },
      { key: 'state', label: 'State / Province', required: true, max: 60 },
      { key: 'zip', label: 'ZIP / Postal code', required: true, max: 20 },
      { key: 'country', label: 'Country', type: 'select', required: true, options: [{ value: 'USA', label: 'USA' }, { value: 'Canada', label: 'Canada' }] },
      { key: 'phone', label: 'Main phone', type: 'phone', required: true, max: 30 },
      { key: 'fax', label: 'Fax', type: 'phone', max: 30 },
      { key: 'email', label: 'Main email', type: 'email', required: true, max: 160 },
      { key: 'dispatchEmail', label: 'Dispatch email', type: 'email', max: 160 },
      { key: 'contactName', label: 'Primary contact name', required: true, max: 120 },
      { key: 'contactTitle', label: 'Contact title', max: 80 },
      { key: 'afterHoursPhone', label: 'After-hours phone', type: 'phone', max: 30 },
      { key: 'yearsInBusiness', label: 'Years in business', type: 'number', max: 4 },
      { key: 'powerUnits', label: 'Number of trucks', type: 'number', max: 6 },
      { key: 'trailers', label: 'Number of trailers', type: 'number', max: 6 },
      { key: 'equipment', label: 'Equipment types', type: 'multi', options: EQUIPMENT, full: true },
      { key: 'serviceAreas', label: 'Lanes / service areas', type: 'textarea', max: 500, full: true },
    ],
  },
  {
    key: 'safety',
    title: 'Safety questionnaire',
    fields: [
      { key: 'operationsManager', label: 'Operations manager', required: true, max: 120 },
      { key: 'opsPhone', label: 'Phone', type: 'phone', required: true, max: 30 },
      { key: 'opsExt', label: 'Ext', max: 10 },
      { key: 'opsPhone2', label: 'Phone 2', type: 'phone', max: 30 },
      { key: 'followsDot', label: 'Does your company follow DOT regulations?', type: 'radio', required: true, options: YES_NO, full: true },
      {
        key: 'safetyRating', label: 'Your safety rating per the FMCSA', type: 'radio', required: true, full: true,
        options: ['Satisfactory', 'Unsatisfactory', 'Conditional', 'None'].map((v) => ({ value: v, label: v })),
      },
      { key: 'logsManagerName', label: "Who manages your drivers' logs? — Name", required: true, max: 120 },
      { key: 'logsPhone', label: 'Logs contact phone', type: 'phone', max: 30 },
      { key: 'logsFax', label: 'Logs contact fax', type: 'phone', max: 30 },
      { key: 'logsEmail', label: 'Logs contact email', type: 'email', max: 160 },
    ],
  },
  {
    key: 'insurance',
    title: 'Insurance',
    intro: 'We will ask your agent for a certificate naming us as certificate holder with a 30-day cancellation notice.',
    fields: [
      { key: 'agentName', label: "Insurance agent's name", required: true, max: 120 },
      { key: 'agencyName', label: 'Agency', max: 160 },
      { key: 'agentPhone', label: 'Agent phone', type: 'phone', required: true, max: 30 },
      { key: 'agentFax', label: 'Agent fax', type: 'phone', max: 30 },
      { key: 'agentEmail', label: 'Agent email', type: 'email', required: true, max: 160 },
      { key: 'insurer', label: 'Insurance company', max: 160 },
      { key: 'autoPolicyNo', label: 'Auto liability policy #', max: 60 },
      { key: 'autoLimit', label: 'Auto liability limit (min $1,000,000)', max: 30 },
      { key: 'cargoPolicyNo', label: 'Cargo policy #', max: 60 },
      { key: 'cargoLimit', label: 'Cargo limit (min $100,000)', max: 30 },
      { key: 'generalLimit', label: 'General liability limit (min $1,000,000)', max: 30 },
      { key: 'insuranceExpiry', label: 'Certificate expiry date', type: 'date', required: true },
    ],
  },
  {
    key: 'compliance',
    title: 'Tax & compliance',
    fields: [
      { key: 'taxIdType', label: 'Tax ID type', type: 'select', required: true, options: [{ value: 'EIN', label: 'EIN (US)' }, { value: 'SSN', label: 'SSN (US)' }, { value: 'BN', label: 'Business Number (Canada)' }] },
      { key: 'taxId', label: 'Taxpayer identification number', required: true, max: 30, sensitive: true },
      { key: 'workersComp', label: "Do you carry workers' compensation insurance?", type: 'radio', required: true, options: YES_NO, full: true },
      { key: 'wcCarrier', label: "Workers' comp insurer", max: 160, showIf: { field: 'workersComp', in: ['yes'] }, required: true },
      { key: 'wcPolicyNo', label: "Workers' comp policy #", max: 60, showIf: { field: 'workersComp', in: ['yes'] }, required: true },
      { key: 'wcExpiry', label: "Workers' comp expiry", type: 'date', showIf: { field: 'workersComp', in: ['yes'] } },
      {
        key: 'wcExemptReason', label: 'Reason for not carrying it', type: 'select', required: true, full: true,
        showIf: { field: 'workersComp', in: ['no'] },
        options: [
          { value: 'sole_proprietor', label: 'Sole proprietor / owner-operator with no employees' },
          { value: 'not_required', label: 'Not required by my state / province' },
          { value: 'other', label: 'Other' },
        ],
      },
      { key: 'usAuthority', label: 'Do you hold U.S. motor carrier authority?', type: 'radio', required: true, options: YES_NO, full: true },
      { key: 'hazmat', label: 'Are you hazmat certified?', type: 'radio', required: true, options: YES_NO, full: true },
      { key: 'hazmatRegNo', label: 'Hazmat registration #', max: 60, showIf: { field: 'hazmat', in: ['yes'] }, required: true },
      { key: 'hazmatExpiry', label: 'Hazmat registration expiry', type: 'date', showIf: { field: 'hazmat', in: ['yes'] } },
    ],
  },
  {
    key: 'payment',
    title: 'Payment & factoring',
    fields: [
      { key: 'paymentMethod', label: 'How would you like to be paid?', type: 'payment', required: true, options: PAYMENT_OPTIONS, full: true },
      { key: 'invoiceEmail', label: 'Email we should expect your invoices from', type: 'email', max: 160 },
      { key: 'bankName', label: 'Bank name', max: 120, showIf: { field: 'paymentMethod', in: BANK_METHODS }, required: true },
      { key: 'accountName', label: 'Name on account', max: 120, showIf: { field: 'paymentMethod', in: BANK_METHODS }, required: true },
      { key: 'accountType', label: 'Account type', type: 'select', showIf: { field: 'paymentMethod', in: BANK_METHODS }, required: true, options: [{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }] },
      { key: 'routingNumber', label: 'Routing / transit number', max: 30, showIf: { field: 'paymentMethod', in: BANK_METHODS }, required: true },
      { key: 'accountNumber', label: 'Account number', max: 30, showIf: { field: 'paymentMethod', in: BANK_METHODS }, required: true, sensitive: true },
      { key: 'usesFactoring', label: 'Do you use a factoring company?', type: 'radio', required: true, options: YES_NO, full: true },
      { key: 'factoringCompany', label: 'Factoring company (receives the payment)', max: 160, showIf: { field: 'usesFactoring', in: ['yes'] }, required: true },
      { key: 'factoringContact', label: 'Factoring contact', max: 120, showIf: { field: 'usesFactoring', in: ['yes'] } },
      { key: 'factoringPhone', label: 'Factoring phone', type: 'phone', max: 30, showIf: { field: 'usesFactoring', in: ['yes'] } },
      { key: 'factoringEmail', label: 'Factoring email', type: 'email', max: 160, showIf: { field: 'usesFactoring', in: ['yes'] } },
      { key: 'factoringAddress', label: 'Factoring remit-to address', max: 250, full: true, showIf: { field: 'usesFactoring', in: ['yes'] }, required: true },
    ],
  },
];

// Documents the carrier attaches. `requiredIf` uses the same condition shape.
const DOCUMENTS = [
  { kind: 'coi', label: 'Certificate of insurance (cargo & liability)', required: true, docType: 'coi' },
  { kind: 'w9', label: 'W-9 form', requiredIf: { field: 'country', in: ['USA'] }, docType: 'w9', hint: 'Required for US carriers.' },
  { kind: 'authority', label: 'U.S. motor carrier authority (MC letter)', requiredIf: { field: 'usAuthority', in: ['yes'] }, showIf: { field: 'usAuthority', in: ['yes'] }, docType: 'authority' },
  { kind: 'workers_comp', label: "Workers' compensation certificate", showIf: { field: 'workersComp', in: ['yes'] }, docType: 'insurance' },
  { kind: 'hazmat', label: 'Hazmat registration', requiredIf: { field: 'hazmat', in: ['yes'] }, showIf: { field: 'hazmat', in: ['yes'] }, docType: 'permit' },
  { kind: 'noa', label: 'Notice of assignment / factoring letter', requiredIf: { field: 'usesFactoring', in: ['yes'] }, showIf: { field: 'usesFactoring', in: ['yes'] }, docType: 'noa' },
  { kind: 'void_cheque', label: 'Voided cheque / bank letter', requiredIf: { field: 'paymentMethod', in: BANK_METHODS }, showIf: { field: 'paymentMethod', in: BANK_METHODS }, docType: 'other' },
  { kind: 'other', label: 'Anything else', docType: 'other', multiple: true },
];

const ACKNOWLEDGEMENTS = [
  { key: 'noDoubleBrokering', label: 'I confirm we do not double broker freight, and will not re-broker any load tendered to us.' },
  { key: 'agreementAccepted', label: 'I have read the Broker / Carrier Agreement and agree to be bound by it.' },
  { key: 'electronicSignature', label: 'I agree that my electronic signature is the legal equivalent of my handwritten signature.' },
];

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);
const FIELD_BY_KEY = Object.fromEntries(ALL_FIELDS.map((f) => [f.key, f]));
const EMAIL_RE = /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]{2,}$/;

function conditionMet(cond, data) {
  if (!cond) return true;
  const v = data?.[cond.field];
  return Array.isArray(cond.in) ? cond.in.includes(v) : true;
}
const isShown = (field, data) => conditionMet(field.showIf, data);

function clean(v, max = 500) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

/**
 * Whitelist + trim + drop hidden answers. Never throws — the draft endpoint saves
 * half-filled forms, so completeness is `validate()`'s job, not this one's.
 */
function sanitize(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const f of ALL_FIELDS) {
    const raw = src[f.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (f.type === 'multi') {
      const allowed = new Set(f.options.map((o) => o.value));
      const arr = (Array.isArray(raw) ? raw : [raw]).map((x) => clean(x, 60)).filter((x) => allowed.has(x));
      if (arr.length) out[f.key] = [...new Set(arr)];
      continue;
    }
    let v = clean(raw, f.max || 200);
    if (!v) continue;
    if (['select', 'radio', 'payment'].includes(f.type) && !f.options.some((o) => o.value === v)) continue;
    if (f.type === 'email') v = v.toLowerCase();
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    if (f.type === 'number' && !/^\d+$/.test(v)) continue;
    out[f.key] = v;
  }
  for (const f of ALL_FIELDS) if (!isShown(f, out)) delete out[f.key];
  const ack = {};
  for (const a of ACKNOWLEDGEMENTS) if (src.acknowledgements?.[a.key] === true) ack[a.key] = true;
  if (Object.keys(ack).length) out.acknowledgements = ack;
  return out;
}

/** Returns [{key, label, message}] — empty when the packet is complete. */
function validate(data = {}, files = []) {
  const errors = [];
  for (const f of ALL_FIELDS) {
    if (!isShown(f, data)) continue;
    const v = data[f.key];
    const empty = v === undefined || v === '' || (Array.isArray(v) && !v.length);
    if (f.required && empty) { errors.push({ key: f.key, label: f.label, message: `${f.label} is required.` }); continue; }
    if (!empty && f.type === 'email' && !EMAIL_RE.test(v)) errors.push({ key: f.key, label: f.label, message: `${f.label} is not a valid email.` });
  }
  for (const d of DOCUMENTS) {
    const needed = d.required || (d.requiredIf && conditionMet(d.requiredIf, data));
    if (needed && !files.some((x) => x.kind === d.kind)) errors.push({ key: `file:${d.kind}`, label: d.label, message: `Please attach: ${d.label}.` });
  }
  for (const a of ACKNOWLEDGEMENTS) {
    if (!data.acknowledgements?.[a.key]) errors.push({ key: `ack:${a.key}`, label: a.label, message: 'Please tick every confirmation before signing.' });
  }
  return errors;
}

/** `••••1234` — what is kept once the full value has gone out by email. */
function maskValue(v) {
  const s = String(v || '').replace(/\s/g, '');
  if (!s) return '';
  return s.length <= 4 ? '•'.repeat(s.length) : `••••${s.slice(-4)}`;
}
function maskSensitive(data = {}) {
  const out = { ...data };
  for (const f of ALL_FIELDS) if (f.sensitive && out[f.key]) out[f.key] = maskValue(out[f.key]);
  return out;
}

/** Human-readable value for the PDF / email / dashboard. */
function displayValue(field, value) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.join(', ');
  if (field?.options) {
    const o = field.options.find((x) => x.value === value);
    if (o) return field.type === 'payment' ? `${o.label} — ${o.period}, ${o.charge}` : o.label;
  }
  return String(value);
}

/** The spec as JSON for the browser. */
function publicSpec() {
  return { sections: SECTIONS, documents: DOCUMENTS, acknowledgements: ACKNOWLEDGEMENTS, paymentOptions: PAYMENT_OPTIONS };
}

module.exports = {
  SECTIONS, DOCUMENTS, ACKNOWLEDGEMENTS, PAYMENT_OPTIONS, BANK_METHODS, FIELD_BY_KEY, ALL_FIELDS,
  conditionMet, isShown, sanitize, validate, maskValue, maskSensitive, displayValue, publicSpec,
};
