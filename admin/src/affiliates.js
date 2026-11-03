// Affiliate (referral revenue-share) program: constants and small pure helpers used by server.js.
// Agilities pays an affiliate a share of HitchPoint's net platform fee on online payments made by
// businesses it referred. See the "affiliates" block in server.js and public/legal/affiliate-terms.html.

// Bump when public/legal/affiliate-terms.html changes: affiliates are asked to accept again.
// 2026-11-02.2: earnings are shown by month. 2026-11-03.1: people and groups can join by invitation;
// W-9s and payout details are taken online and encrypted.
export const AFFILIATE_TERMS_VERSION = '2026-11-03.1';

export const CODE_RE = /^[a-z0-9-]{3,40}$/;
export const HOLD_DAYS = 30; // earnings wait this long after the payment (refunds and disputes)
export const MIN_PAYOUT_CENTS = 2500;
export const REF_COOKIE = 'hp_ref';
export const REF_COOKIE_DAYS = 90;
export const PAYOUT_METHODS = ['ach', 'check', 'stripe', 'other'];
export const CLICKS_PER_IP_HOUR = 20; // clicks counted per visitor IP per hour; the redirect always works

export const normalizeCode = (v) => String(v ?? '').trim().toLowerCase();

// Default code from a business's web address (slug): lowercase letters, numbers and dashes, 3 to 40 long.
export function codeFromSlug(slug) {
  let c = normalizeCode(slug).replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (c.length < 3) c = (c ? c + '-' : '') + 'ref';
  return c;
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// Link clicks from link previews, crawlers and scripts aren't counted.
export const isBot = (ua) => !ua || /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|twitter|linkedin|skype|curl|wget|python|headless/i.test(ua);

// Every CSV cell is quoted. Text that a spreadsheet could read as a formula gets a leading
// apostrophe, and control characters become spaces. Money is passed as { usd: cents }.
export function csvCell(v) {
  if (v && typeof v === 'object' && 'usd' in v) return `"${(Number(v.usd || 0) / 100).toFixed(2)}"`;
  let x = String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ');
  if (/^\s*[=+\-@]/.test(x)) x = "'" + x;
  return `"${x.replace(/"/g, '""')}"`;
}
export const csvLine = (cells) => cells.map(csvCell).join(',');
