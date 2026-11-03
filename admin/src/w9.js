
// IRS Form W-9 (Rev. March 2024), taken electronically. The IRS lets a requester take W-9s
// electronically when the system (Instructions for the Requester of Form W-9):
//   - makes sure the information received is the information sent (record_sha256: a keyed fingerprint),
//   - documents every access that results in a submission (signed_at, user, IP, browser),
//   - makes reasonably certain the person submitting is the person on the form (an emailed
//     invitation plus a password, or a signed-in account and its password),
//   - provides the same information as the paper form (every line below),
//   - can supply a hard copy if the IRS asks (the printable record), and
//   - ends with an electronic signature under penalties of perjury, using the form's own words.
// Check for a newer revision each year at irs.gov/FormW9; a June 2026 draft was not final as of
// November 2026.
export const FORM_REVISION = 'Rev. March 2024';

export const TAX_CLASSES = {
  individual: 'Individual/sole proprietor',
  c_corp: 'C corporation',
  s_corp: 'S corporation',
  partnership: 'Partnership',
  trust_estate: 'Trust/estate',
  llc: 'LLC',
  other: 'Other',
};
export const LLC_CLASSES = { C: 'C corporation', S: 'S corporation', P: 'Partnership' };
// Line 4. Exempt payee codes 1-13 and FATCA exemption codes A-M (see the form's instructions).
export const EXEMPT_PAYEE_CODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
export const FATCA_CODES = 'ABCDEFGHIJKLM'.split('');
export const STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'AS', 'GU', 'MP', 'PR', 'VI', 'AA', 'AE', 'AP'];

// Part II, word for word from the form.
export const CERTIFICATION = {
  lead: 'Under penalties of perjury, I certify that:',
  items: [
    'The number shown on this form is my correct taxpayer identification number (or I am waiting for a number to be issued to me); and',
    'I am not subject to backup withholding because (a) I am exempt from backup withholding, or (b) I have not been notified by the Internal Revenue Service (IRS) that I am subject to backup withholding as a result of a failure to report all interest or dividends, or (c) the IRS has notified me that I am no longer subject to backup withholding; and',
    'I am a U.S. citizen or other U.S. person (defined below); and',
    'The FATCA code(s) entered on this form (if any) indicating that I am exempt from FATCA reporting is correct.',
  ],
  instructions: 'Certification instructions. You must cross out item 2 above if you have been notified by the IRS that you are currently subject to backup withholding because you have failed to report all interest and dividends on your tax return.',
  usPerson: 'Definition of a U.S. person. For federal tax purposes, you are considered a U.S. person if you are an individual who is a U.S. citizen or U.S. resident alien; a partnership, corporation, company, or association created or organized in the United States or under the laws of the United States; an estate (other than a foreign estate); or a domestic trust (as defined in Regulations section 301.7701-7).',
};

export class W9Error extends Error { constructor(field, msg) { super(msg); this.field = field; } }

const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const digits = (v) => String(v ?? '').replace(/\D/g, '');

// SSN boxes also take an ITIN (starts with 9; middle digits 50-65, 70-88, 90-92 or 94-99).
export function tinProblem(type, d) {
  if (!/^\d{9}$/.test(d)) return 'Enter all 9 digits.';
  if (/^(\d)\1{8}$/.test(d)) return 'That number isn’t valid. Check it and try again.';
  if (type === 'ein') return d.startsWith('00') ? 'An EIN can’t start with 00. Check it and try again.' : '';
  const area = d.slice(0, 3), group = Number(d.slice(3, 5)), serial = d.slice(5);
  if (area.startsWith('9')) {
    const itin = (group >= 50 && group <= 65) || (group >= 70 && group <= 88) || (group >= 90 && group <= 92) || group >= 94;
    return itin ? '' : 'That isn’t a valid SSN or ITIN. Check it and try again.';
  }
  if (area === '000' || area === '666' || group === 0 || serial === '0000') return 'That isn’t a valid Social Security number. Check it and try again.';
  return '';
}

// Checks and tidies a submitted W-9. Throws W9Error(field, message) for the first problem.
export function checkW9(b = {}) {
  const w = {
    legal_name: text(b.legal_name, 120),
    business_name: text(b.business_name, 120),
    tax_class: String(b.tax_class || ''),
    llc_class: String(b.llc_class || '').toUpperCase(),
    other_class: text(b.other_class, 80),
    foreign_owners: b.foreign_owners ? 1 : 0,
    exempt_payee_code: text(b.exempt_payee_code, 4),
    fatca_code: text(b.fatca_code, 2).toUpperCase(),
    address: text(b.address, 160),
    city: text(b.city, 80),
    state: String(b.state || '').toUpperCase(),
    zip: digits(b.zip),
    tin_type: b.tin_type === 'ein' ? 'ein' : b.tin_type === 'ssn' ? 'ssn' : '',
    tin: digits(b.tin),
    backup_withholding: b.backup_withholding ? 1 : 0,
    signature: text(b.signature, 120),
  };
  if (w.legal_name.length < 2) throw new W9Error('legal_name', 'Line 1: enter the name shown on your income tax return.');
  if (!TAX_CLASSES[w.tax_class]) throw new W9Error('tax_class', 'Line 3a: choose a federal tax classification.');
  if (w.tax_class === 'llc' && !LLC_CLASSES[w.llc_class]) throw new W9Error('llc_class', 'Line 3a: for an LLC, choose how it’s taxed: C corporation, S corporation, or partnership.');
  if (w.tax_class !== 'llc') w.llc_class = '';
  if (w.tax_class === 'other' && w.other_class.length < 2) throw new W9Error('other_class', 'Line 3a: describe the “Other” classification.');
  if (w.tax_class !== 'other') w.other_class = '';
  const flowThrough = w.tax_class === 'partnership' || w.tax_class === 'trust_estate' || (w.tax_class === 'llc' && w.llc_class === 'P');
  if (!flowThrough) w.foreign_owners = 0;
  if (w.exempt_payee_code && !EXEMPT_PAYEE_CODES.includes(w.exempt_payee_code)) throw new W9Error('exempt_payee_code', 'Line 4: the exempt payee code must be 1 through 13, or blank.');
  if (w.fatca_code && !FATCA_CODES.includes(w.fatca_code)) throw new W9Error('fatca_code', 'Line 4: the FATCA code must be a letter A through M, or blank.');
  if (w.address.length < 3) throw new W9Error('address', 'Line 5: enter your street address.');
  if (w.city.length < 2) throw new W9Error('city', 'Line 6: enter your city.');
  if (!STATES.includes(w.state)) throw new W9Error('state', 'Line 6: choose your state.');
  if (!/^\d{5}(\d{4})?$/.test(w.zip)) throw new W9Error('zip', 'Line 6: enter a 5-digit ZIP code (or ZIP+4).');
  if (!w.tin_type) throw new W9Error('tin_type', 'Part I: choose Social Security number or Employer identification number.');
  const bad = tinProblem(w.tin_type, w.tin);
  if (bad) throw new W9Error('tin', `Part I: ${bad}`);
  if (digits(b.tin_confirm) !== w.tin) throw new W9Error('tin_confirm', 'Part I: the two numbers don’t match. Type it again.');
  if (['c_corp', 's_corp', 'partnership'].includes(w.tax_class) || (w.tax_class === 'llc')) {
    if (w.tin_type !== 'ein') throw new W9Error('tin_type', 'Part I: corporations, partnerships and LLCs taxed as one give their EIN. A single-member LLC that’s a disregarded entity should choose Individual/sole proprietor on line 3a.');
  }
  if (w.signature.length < 2) throw new W9Error('signature', 'Part II: type your full name to sign.');
  if (!b.certify) throw new W9Error('certify', 'Part II: check the box to sign under penalties of perjury.');
  return w;
}

export const tinLast4 = (tin) => String(tin).slice(-4);
export const formatTin = (type, tin) => (type === 'ein' ? `${tin.slice(0, 2)}-${tin.slice(2)}` : `${tin.slice(0, 3)}-${tin.slice(3, 5)}-${tin.slice(5)}`);
export const maskedTin = (type, last4) => (type === 'ein' ? `EIN ••-•••${last4}` : `SSN •••-••-${last4}`);
export const zipText = (z) => (String(z).length === 9 ? `${z.slice(0, 5)}-${z.slice(5)}` : String(z));
export function classText(w) {
  if (w.tax_class === 'llc') return `LLC, taxed as ${LLC_CLASSES[w.llc_class] || w.llc_class}`;
  if (w.tax_class === 'other') return `Other: ${w.other_class}`;
  return TAX_CLASSES[w.tax_class] || w.tax_class;
}

// A fingerprint of exactly what was submitted (with the full number), so a stored record can be
// shown to be unchanged. mac is a keyed HMAC (sealer().fingerprint): a plain hash would let anyone
// with the database work out the number by trying every possibility.
export function recordHash(w, signedAt, mac) {
  const keys = ['legal_name', 'business_name', 'tax_class', 'llc_class', 'other_class', 'foreign_owners', 'exempt_payee_code', 'fatca_code', 'address', 'city', 'state', 'zip', 'tin_type', 'tin', 'backup_withholding', 'signature'];
  const canon = JSON.stringify([FORM_REVISION, signedAt, ...keys.map((k) => [k, w[k] ?? ''])]);
  return mac(canon);
}

// Bank details for ACH payouts. Routing numbers carry an ABA check digit.
export function routingOk(r) {
  if (!/^\d{9}$/.test(r)) return false;
  const d = r.split('').map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0 && !/^0{9}$/.test(r);
}
export function checkBank(b = {}) {
  const bank = { holder: text(b.holder, 120), routing: digits(b.routing), account: digits(b.account), type: b.type === 'savings' ? 'savings' : 'checking' };
  if (bank.holder.length < 2) throw new W9Error('holder', 'Enter the name on the bank account.');
  if (!routingOk(bank.routing)) throw new W9Error('routing', 'That routing number isn’t valid. It’s the 9 digits at the bottom left of a check.');
  if (!/^\d{4,17}$/.test(bank.account)) throw new W9Error('account', 'Enter your account number (4 to 17 digits).');
  if (digits(b.account_confirm) !== bank.account) throw new W9Error('account_confirm', 'The two account numbers don’t match. Type it again.');
  return bank;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The hard copy: every line of the form as submitted, with the signature record. Shown only to
// platform admins (each view is logged). Print it, or save it as a PDF from the browser.
export function renderW9Record({ w, tin, requester, viewedBy, viewedAt, intact }) {
  const box = (n, label, value) => `<tr><th scope="row"><span class="n">${n}</span> ${esc(label)}</th><td>${value}</td></tr>`;
  const cert = CERTIFICATION.items.map((t, i) => `<li${i === 1 && w.backup_withholding ? ' class="struck"' : ''}>${esc(t)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Form W-9 record: ${esc(w.legal_name)}</title>
<style>body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f2b;background:#fff}main{max-width:820px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.4rem;margin:0}.muted{color:#5b6475;font-size:.85rem}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #c9ced8;padding:8px 10px;text-align:left;vertical-align:top}
th{width:42%;font-weight:600;background:#f6f7f9}.n{display:inline-block;min-width:1.6em;font-weight:700}.cert{border:2px solid #1a1f2b;padding:12px 16px}.cert ol{margin:8px 0;padding-left:22px}
.struck{text-decoration:line-through}.warn{background:#fff4e5;border:1px solid #f0b35b;padding:10px 12px;border-radius:6px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;overflow-wrap:anywhere}
@media print{.noprint{display:none}main{padding:0}}</style></head><body><main>
<p class="muted noprint">Confidential: contains a full taxpayer identification number. Keep printed or saved copies secure. This view was logged (${esc(viewedBy)}, ${esc(viewedAt)} UTC).</p>
<h1>Form W-9 (${esc(FORM_REVISION)}) · Request for Taxpayer Identification Number and Certification</h1>
<p class="muted">Submitted electronically to ${esc(requester)} · Department of the Treasury, Internal Revenue Service form, completed online</p>
${w.backup_withholding ? '<p class="warn"><strong>Subject to backup withholding.</strong> The payee crossed out item 2: the IRS has notified them that they are currently subject to backup withholding.</p>' : ''}
<table>
${box('1', 'Name of entity/individual', esc(w.legal_name))}
${box('2', 'Business name/disregarded entity name, if different', esc(w.business_name || '—'))}
${box('3a', 'Federal tax classification', esc(classText(w)))}
${box('3b', 'Foreign partners, owners, or beneficiaries', w.foreign_owners ? 'Checked' : 'Not checked')}
${box('4', 'Exemptions: exempt payee code / FATCA reporting code', `${esc(w.exempt_payee_code || '—')} / ${esc(w.fatca_code || '—')}`)}
${box('5', 'Address (number, street, and apt. or suite no.)', esc(w.address))}
${box('6', 'City, state, and ZIP code', `${esc(w.city)}, ${esc(w.state)} ${esc(zipText(w.zip))}`)}
${box('I', w.tin_type === 'ein' ? 'Employer identification number' : 'Social security number', `<strong class="mono" style="font-size:1rem">${esc(formatTin(w.tin_type, tin))}</strong>`)}
</table>
<section class="cert"><p><strong>Part II · Certification.</strong> ${esc(CERTIFICATION.lead)}</p><ol>${cert}</ol><p class="muted">${esc(CERTIFICATION.instructions)}</p>
<p><strong>Signature of U.S. person (electronic):</strong> /${esc(w.signature)}/ &nbsp; <strong>Date:</strong> ${esc(String(w.signed_at).slice(0, 10))}</p></section>
<h2 style="font-size:1rem;margin-top:24px">Electronic submission record</h2>
<table>
${box('', 'Signed at (UTC)', esc(w.signed_at))}
${box('', 'Signed in as', esc(w.signer_email || '—'))}
${box('', 'IP address', esc(w.ip || '—'))}
${box('', 'Browser', `<span class="mono">${esc(w.ua || '—')}</span>`)}
${box('', 'Record fingerprint (HMAC-SHA256)', `<span class="mono">${esc(w.record_sha256)}</span>${intact === true ? '<br>Matches the values above.' : intact === false ? '<br><strong>Doesn’t match the values above.</strong>' : ''}`)}
</table>
<p class="muted">The fingerprint is computed with a secret key from every value above, including the full number, when the form was signed. If any value had changed, it wouldn’t match.</p>
</main></body></html>`;
}
