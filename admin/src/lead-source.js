// Where a website request came from. The business's site (public/site.js) remembers the visit that
// brought the customer: its tracking tags (utm_*), Google's click ID from an ad, the page it landed on
// and the site that linked to it. That travels with the request form and is saved on the request, so
// the owner can see which ads, profiles, partners and pages bring in work.

export const HEARD_ABOUT = ['Google search', 'Google Maps', 'Facebook or Instagram', 'Friend or family', 'Campground or RV park', 'Storage lot', 'Saw the truck', 'Other'];

const MAX_AGE_DAYS = 120; // the site keeps a visit for 90 days; a little slack for clocks

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// What the form sent, cleaned. Anything malformed is dropped rather than refused: a request is never
// lost because of its tracking details.
export function cleanSource(input, heard, nowMs = Date.now()) {
  const s = input && typeof input === 'object' ? input : {};
  const out = {
    src_source: text(s.utm_source, 120), src_medium: text(s.utm_medium, 120), src_campaign: text(s.utm_campaign, 160),
    src_term: text(s.utm_term, 200), src_content: text(s.utm_content, 160),
    src_click_id: '', src_click_type: '', src_landing: '', src_referrer: '', src_at: '',
    heard_about: HEARD_ABOUT.includes(heard) ? heard : '',
  };
  for (const k of ['gclid', 'gbraid', 'wbraid']) {
    const v = String(s[k] ?? '').trim();
    if (/^[\w-]{10,300}$/.test(v)) { out.src_click_id = v; out.src_click_type = k; break; }
  }
  const landing = text(s.landing, 300);
  if (landing.startsWith('/') && !landing.startsWith('//')) out.src_landing = landing.split(/[?#]/)[0];
  const ref = String(s.referrer ?? '').trim().toLowerCase();
  if (/^[a-z0-9.-]{1,253}$/.test(ref) && ref.includes('.')) out.src_referrer = ref;
  const at = Number(s.t);
  if (Number.isFinite(at) && at <= nowMs + 60_000 && at >= nowMs - MAX_AGE_DAYS * 864e5) out.src_at = new Date(at).toISOString();
  for (const k of Object.keys(out)) if (!out[k]) out[k] = null;
  return out;
}

const SEARCH = [[/(^|\.)google\.[a-z.]+$/, 'Google search'], [/(^|\.)bing\.com$/, 'Bing'], [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'], [/(^|\.)yahoo\.com$/, 'Yahoo'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'], [/(^|\.)instagram\.com$/, 'Instagram'], [/(^|\.)(chatgpt\.com|openai\.com)$/, 'ChatGPT'], [/(^|\.)(claude\.ai|perplexity\.ai)$/, 'An AI assistant']];

// A short, plain label for a request's source: "Google Ads", "Google Business Profile", "Google
// search", "Partner: Cherry Hill", "Facebook", "Direct or unknown". Call-ins the owner adds have none.
export function sourceLabel(r) {
  if (!r) return '';
  const src = String(r.src_source || '').toLowerCase(), med = String(r.src_medium || '').toLowerCase(), camp = String(r.src_campaign || '').toLowerCase();
  if (r.src_click_id || (src === 'google' && /^(cpc|ppc|paid)/.test(med))) return 'Google Ads';
  if (src === 'google' && (camp === 'gbp' || med === 'gbp' || camp.includes('business profile'))) return 'Google Business Profile';
  if (src || med) {
    if (med === 'referral' || med === 'partner' || med === 'qr' || med === 'flyer') return `Partner: ${r.src_source || 'unnamed'}`;
    if (/^(cpc|ppc|paid)/.test(med)) return `Paid ads: ${r.src_source || 'unnamed'}`;
    return r.src_source ? `${r.src_source}${r.src_medium ? ` (${r.src_medium})` : ''}` : r.src_medium;
  }
  if (r.src_referrer) {
    const hit = SEARCH.find(([re]) => re.test(r.src_referrer));
    return hit ? hit[1] : r.src_referrer;
  }
  if (r.src_landing || r.src_at) return 'Direct or unknown';
  return '';
}
