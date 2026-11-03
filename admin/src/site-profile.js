// Website content each business manages itself, plus what local search needs: where it's based,
// the cities it serves, hours, credentials, FAQs, videos, links to its Google and social profiles,
// and downloadable customer resources (PDFs). Stored as JSON in tenants.site_profile.

export const LIMITS = { cities: 20, credentials: 20, faqs: 20, videos: 12, resources: 20, resourceBytes: 10_000_000, highlights: 4 };
// Site looks. 'classic': light, the request form beside the headline. 'bold': dark header with a
// menu, a full-width banner image, service tiles with pictures and a highlights bar.
export const THEMES = ['classic', 'bold'];
export const HIGHLIGHT_ICONS = ['tools', 'shield', 'gear', 'pin', 'clock', 'star', 'phone', 'truck'];
export const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
export const STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
const LINK_KEYS = ['google_profile', 'google_review', 'youtube', 'facebook', 'instagram'];
// A city page needs this much of the owner's own words before search engines are asked to index it,
// so the pages are useful to people in that city rather than near-copies of each other.
export const CITY_INTRO_MIN = 120;

export class ProfileError extends Error {
  constructor(errors) { super('Check the highlighted fields.'); this.errors = errors; }
}

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
export const citySlug = (c) => slugify(`${c.name} ${c.state}`);

// Accepts the usual YouTube link shapes; returns the 11-character video id or ''.
export function youtubeId(url) {
  const s = String(url || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u; try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return ''; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else { const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname); id = m ? m[1] : ''; }
  }
  return /^[\w-]{11}$/.test(id) ? id : '';
}

function httpsUrl(v) {
  const s = str(v, 400);
  if (!s) return '';
  let u; try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname.includes('.')) return null;
  u.protocol = 'https:';
  return u.toString();
}
const time = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');

export function defaultProfile() {
  return {
    service_phrase: '', base_city: '', base_state: '', radius_miles: null,
    cities: [], hours: { always_open: false, note: '', days: {} },
    credentials: [], faqs: [], videos: [], links: {}, search_console: '', resources: [],
    theme: 'classic', banner: { desktop: '', mobile: '', alt: '' }, highlights: [],
  };
}

export function parseProfile(raw) {
  let p = {};
  try { p = raw ? JSON.parse(raw) : {}; } catch { p = {}; }
  const d = defaultProfile();
  const out = { ...d, ...(p && typeof p === 'object' ? p : {}) };
  out.hours = { ...d.hours, ...(out.hours || {}) };
  out.hours.days = out.hours.days && typeof out.hours.days === 'object' ? out.hours.days : {};
  out.links = out.links && typeof out.links === 'object' ? out.links : {};
  for (const k of ['cities', 'credentials', 'faqs', 'videos', 'resources', 'highlights']) if (!Array.isArray(out[k])) out[k] = [];
  if (!THEMES.includes(out.theme)) out.theme = 'classic';
  out.banner = { ...d.banner, ...(out.banner && typeof out.banner === 'object' ? out.banner : {}) };
  return out;
}

// Validates what the owner submitted. Resources (uploaded files) are managed separately; only their
// titles, descriptions and order can change here, and only for files that already exist.
export function cleanProfile(input, current) {
  const b = input && typeof input === 'object' ? input : {};
  const errors = {};
  const out = defaultProfile();

  out.service_phrase = str(b.service_phrase, 60);
  out.base_city = str(b.base_city, 80);
  out.base_state = str(b.base_state, 2).toUpperCase();
  if (out.base_state && !STATES.includes(out.base_state)) errors.base_state = 'Pick a state.';
  if (out.base_city && !out.base_state) errors.base_state = 'Pick the state your base city is in.';
  if (b.radius_miles !== '' && b.radius_miles != null) {
    const r = Number(b.radius_miles);
    if (!Number.isInteger(r) || r < 1 || r > 300) errors.radius_miles = 'Enter whole miles from 1 to 300.';
    else out.radius_miles = r;
  }

  const seen = new Set();
  list(b.cities, LIMITS.cities + 1).forEach((c, i) => {
    const name = str(c && c.name, 80), state = str(c && c.state, 2).toUpperCase(), intro = str(c && c.intro, 2000);
    if (!name && !intro) return;
    if (!name) { errors[`cities.${i}.name`] = 'Add the city name.'; return; }
    if (!STATES.includes(state)) { errors[`cities.${i}.state`] = 'Pick a state.'; return; }
    const slug = citySlug({ name, state });
    if (seen.has(slug)) { errors[`cities.${i}.name`] = 'This city is already listed.'; return; }
    seen.add(slug);
    out.cities.push({ name, state, intro });
  });
  if (out.cities.length > LIMITS.cities) errors.cities = `List up to ${LIMITS.cities} cities. Google allows 20 service areas, so pick the ones you serve most.`;

  out.hours.always_open = Boolean(b.hours && b.hours.always_open);
  out.hours.note = str(b.hours && b.hours.note, 200);
  for (const [k, label] of DAYS) {
    const day = b.hours && b.hours.days && b.hours.days[k];
    if (!day || day.closed) continue;
    // Closing at midnight is entered as 00:00; schema.org writes it as 23:59.
    const open = time(day.open), close = day.close === '00:00' || day.close === '24:00' ? '23:59' : time(day.close);
    if (!day.open && !day.close) continue;
    if (!open || !close) { errors[`hours.${k}`] = `Enter ${label} hours like 08:00 and 17:00, or mark it closed.`; continue; }
    if (close <= open) { errors[`hours.${k}`] = `${label} closing time must be after opening time.`; continue; }
    out.hours.days[k] = { open, close };
  }

  list(b.credentials, LIMITS.credentials + 1).forEach((c, i) => {
    const title = str(c && c.title, 120), detail = str(c && c.detail, 300);
    if (!title && !detail) return;
    if (!title) { errors[`credentials.${i}.title`] = 'Add the certification or credential name.'; return; }
    out.credentials.push({ title, detail });
  });
  if (out.credentials.length > LIMITS.credentials) errors.credentials = `List up to ${LIMITS.credentials} credentials.`;

  list(b.faqs, LIMITS.faqs + 1).forEach((f, i) => {
    const q = str(f && f.q, 200), a = str(f && f.a, 1500);
    if (!q && !a) return;
    if (!q || !a) { errors[`faqs.${i}`] = 'Each FAQ needs a question and an answer.'; return; }
    out.faqs.push({ q, a });
  });
  if (out.faqs.length > LIMITS.faqs) errors.faqs = `List up to ${LIMITS.faqs} questions.`;

  list(b.videos, LIMITS.videos + 1).forEach((v, i) => {
    const url = str(v && (v.url || v.id), 300), title = str(v && v.title, 120);
    if (!url && !title) return;
    const id = youtubeId(url);
    if (!id) { errors[`videos.${i}.url`] = 'Paste a YouTube video link, like https://youtu.be/abc123XYZ00.'; return; }
    out.videos.push({ id, title: title || 'Video' });
  });
  if (out.videos.length > LIMITS.videos) errors.videos = `Show up to ${LIMITS.videos} videos.`;

  for (const k of LINK_KEYS) {
    const u = httpsUrl(b.links && b.links[k]);
    if (u === null) errors[`links.${k}`] = 'Enter a full web address, starting with https://';
    else if (u) out.links[k] = u;
  }

  // Search Console's HTML-tag method: accept the whole <meta> tag or just its content value.
  let sc = str(b.search_console, 300);
  const m = /content=["']([^"']+)["']/i.exec(sc);
  if (m) sc = m[1];
  if (sc && !/^[\w-]{20,100}$/.test(sc)) errors.search_console = 'Paste the code from Google Search Console’s “HTML tag” option.';
  else out.search_console = sc;

  const existing = new Map((current.resources || []).map((r) => [r.file, r]));
  const kept = new Set();
  list(b.resources, LIMITS.resources).forEach((r) => {
    const cur = r && existing.get(r.file);
    if (!cur || kept.has(cur.file)) return;
    kept.add(cur.file);
    out.resources.push({ ...cur, title: str(r.title, 120) || cur.title, description: str(r.description, 300) });
  });
  for (const r of current.resources || []) if (!kept.has(r.file)) out.resources.push(r); // never drop files here

  out.theme = THEMES.includes(b.theme) ? b.theme : 'classic';
  // Banner image files are managed by their own upload route; only the description changes here.
  out.banner = { desktop: current.banner?.desktop || '', mobile: current.banner?.mobile || '', alt: str(b.banner && b.banner.alt, 200) };
  list(b.highlights, LIMITS.highlights + 1).forEach((h, i) => {
    const title = str(h && h.title, 40), text = str(h && h.text, 80);
    if (!title && !text) return;
    if (!title) { errors[`highlights.${i}.title`] = 'Add a short title.'; return; }
    out.highlights.push({ icon: HIGHLIGHT_ICONS.includes(h.icon) ? h.icon : 'star', title, text });
  });
  if (out.highlights.length > LIMITS.highlights) errors.highlights = `Show up to ${LIMITS.highlights} highlights.`;

  if (Object.keys(errors).length) throw new ProfileError(errors);
  return out;
}

export function cityBySlug(profile, slug) {
  return profile.cities.find((c) => citySlug(c) === slug) || null;
}
export const servicePhrase = (p) => p.service_phrase || 'Mobile RV repair';
export const cityIndexable = (c) => (c.intro || '').length >= CITY_INTRO_MIN;

// What a business still needs for local search, most important first. `done` items show as ticked.
export function checklist(t, profile, productsCount) {
  const has = (v) => Boolean(v && String(v).trim());
  const openDays = Object.keys(profile.hours.days).length;
  return [
    { key: 'base', label: 'Your base city and state', done: has(profile.base_city) && has(profile.base_state), why: 'Search engines use it to show you to people nearby.' },
    { key: 'phone', label: 'A public phone number', done: has(t.phone), why: 'It should match your Google Business Profile exactly.' },
    { key: 'cities', label: 'At least 3 cities you serve', done: profile.cities.length >= 3, why: 'Each one gets its own page on your site.' },
    { key: 'city_intros', label: 'A short note for each city page', done: profile.cities.length > 0 && profile.cities.every(cityIndexable), why: `City pages are only offered to search engines once they have ${CITY_INTRO_MIN}+ characters of your own words. Mention campgrounds, RV parks or roads you know there.` },
    { key: 'services', label: 'At least 3 services listed', done: productsCount >= 3, why: 'People search for the specific repair they need.' },
    { key: 'hours', label: 'Your hours', done: profile.hours.always_open || openDays > 0, why: 'Shown on your site and in search results.' },
    { key: 'about', label: 'An “About” paragraph', done: has(t.about) && t.about.length >= 200, why: 'Tell customers who you are and how long you’ve done this.' },
    { key: 'credentials', label: 'Certifications or credentials', done: profile.credentials.length > 0, why: 'Builds trust, and search engines read them.' },
    { key: 'faqs', label: 'At least 3 FAQs', done: profile.faqs.length >= 3, why: 'Answers the questions people type into Google and AI assistants.' },
    { key: 'google_profile', label: 'Link to your Google Business Profile', done: has(profile.links.google_profile), why: 'Connects your site and your Google listing.' },
    { key: 'google_review', label: 'Your Google review link', done: has(profile.links.google_review), why: 'Adds a “Review us on Google” button. Reviews are a top local ranking factor.' },
    { key: 'videos', label: 'At least one YouTube video', done: profile.videos.length > 0, why: 'Shows your work and keeps visitors on your page.' },
    { key: 'search_console', label: 'Google Search Console connected', done: has(profile.search_console), why: 'Lets you see which searches show your site.' },
  ];
}
