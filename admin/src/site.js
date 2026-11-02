// Server-rendered, white-label website for a business on the platform: the home page, one page per
// city it serves, and the files it shares with customers. Local-search markup (schema.org JSON-LD,
// canonical URLs, sitemaps) is generated from the business's own data.
import { DAYS, citySlug, cityIndexable, servicePhrase } from './site-profile.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (c, d) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : d);
const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 });
const telDigits = (p) => String(p || '').replace(/[^\d+]/g, '');
const para = (t) => esc(t).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
const ampm = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
const kb = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
const SCHEMA_DAYS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

// Where this business's site lives. Its own domain is canonical when it has one; links within a page
// follow the host the visitor actually used (its domain, or /s/<slug> on the platform).
export function siteUrls(t, platformBase, onDomain = false) {
  const origin = t.custom_domain && t.domain_live_at ? `https://${t.custom_domain}` : `${platformBase}/s/${t.slug}`;
  const prefix = onDomain ? '' : `/s/${t.slug}`;
  return {
    abs: (p = '/') => (p === '/' ? `${origin}/` : origin + p),
    rel: (p = '/') => (p === '/' ? `${prefix}/` : prefix + p),
  };
}

function businessSchema(t, profile, products, u, mediaAbs) {
  const phrase = servicePhrase(profile);
  const areas = profile.cities.map((c) => ({ '@type': 'City', name: `${c.name}, ${c.state}` }));
  if (profile.base_city && !profile.cities.some((c) => c.name === profile.base_city && c.state === profile.base_state)) areas.unshift({ '@type': 'City', name: `${profile.base_city}, ${profile.base_state}` });
  const days = Object.entries(profile.hours.days);
  const o = {
    '@context': 'https://schema.org',
    '@type': 'AutoRepair',
    '@id': u.abs('/') + '#business',
    name: t.name,
    url: u.abs('/'),
    description: clip(t.tagline || t.about || `${phrase} by ${t.name}`, 300),
    knowsAbout: phrase,
  };
  if (t.phone) o.telephone = t.phone;
  if (t.email) o.email = t.email;
  if (t.logo) o.logo = mediaAbs(t.logo);
  if (t.owner_photo || t.logo) o.image = mediaAbs(t.owner_photo || t.logo);
  if (profile.base_city) o.address = { '@type': 'PostalAddress', addressLocality: profile.base_city, addressRegion: profile.base_state, addressCountry: 'US' };
  if (areas.length) o.areaServed = areas;
  else if (t.service_area) o.areaServed = t.service_area;
  if (profile.hours.always_open) o.openingHoursSpecification = [{ '@type': 'OpeningHoursSpecification', dayOfWeek: Object.values(SCHEMA_DAYS), opens: '00:00', closes: '23:59' }];
  else if (days.length) o.openingHoursSpecification = days.map(([d, h]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: SCHEMA_DAYS[d], opens: h.open, closes: h.close }));
  const sameAs = ['google_profile', 'youtube', 'facebook', 'instagram'].map((k) => profile.links[k]).filter(Boolean);
  if (sameAs.length) o.sameAs = sameAs;
  if (profile.credentials.length) o.hasCredential = profile.credentials.map((c) => ({ '@type': 'EducationalOccupationalCredential', name: c.title, ...(c.detail ? { description: c.detail } : {}) }));
  const services = products.filter((p) => p.on_site);
  if (services.length) {
    o.hasOfferCatalog = {
      '@type': 'OfferCatalog', name: 'Services',
      itemListElement: services.map((p) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: p.name, ...(p.description ? { description: clip(p.description, 300) } : {}) }, ...(p.bookable ? { price: (p.price_cents / 100).toFixed(2), priceCurrency: 'USD' } : {}) })),
    };
  }
  return o;
}

function head(t, profile, { title, description, canonical, robots, image, schemas }) {
  const primary = hex(t.primary_color, '#B0141C');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="${robots}">
${profile.search_console ? `<meta name="google-site-verification" content="${esc(profile.search_console)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(t.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="rsqu-business" content="${esc(t.slug)}">
<meta name="theme-color" content="${primary}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700&amp;family=Barlow:wght@400;500;600&amp;display=swap" rel="stylesheet">
<style>${css(t)}</style>
${schemas.map(jsonLd).join('\n')}
</head>`;
}

function css(t) {
  const primary = hex(t.primary_color, '#B0141C');
  const accent = hex(t.accent_color, '#F2CE6E');
  return `
:root{--p:${primary};--a:${accent};--ink:#1F1C17;--text:#2E2924;--muted:#5C544C;--line:#DDD5C8;--soft:#F6F2EC;--cond:'Barlow Semi Condensed','Arial Narrow',Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;font-family:'Barlow','Helvetica Neue',Arial,sans-serif;color:var(--text);background:#fff;font-size:18px;line-height:1.55}
a{color:var(--p)}:focus-visible{outline:3px solid var(--ink);outline-offset:3px}[hidden]{display:none!important}
.wrap{max-width:1180px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
h1,h2,h3{font-family:var(--cond);color:var(--ink);line-height:1.12;margin:0;text-wrap:balance}
.top{background:var(--p);color:#fff}.top .wrap{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding-top:14px;padding-bottom:14px}
.brand{display:flex;align-items:center;gap:12px;color:#fff;text-decoration:none;font-family:var(--cond);font-weight:700;font-size:22px}
.brand img{height:44px;width:auto;border-radius:6px;background:#fff}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:0 22px;border-radius:6px;font-family:var(--cond);font-weight:700;font-size:20px;text-decoration:none;border:2px solid transparent;cursor:pointer}
.btn-a{background:var(--a);color:#1A1208}.btn-o{border-color:#fff;color:#fff;background:transparent}.btn-p{background:var(--p);color:#fff;width:100%}.btn-l{border-color:var(--p);color:var(--p);background:#fff}
.hero{background:var(--p);color:#fff;padding:24px 0 64px}.hero .wrap{display:flex;flex-wrap:wrap;gap:40px;align-items:flex-start}
.hero h1{color:#fff;font-size:clamp(34px,5vw,56px);margin-bottom:16px}.hero p.lead{font-size:20px;max-width:32em;margin:0 0 22px}
.hero-l{flex:1 1 420px;min-width:0}.row{display:flex;flex-wrap:wrap;gap:12px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 22px;padding:0;list-style:none}.chips li{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:4px 12px;font-size:15px;font-weight:600}
.card{flex:1 1 360px;max-width:520px;min-width:0;background:#fff;color:var(--text);border-radius:10px;padding:clamp(18px,3vw,30px);box-shadow:0 18px 40px rgba(0,0,0,.25)}
.card h2{font-size:28px;margin-bottom:4px}label{display:block;font-family:var(--cond);font-weight:600;font-size:17px;color:var(--ink);margin:14px 0 4px}
input,textarea,select{display:block;width:100%;min-height:48px;padding:10px 12px;font:inherit;font-size:17px;border:2px solid #8A8075;border-radius:6px;color:var(--ink);background:#fff}
textarea{min-height:80px;resize:vertical}.hint{font-size:15px;color:var(--muted);margin:2px 0 6px}
.err{background:#FCE8E6;color:#7A0C11;font-weight:600;padding:10px 12px;border-radius:6px;margin-top:12px}
.linkbtn{background:none;border:0;padding:8px 0;color:var(--p);font:inherit;font-size:16px;font-weight:600;text-decoration:underline;cursor:pointer;min-height:44px}
section.s{padding:clamp(48px,7vw,88px) 0;border-bottom:1px solid var(--line)}section.s h2{font-size:clamp(30px,3.4vw,42px);margin-bottom:28px}
section.alt{background:var(--soft)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:28px 40px}
.svc h3{font-size:23px;margin-bottom:6px}.svc p{margin:0;color:#4A433C;font-size:17px}.price{font-family:var(--cond);font-weight:700;color:var(--p);font-size:20px}
.cred{border-left:4px solid var(--p);padding:4px 0 4px 16px}.cred h3{font-size:22px}.cred p{margin:4px 0 0;color:#4A433C;font-size:17px}
.vid{margin:0}.yt{position:relative;display:block;aspect-ratio:16/9;max-width:100%;border-radius:8px;overflow:hidden;background:#000}
.yt img{width:100%;height:100%;object-fit:cover;display:block;opacity:.88}.yt .play{position:absolute;inset:0;margin:auto;width:72px;height:50px;border-radius:12px;background:var(--p)}
.yt .play::after{content:"";position:absolute;left:29px;top:15px;border-left:18px solid #fff;border-top:10px solid transparent;border-bottom:10px solid transparent}
.yt iframe{position:absolute;inset:0;width:100%;height:100%;border:0}.vid figcaption{margin-top:8px;font-weight:600}
.about{display:flex;flex-wrap:wrap;gap:40px;align-items:flex-start}.about img{flex:0 1 340px;width:100%;max-width:340px;aspect-ratio:4/5;object-fit:cover;border-radius:8px}
.about div{flex:1 1 420px;min-width:0}
.areas{display:flex;flex-wrap:wrap;gap:10px;padding:0;margin:0;list-style:none}.areas a,.areas span{display:inline-flex;align-items:center;min-height:44px;padding:6px 14px;border:2px solid var(--line);border-radius:999px;text-decoration:none;color:var(--ink);font-weight:600;background:#fff}
.areas a:hover{border-color:var(--p)}
.faq{max-width:52em}.faq details{border-bottom:1px solid var(--line);padding:6px 0}.faq summary{cursor:pointer;font-weight:600;font-size:19px;min-height:44px;display:flex;align-items:center;color:var(--ink)}
.faq details p{margin:6px 0 12px;color:#4A433C}
.docs{display:grid;gap:12px;max-width:52em;padding:0;margin:0;list-style:none}.docs a{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;border:2px solid var(--line);border-radius:8px;text-decoration:none;color:var(--text);background:#fff}
.docs a:hover{border-color:var(--p)}.docs .ext{flex:none;font-family:var(--cond);font-weight:700;color:#fff;background:var(--p);border-radius:4px;padding:2px 6px;font-size:14px;margin-top:3px}
.docs strong{display:block;color:var(--ink)}.docs small{color:var(--muted);font-size:15px}
.intro{max-width:46em}.crumbs{font-size:15px;margin:0 0 10px}.crumbs a{color:#fff}
footer{background:var(--ink);color:#D9D3CA;padding:40px 0;font-size:16px}footer a{color:#fff}footer .wrap{display:flex;flex-wrap:wrap;gap:24px 48px;justify-content:space-between}
footer h2{color:#fff;font-size:20px;margin-bottom:6px}footer dl{display:grid;grid-template-columns:auto auto;gap:2px 16px;margin:0}footer dd{margin:0}
.big{font-family:var(--cond);font-weight:700;font-size:34px;color:var(--a);text-decoration:none}
.links{display:flex;flex-wrap:wrap;gap:8px 16px;padding:0;margin:8px 0 0;list-style:none}
`;
}

function requestCard(t, bookable) {
  const tel = telDigits(t.phone);
  return `<div class="card" id="request">
    <form id="req-form" novalidate data-slug="${esc(t.slug)}">
      <div style="position:absolute;left:-9999px" aria-hidden="true"><label for="website">Leave empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
      <h2>Request service</h2>
      <p class="hint">We’ll call or text you back.${t.deposit_cents ? ` ${esc(t.deposit_label)} is ${money(t.deposit_cents)}, credited toward the job.` : ''}</p>
      ${bookable.length ? `<label for="kind">What do you need?</label><select id="kind" name="kind"><option value="repair">Repair or help</option>${bookable.map((p) => `<option value="${p.id}">Book: ${esc(p.name)} (${money(p.price_cents)})</option>`).join('')}</select>` : ''}
      <label for="loc">Where are you? <span style="color:var(--p)">(required)</span></label>
      <textarea id="loc" name="location" rows="2" aria-describedby="loc-status"></textarea>
      <button type="button" class="linkbtn" id="gps">Use my current location</button> <span id="loc-status" class="hint" aria-live="polite"></span>
      <label for="rig">Year, make and model</label><input id="rig" name="rig">
      <div id="date-wrap" hidden><label for="date">Preferred date</label><input id="date" name="preferred_date" type="date"></div>
      <label for="issue">What’s going on?</label><textarea id="issue" name="issue" rows="3"></textarea>
      <label for="photo">Photo (optional)</label><input id="photo" name="photo" type="file" accept="image/*">
      <label for="name">Your name</label><input id="name" name="name" autocomplete="name">
      <label for="phone">Phone <span style="color:var(--p)">(required)</span></label><input id="phone" name="phone" type="tel" autocomplete="tel">
      <p class="err" id="err" role="alert" hidden></p>
      <p class="hint" style="margin-top:14px">By sending, you agree we may call or text you about this request. <a href="/legal/privacy">Privacy</a></p>
      <button class="btn btn-p" type="submit" style="margin-top:8px">Send request</button>
    </form>
    <div id="sent" role="status" hidden><h2>Request sent</h2><p>We’ll call or text you at <strong id="sent-phone"></strong> shortly.${tel ? ` Need us now? Call <a href="tel:${tel}">${esc(t.phone)}</a>.` : ''}</p></div>
  </div>`;
}

function hoursList(profile) {
  if (profile.hours.always_open) return '<p style="margin:0">Open 24 hours, 7 days a week</p>';
  const days = DAYS.map(([k, label]) => {
    const h = profile.hours.days[k];
    return `<dt>${label.slice(0, 3)}</dt><dd>${h ? `${ampm(h.open)}–${ampm(h.close)}` : 'Closed'}</dd>`;
  });
  return Object.keys(profile.hours.days).length ? `<dl>${days.join('')}</dl>` : '';
}

function footer(t, profile, u) {
  const tel = telDigits(t.phone);
  const year = new Date().getFullYear();
  const hours = hoursList(profile);
  const L = profile.links;
  const links = [
    L.google_review && `<li><a href="${esc(L.google_review)}" rel="noopener" target="_blank">Review us on Google</a></li>`,
    L.google_profile && `<li><a href="${esc(L.google_profile)}" rel="noopener" target="_blank">Find us on Google</a></li>`,
    L.youtube && `<li><a href="${esc(L.youtube)}" rel="noopener" target="_blank">YouTube</a></li>`,
    L.facebook && `<li><a href="${esc(L.facebook)}" rel="noopener" target="_blank">Facebook</a></li>`,
    L.instagram && `<li><a href="${esc(L.instagram)}" rel="noopener" target="_blank">Instagram</a></li>`,
  ].filter(Boolean);
  const where = profile.base_city ? `Based in ${esc(profile.base_city)}, ${esc(profile.base_state)}${profile.radius_miles ? ` · serving about ${profile.radius_miles} miles around` : ''}` : (t.service_area ? `Serving ${esc(t.service_area)}` : '');
  return `<footer><div class="wrap">
  <div><h2><a href="${u.rel('/')}" style="text-decoration:none">${esc(t.name)}</a></h2>${where ? `<div>${where}</div>` : ''}
    ${links.length ? `<ul class="links">${links.join('')}</ul>` : ''}
    <p style="font-size:14px;margin:14px 0 0">© ${year} ${esc(t.name)} · <a href="/legal/privacy">Privacy</a> · <a href="/legal/customer-terms">Customer terms</a></p></div>
  ${hours || profile.hours.note ? `<div><h2>Hours</h2>${hours}${profile.hours.note ? `<p style="margin:6px 0 0">${esc(profile.hours.note)}</p>` : ''}</div>` : ''}
  ${tel ? `<div><a class="big" href="tel:${tel}">${esc(t.phone)}</a></div>` : ''}
</div></footer>
<script src="/static/site.js"></script>
</body>
</html>`;
}

function topBar(t, u, img) {
  const tel = telDigits(t.phone);
  return `<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${u.rel('/')}">${t.logo ? `<img src="${img(t.logo)}" alt="">` : ''}<span>${esc(t.name)}</span></a>
  ${tel ? `<a class="btn btn-a" href="tel:${tel}">Call ${esc(t.phone)}</a>` : ''}
</div></header>`;
}

const servicesSection = (services) => (services.length ? `<section class="s"><div class="wrap"><h2>Services</h2><div class="grid">${services.map((p) => `<div class="svc"><h3>${esc(p.name)}</h3>${p.bookable ? `<p class="price">${money(p.price_cents)}</p>` : ''}${p.description ? `<p>${esc(p.description)}</p>` : ''}</div>`).join('')}</div></div></section>` : '');

const credentialsSection = (profile) => (profile.credentials.length ? `<section class="s alt" id="credentials"><div class="wrap"><h2>Certifications and experience</h2><div class="grid">${profile.credentials.map((c) => `<div class="cred"><h3>${esc(c.title)}</h3>${c.detail ? `<p>${esc(c.detail)}</p>` : ''}</div>`).join('')}</div></div></section>` : '');

const videosSection = (profile) => (profile.videos.length ? `<section class="s" id="videos"><div class="wrap"><h2>See our work</h2><div class="grid">${profile.videos.map((v) => `<figure class="vid"><a class="yt" href="https://www.youtube.com/watch?v=${esc(v.id)}" data-yt="${esc(v.id)}" data-title="${esc(v.title)}" aria-label="Play video: ${esc(v.title)}"><img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy" width="480" height="360"><span class="play" aria-hidden="true"></span></a><figcaption>${esc(v.title)}</figcaption></figure>`).join('')}</div></div></section>` : '');

function areasSection(t, profile, u, currentSlug) {
  const others = profile.cities.filter((c) => citySlug(c) !== currentSlug);
  if (!others.length && !profile.base_city) return '';
  const heading = currentSlug ? 'Other areas we serve' : 'Areas we serve';
  const lead = !currentSlug && profile.base_city ? `<p style="margin:0 0 18px">Based in ${esc(profile.base_city)}, ${esc(profile.base_state)}${profile.radius_miles ? `, we come to you within about ${profile.radius_miles} miles` : ''}.</p>` : '';
  return `<section class="s alt" id="areas"><div class="wrap"><h2>${heading}</h2>${lead}${others.length ? `<ul class="areas">${others.map((c) => `<li><a href="${u.rel('/areas/' + citySlug(c))}">${esc(c.name)}, ${esc(c.state)}</a></li>`).join('')}</ul>` : ''}</div></section>`;
}

const faqSection = (profile) => (profile.faqs.length ? `<section class="s" id="faq"><div class="wrap faq"><h2>Questions customers ask</h2>${profile.faqs.map((f) => `<details><summary>${esc(f.q)}</summary>${para(f.a)}</details>`).join('')}</div></section>` : '');

const resourcesSection = (profile, u) => (profile.resources.length ? `<section class="s alt" id="resources"><div class="wrap"><h2>Checklists and guides</h2><p style="margin:-12px 0 22px;max-width:46em">Free to download and print.</p><ul class="docs">${profile.resources.map((r) => `<li><a href="${u.rel('/files/' + r.file)}" target="_blank" rel="noopener"><span class="ext">PDF</span><span><strong>${esc(r.title)}</strong>${r.description ? `${esc(r.description)}<br>` : ''}<small>${kb(r.size || 0)}</small></span></a></li>`).join('')}</ul></div></section>` : '');

const faqSchema = (profile) => (profile.faqs.length ? [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: profile.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []);

export function renderSite(t, products, profile, { platformBase, onDomain = false }) {
  const u = siteUrls(t, platformBase, onDomain);
  const img = (f) => `/media/${encodeURIComponent(t.slug)}/${encodeURIComponent(f)}`;
  const mediaAbs = (f) => `${platformBase}${img(f)}`;
  const tel = telDigits(t.phone);
  const services = products.filter((p) => p.on_site);
  const bookable = products.filter((p) => p.bookable);
  const phrase = servicePhrase(profile);
  const place = profile.base_city ? `${profile.base_city}, ${profile.base_state}` : '';
  const title = `${t.name} | ${t.tagline || `${phrase}${place ? ' in ' + place : ''}`}`;
  const description = clip(`${t.tagline || phrase}${place ? ` based in ${place}` : ''}${t.service_area ? `. Serving ${t.service_area}` : ''}.`, 160);
  const L = profile.links;

  return `${head(t, profile, { title, description, canonical: u.abs('/'), robots: 'index,follow', image: t.owner_photo || t.logo ? mediaAbs(t.owner_photo || t.logo) : '', schemas: [businessSchema(t, profile, products, u, mediaAbs), ...faqSchema(profile)] })}
${topBar(t, u, img)}

<section class="hero"><div class="wrap">
  <div class="hero-l">
    <h1>${esc(t.hero_headline || t.name)}</h1>
    ${t.tagline ? `<p class="lead">${esc(t.tagline)}</p>` : ''}
    ${profile.credentials.length ? `<ul class="chips">${profile.credentials.slice(0, 3).map((c) => `<li>${esc(c.title)}</li>`).join('')}</ul>` : ''}
    ${tel ? `<div class="row"><a class="btn btn-a" href="tel:${tel}">Call ${esc(t.phone)}</a><a class="btn btn-o" href="sms:${tel}">Text us</a></div>` : ''}
    ${t.service_area ? `<p style="margin-top:22px">Serving ${esc(t.service_area)}</p>` : ''}
    ${L.google_review ? `<p style="margin-top:12px"><a href="${esc(L.google_review)}" target="_blank" rel="noopener" style="color:#fff;font-weight:600">Review us on Google</a></p>` : ''}
  </div>
  ${requestCard(t, bookable)}
</div></section>

${servicesSection(services)}
${credentialsSection(profile)}
${videosSection(profile)}
${t.about || t.owner_photo ? `<section class="s"><div class="wrap about">${t.owner_photo ? `<img src="${img(t.owner_photo)}" alt="${esc(t.name)}">` : ''}<div><h2>About us</h2>${para(t.about)}</div></div></section>` : ''}
${areasSection(t, profile, u, null)}
${faqSection(profile)}
${resourcesSection(profile, u)}
${footer(t, profile, u)}`;
}

export function renderCityPage(t, products, profile, city, { platformBase, onDomain = false }) {
  const u = siteUrls(t, platformBase, onDomain);
  const img = (f) => `/media/${encodeURIComponent(t.slug)}/${encodeURIComponent(f)}`;
  const mediaAbs = (f) => `${platformBase}${img(f)}`;
  const tel = telDigits(t.phone);
  const services = products.filter((p) => p.on_site);
  const bookable = products.filter((p) => p.bookable);
  const phrase = servicePhrase(profile);
  const place = `${city.name}, ${city.state}`;
  const slug = citySlug(city);
  const canonical = u.abs('/areas/' + slug);
  const title = `${phrase} in ${place} | ${t.name}`;
  const description = clip(city.intro || `${t.name} comes to you in ${place}. ${t.tagline || ''}`, 160);
  const business = businessSchema(t, profile, products, u, mediaAbs);
  const service = { '@context': 'https://schema.org', '@type': 'Service', serviceType: phrase, name: `${phrase} in ${place}`, url: canonical, provider: { '@id': business['@id'] }, areaServed: { '@type': 'City', name: place } };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: t.name, item: u.abs('/') }, { '@type': 'ListItem', position: 2, name: place, item: canonical }] };

  return `${head(t, profile, { title, description, canonical, robots: cityIndexable(city) ? 'index,follow' : 'noindex,follow', image: t.owner_photo || t.logo ? mediaAbs(t.owner_photo || t.logo) : '', schemas: [business, service, crumbs] })}
${topBar(t, u, img)}

<section class="hero"><div class="wrap">
  <div class="hero-l">
    <p class="crumbs"><a href="${u.rel('/')}">${esc(t.name)}</a> › ${esc(place)}</p>
    <h1>${esc(phrase)} in ${esc(place)}</h1>
    <p class="lead">${esc(t.name)} comes to you in ${esc(city.name)} and nearby.${t.tagline ? ' ' + esc(t.tagline) : ''}</p>
    ${profile.credentials.length ? `<ul class="chips">${profile.credentials.slice(0, 3).map((c) => `<li>${esc(c.title)}</li>`).join('')}</ul>` : ''}
    ${tel ? `<div class="row"><a class="btn btn-a" href="tel:${tel}">Call ${esc(t.phone)}</a><a class="btn btn-o" href="sms:${tel}">Text us</a></div>` : ''}
  </div>
  ${requestCard(t, bookable)}
</div></section>

${city.intro ? `<section class="s"><div class="wrap intro"><h2>Serving ${esc(city.name)}</h2>${para(city.intro)}</div></section>` : ''}
${servicesSection(services)}
${credentialsSection(profile)}
${areasSection(t, profile, u, slug)}
${footer(t, profile, u)}`;
}

// Pages search engines should index for one business, as absolute URLs.
export function sitePages(t, profile, platformBase) {
  const u = siteUrls(t, platformBase);
  return [u.abs('/'), ...profile.cities.filter(cityIndexable).map((c) => u.abs('/areas/' + citySlug(c))), ...profile.resources.map((r) => u.abs('/files/' + r.file))];
}

export function tenantSitemap(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((x) => `  <url><loc>${esc(x)}</loc></url>`).join('\n')}
</urlset>
`;
}

export function tenantRobots(origin) {
  return `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Disallow: /p/
Disallow: /pay/

Sitemap: ${origin}/sitemap.xml
`;
}
