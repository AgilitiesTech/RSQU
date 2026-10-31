// Server-rendered, white-label website for a business on the platform.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (c, d) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : d);
const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 });
const telDigits = (p) => String(p || '').replace(/[^\d+]/g, '');
const para = (t) => esc(t).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

export function renderSite(t, products) {
  const primary = hex(t.primary_color, '#B0141C');
  const accent = hex(t.accent_color, '#F2CE6E');
  const tel = telDigits(t.phone);
  const services = products.filter((p) => p.on_site);
  const bookable = products.filter((p) => p.bookable);
  const img = (f) => `/media/${encodeURIComponent(t.slug)}/${encodeURIComponent(f)}`;
  const headline = t.hero_headline || `${t.name}`;
  const year = new Date().getFullYear();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.name)}${t.tagline ? ' | ' + esc(t.tagline) : ''}</title>
<meta name="description" content="${esc(t.tagline || t.name)}${t.service_area ? '. Serving ' + esc(t.service_area) : ''}.">
<meta name="rsqu-business" content="${esc(t.slug)}">
<meta name="theme-color" content="${primary}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700&amp;family=Barlow:wght@400;500;600&amp;display=swap" rel="stylesheet">
<style>
:root{--p:${primary};--a:${accent};--ink:#1F1C17;--text:#2E2924;--muted:#5C544C;--line:#DDD5C8;--cond:'Barlow Semi Condensed','Arial Narrow',Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;font-family:'Barlow','Helvetica Neue',Arial,sans-serif;color:var(--text);background:#fff;font-size:18px;line-height:1.55}
a{color:var(--p)}:focus-visible{outline:3px solid var(--ink);outline-offset:3px}[hidden]{display:none!important}
.wrap{max-width:1180px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
h1,h2,h3{font-family:var(--cond);color:var(--ink);line-height:1.12;margin:0}
.top{background:var(--p);color:#fff}.top .wrap{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding-top:14px;padding-bottom:14px}
.brand{display:flex;align-items:center;gap:12px;color:#fff;text-decoration:none;font-family:var(--cond);font-weight:700;font-size:22px}
.brand img{height:44px;width:auto;border-radius:6px;background:#fff}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:0 22px;border-radius:6px;font-family:var(--cond);font-weight:700;font-size:20px;text-decoration:none;border:2px solid transparent;cursor:pointer}
.btn-a{background:var(--a);color:#1A1208}.btn-o{border-color:#fff;color:#fff;background:transparent}.btn-p{background:var(--p);color:#fff;width:100%}
.hero{background:var(--p);color:#fff;padding:24px 0 64px}.hero .wrap{display:flex;flex-wrap:wrap;gap:40px;align-items:flex-start}
.hero h1{color:#fff;font-size:clamp(34px,5vw,56px);margin-bottom:16px}.hero p.lead{font-size:20px;max-width:32em;margin:0 0 22px}
.hero-l{flex:1 1 420px;min-width:0}.row{display:flex;flex-wrap:wrap;gap:12px}
.card{flex:1 1 360px;max-width:520px;min-width:0;background:#fff;color:var(--text);border-radius:10px;padding:clamp(18px,3vw,30px);box-shadow:0 18px 40px rgba(0,0,0,.25)}
.card h2{font-size:28px;margin-bottom:4px}label{display:block;font-family:var(--cond);font-weight:600;font-size:17px;color:var(--ink);margin:14px 0 4px}
input,textarea,select{display:block;width:100%;min-height:48px;padding:10px 12px;font:inherit;font-size:17px;border:2px solid #8A8075;border-radius:6px;color:var(--ink);background:#fff}
textarea{min-height:80px;resize:vertical}.hint{font-size:15px;color:var(--muted);margin:2px 0 6px}
.err{background:#FCE8E6;color:#7A0C11;font-weight:600;padding:10px 12px;border-radius:6px;margin-top:12px}
.linkbtn{background:none;border:0;padding:8px 0;color:var(--p);font:inherit;font-size:16px;font-weight:600;text-decoration:underline;cursor:pointer;min-height:44px}
section.s{padding:clamp(48px,7vw,88px) 0;border-bottom:1px solid var(--line)}section.s h2{font-size:clamp(30px,3.4vw,42px);margin-bottom:28px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:28px 40px}
.svc h3{font-size:23px;margin-bottom:6px}.svc p{margin:0;color:#4A433C;font-size:17px}.price{font-family:var(--cond);font-weight:700;color:var(--p);font-size:20px}
.about{display:flex;flex-wrap:wrap;gap:40px;align-items:flex-start}.about img{flex:0 1 340px;width:100%;max-width:340px;aspect-ratio:4/5;object-fit:cover;border-radius:8px}
.about div{flex:1 1 420px;min-width:0}
footer{background:var(--ink);color:#D9D3CA;padding:40px 0;font-size:16px}footer a{color:#fff}footer .wrap{display:flex;flex-wrap:wrap;gap:24px;justify-content:space-between}
.big{font-family:var(--cond);font-weight:700;font-size:34px;color:var(--a);text-decoration:none}
</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/">${t.logo ? `<img src="${img(t.logo)}" alt="">` : ''}<span>${esc(t.name)}</span></a>
  ${tel ? `<a class="btn btn-a" href="tel:${tel}">Call ${esc(t.phone)}</a>` : ''}
</div></header>

<section class="hero"><div class="wrap">
  <div class="hero-l">
    <h1>${esc(headline)}</h1>
    ${t.tagline ? `<p class="lead">${esc(t.tagline)}</p>` : ''}
    ${tel ? `<div class="row"><a class="btn btn-a" href="tel:${tel}">Call ${esc(t.phone)}</a><a class="btn btn-o" href="sms:${tel}">Text us</a></div>` : ''}
    ${t.service_area ? `<p style="margin-top:22px">Serving ${esc(t.service_area)}</p>` : ''}
  </div>
  <div class="card" id="request">
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
  </div>
</div></section>

${services.length ? `<section class="s"><div class="wrap"><h2>Services</h2><div class="grid">${services.map((p) => `<div class="svc"><h3>${esc(p.name)}</h3>${p.bookable ? `<p class="price">${money(p.price_cents)}</p>` : ''}${p.description ? `<p>${esc(p.description)}</p>` : ''}</div>`).join('')}</div></div></section>` : ''}

${t.about || t.owner_photo ? `<section class="s"><div class="wrap about">${t.owner_photo ? `<img src="${img(t.owner_photo)}" alt="${esc(t.name)}">` : ''}<div><h2>About us</h2>${para(t.about)}</div></div></section>` : ''}

<footer><div class="wrap">
  <div><strong style="color:#fff;font-size:20px">${esc(t.name)}</strong>${t.service_area ? `<br>Serving ${esc(t.service_area)}` : ''}<br><span style="font-size:14px">© ${year} ${esc(t.name)} · <a href="/legal/privacy">Privacy</a> · <a href="/legal/customer-terms">Customer terms</a></span></div>
  ${tel ? `<div><a class="big" href="tel:${tel}">${esc(t.phone)}</a></div>` : ''}
</div></footer>
<script src="/static/site.js"></script>
</body>
</html>`;
}
