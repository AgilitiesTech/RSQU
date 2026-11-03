// Customer Terms & Conditions for each business (the business is the seller and merchant of record).
//
// 1. The business completes a one-time "legal profile" (legal name, address, license, insurance,
//    payment and service policies). Phone, email, service area, sales tax and the visit deposit come
//    from the business's existing settings, so nothing is entered twice.
// 2. templates/customer-terms.md is filled with those details to make a personalised draft.
// 3. The OWNER reviews it, may edit the wording, and gives final approval with their name, title and
//    an attestation. Each approval is stored as a new, immutable version (customer_terms table).
// 4. Customers accept the approved version when they sign a proposal or pay online.
//
// When the template (TEMPLATE_VERSION) or any detail used in the wording changes, the business is
// asked to review and approve again. Customers keep seeing the last approved version until then.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_VERSION = 'hitchpoint-2026-11-02';
const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'customer-terms.md');

export const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export const BALANCE_DUE = {
  on_completion: { label: 'When the work is complete', terms: 'when the work is complete' },
  net_7: { label: 'Within 7 days of the invoice', terms: 'within 7 days of the invoice date' },
  net_15: { label: 'Within 15 days of the invoice', terms: 'within 15 days of the invoice date' },
  net_30: { label: 'Within 30 days of the invoice', terms: 'within 30 days of the invoice date' },
};

// Stored as JSON in tenants.legal_profile. Money in cents, percentages as plain numbers.
export const FIELDS = [
  { key: 'legalName', type: 'text', required: true, max: 120, label: 'Legal business name' },
  { key: 'addressLine1', type: 'text', required: true, max: 120, label: 'Street address' },
  { key: 'addressLine2', type: 'text', max: 120, label: 'Address line 2' },
  { key: 'city', type: 'text', required: true, max: 80, label: 'City' },
  { key: 'state', type: 'state', required: true, label: 'State' },
  { key: 'postalCode', type: 'postal', required: true, label: 'ZIP code' },
  { key: 'licenseNumber', type: 'text', max: 60, label: 'License number' },
  { key: 'licenseAuthority', type: 'text', max: 120, label: 'Licensing authority' },
  { key: 'insured', type: 'bool', def: false, label: 'Carries general liability insurance' },
  { key: 'insuranceCarrier', type: 'text', max: 120, label: 'Insurance carrier' },
  { key: 'taxConfirmed', type: 'bool', def: false, label: 'Sales tax rate confirmed' },
  { key: 'balanceDue', type: 'enum', options: Object.keys(BALANCE_DUE), def: 'on_completion', label: 'Balance due' },
  { key: 'lateFeePercent', type: 'number', min: 0, max: 10, decimals: 2, def: 0, label: 'Late fee (% per month)' },
  { key: 'returnedPaymentFeeCents', type: 'int', min: 0, max: 10000, def: 0, label: 'Returned payment fee' },
  { key: 'warrantyDays', type: 'int', required: true, min: 1, max: 3650, def: 30, label: 'Workmanship guarantee (days)' },
  { key: 'cancellationNoticeHours', type: 'int', min: 1, max: 336, def: 24, label: 'Cancellation notice (hours)' },
  { key: 'cancellationFeeCents', type: 'int', min: 0, max: 100000, def: 0, label: 'Late cancellation fee' },
  { key: 'estimateValidDays', type: 'int', min: 1, max: 365, def: 30, label: 'Estimates valid for (days)' },
  { key: 'hourlyRateCents', type: 'int', min: 0, max: 1000000, def: 0, label: 'Hourly labor rate' },
  { key: 'marketingPhotos', type: 'bool', def: false, label: 'Use non-identifying project photos in marketing' },
  { key: 'governingState', type: 'state', label: 'Governing law state' },
  { key: 'venueCounty', type: 'text', required: true, max: 60, label: 'County for legal venue' },
];

export function parseProfile(json) {
  try { return json ? JSON.parse(json) : null; } catch { return null; }
}

export function defaultProfile() {
  return Object.fromEntries(FIELDS.map((f) => [f.key, f.def ?? (f.type === 'bool' ? false : null)]));
}

/** Validate and normalise the owner's input. Returns { profile, errors }. */
export function validateProfile(input = {}) {
  const profile = {}; const errors = {};
  for (const f of FIELDS) {
    const raw = input[f.key];
    if (f.type === 'bool') { profile[f.key] = raw === true || raw === 'true' || raw === 1 || raw === 'on'; continue; }
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) {
      profile[f.key] = f.def ?? null;
      if (f.required && profile[f.key] === null) errors[f.key] = `${f.label} is required.`;
      continue;
    }
    const str = String(raw).trim();
    if (f.type === 'text') {
      profile[f.key] = str.slice(0, f.max);
    } else if (f.type === 'state') {
      profile[f.key] = str.toUpperCase();
      if (!STATE_NAMES[profile[f.key]]) errors[f.key] = 'Choose a U.S. state.';
    } else if (f.type === 'postal') {
      profile[f.key] = str;
      if (!/^\d{5}(-\d{4})?$/.test(str)) errors[f.key] = 'Enter a 5-digit ZIP code.';
    } else if (f.type === 'enum') {
      profile[f.key] = f.options.includes(str) ? str : f.def;
    } else {
      const n = Number(str);
      const intOnly = f.type === 'int';
      if (!Number.isFinite(n) || (intOnly && !Number.isInteger(n))) errors[f.key] = `${f.label} must be a ${intOnly ? 'whole ' : ''}number.`;
      else if (n < f.min || n > f.max) errors[f.key] = `${f.label} must be between ${f.min} and ${f.max}.`;
      else if (!intOnly && Math.abs(Math.round(n * 10 ** f.decimals) - n * 10 ** f.decimals) > 1e-6) errors[f.key] = `${f.label} can have at most ${f.decimals} decimal places.`;
      profile[f.key] = n;
    }
  }
  if (!profile.governingState && profile.state && !errors.state) profile.governingState = profile.state;
  if (profile.venueCounty) profile.venueCounty = profile.venueCounty.replace(/\s+county$/i, '');
  return { profile, errors };
}

/**
 * Required items still missing. Includes the business phone and email (edited on the Business
 * page) because they appear in the terms as the contact for notices.
 */
export function missingFields(tenant, profile) {
  const missing = [];
  if (!tenant.phone) missing.push('phone');
  if (!tenant.email) missing.push('email');
  if (!profile) return missing.concat(FIELDS.filter((f) => f.required).map((f) => f.key), ['taxConfirmed']);
  for (const f of FIELDS) if (f.required && (profile[f.key] === null || profile[f.key] === undefined || profile[f.key] === '')) missing.push(f.key);
  if (!profile.taxConfirmed) missing.push('taxConfirmed');
  return missing;
}

const usd = (c) => `$${(c / 100).toFixed(2)}`;

/** Values available to templates/customer-terms.md. Zero/empty values make {{#if}} blocks drop out. */
export function templateVars(tenant, profile, platformName) {
  const same = (a = '', b = '') => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');
  const address = [profile.addressLine1, profile.addressLine2, `${profile.city}, ${profile.state} ${profile.postalCode}`].filter(Boolean).join(', ');
  return {
    platform_name: platformName,
    business_name: profile.legalName,
    business_dba: tenant.name,
    dba_differs: Boolean(tenant.name) && !same(tenant.name, profile.legalName),
    business_address: address,
    business_phone: tenant.phone || '',
    business_email: tenant.email || '',
    business_website: tenant.website_url || '',
    service_area: tenant.service_area || '',
    license_number: profile.licenseNumber || '',
    license_authority: profile.licenseAuthority || '',
    insured: profile.insured,
    insurance_carrier: profile.insuranceCarrier || '',
    deposit_amount: tenant.deposit_cents ? usd(tenant.deposit_cents) : 0,
    deposit_label: tenant.deposit_label || 'Deposit',
    deposit_label_lower: (tenant.deposit_label || 'visit').toLowerCase(),
    balance_due_label: (BALANCE_DUE[profile.balanceDue] || BALANCE_DUE.on_completion).terms,
    late_fee_percent: profile.lateFeePercent || 0,
    returned_payment_fee: profile.returnedPaymentFeeCents ? usd(profile.returnedPaymentFeeCents) : 0,
    warranty_days: profile.warrantyDays,
    cancellation_notice_hours: profile.cancellationNoticeHours,
    cancellation_fee: profile.cancellationFeeCents ? usd(profile.cancellationFeeCents) : 0,
    estimate_valid_days: profile.estimateValidDays,
    hourly_rate: profile.hourlyRateCents ? usd(profile.hourlyRateCents) : 0,
    marketing_photos: profile.marketingPhotos,
    governing_state: STATE_NAMES[profile.governingState] || profile.governingState,
    venue_county: profile.venueCounty,
  };
}

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Fingerprint of everything that affects the wording; a change asks the owner to re-approve. */
export function fingerprint(vars) {
  return sha256(JSON.stringify(vars));
}

// Cached, but re-read when the file changes so template edits apply without a restart.
let cached = { mtimeMs: 0, text: '' };
function loadTemplate() {
  const { mtimeMs } = fs.statSync(TEMPLATE_PATH);
  if (mtimeMs !== cached.mtimeMs) cached = { mtimeMs, text: fs.readFileSync(TEMPLATE_PATH, 'utf8') };
  return cached.text;
}

/** Fill the template. {{field}}, {{#if field}}…{{else}}…{{/if}} (nestable). Unknown fields show as [[MISSING: …]]. */
export function renderTemplate(vars, template = loadTemplate()) {
  let text = template.replace(/<!--[\s\S]*?-->\s*/g, '');
  const innermost = /\{\{#if (\w+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/;
  let m;
  while ((m = innermost.exec(text))) {
    const [whole, field, inner] = m;
    const [yes, no = ''] = inner.split('{{else}}');
    const v = vars[field];
    const on = !(v === undefined || v === null || v === false || v === '' || v === 0);
    text = text.slice(0, m.index) + (on ? yes : no) + text.slice(m.index + whole.length);
  }
  text = text.replace(/\{\{(\w+)\}\}/g, (_, f) => (vars[f] === undefined || vars[f] === null ? `[[MISSING: ${f}]]` : String(vars[f])));
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Safe Markdown subset -> HTML (everything is escaped first, so edited terms can't inject scripts). */
export function markdownToHtml(md) {
  const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = [];
  for (const block of md.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    let para = []; let list = [];
    const flushP = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushL = () => { if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = []; };
    for (const line of block.split('\n').filter((l) => l.trim())) {
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) { flushP(); flushL(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
      else if (/^\s*-{3,}\s*$/.test(line)) { flushP(); flushL(); out.push('<hr>'); }
      else if (/^\s*[-*]\s+/.test(line)) { flushP(); list.push(line.replace(/^\s*[-*]\s+/, '')); }
      else { flushL(); para.push(line); }
    }
    flushP(); flushL();
  }
  return out.join('\n');
}

/**
 * The exact statement the owner confirms when giving final approval. Stored verbatim with the
 * approved version.
 */
export function attestationText({ name, title, legalName, platformName }) {
  return [
    `I, ${name}, ${title} of ${legalName}, confirm that:`,
    `(1) I am an owner or officer of ${legalName} and am authorized to approve these terms on its behalf;`,
    `(2) I have reviewed these Customer Terms and Conditions, have had the opportunity to have them reviewed by an attorney, and approve them as ${legalName}'s terms with its customers;`,
    `(3) ${legalName} is the seller and merchant of record for its sales and is solely responsible for these terms, its services, refunds, disputes, and collecting and remitting any sales tax; and`,
    `(4) ${platformName} provided this template for convenience, is not a party to these terms, and does not provide legal or tax advice.`,
  ].join(' ');
}
