// HitchPoint: the platform's owner-facing marketing site (d/b/a of Agilities).
// Server-rendered for speed and for search and AI answer engines.
export const BRAND = {
  name: 'HitchPoint',
  tagline: 'Business software for mobile RV and trailer repair technicians',
  navy: '#10243A', orange: '#FF7A1A', sand: '#F5F1EA',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FAQ = [
  ['What is HitchPoint?', 'HitchPoint is business software for mobile RV and trailer repair technicians. It gives you a branded website with a service request form, a job inbox with the customer’s GPS location and photos, onsite quotes customers sign on your phone, deposits, and card and bank payments that are deposited to your bank account.'],
  ['How much does HitchPoint cost?', 'There is no monthly fee and no setup fee. When a customer pays online, a single Processing Fee is taken out before your payout: Stripe’s actual processing fee for that payment plus 3%. Cash and check payments you record yourself have no fee.'],
  ['How do I get paid, and how fast?', 'Customers pay by card or bank on a secure Stripe checkout. After the payment clears, your share is sent to your bank account by direct deposit through Stripe, typically about two business days later. Your first payout can take longer while Stripe verifies your account.'],
  ['What do I need to sign up?', 'About 15 minutes, your business name, and the details Stripe needs to verify you and pay you: your legal name or business name, EIN or SSN, address, a bank account for direct deposit, and a photo ID.'],
  ['Do my customers see HitchPoint?', 'Your website, proposals and payment pages show your business name, logo and colors. Customers’ card statements show HITCHPOINT followed by a short form of your business name, because HitchPoint processes the payment for you.'],
  ['Do I need my own website or domain?', 'No. Every business gets a hosted website with a request form. You can point your own domain at it, or connect the request form to a website you already have.'],
  ['Can I collect a deposit before I roll?', 'Yes. Set a diagnosis or trip deposit, send the customer a payment link or take it on your phone, and it is credited automatically on the job’s quote.'],
  ['Can customers book fixed-price packages like winterizing?', 'Yes. Mark any service as bookable, such as an onsite winterizing package, and customers can book it from your website with a preferred date.'],
  ['Do I have to be certified to use HitchPoint?', 'HitchPoint is built for certified and experienced RV technicians, including RV Technical Institute (RVTI) certified and NRVTA-trained techs, but certification is not required to sign up. You are responsible for any licenses and insurance your work requires.'],
  ['Who owns the customer information?', 'You do. Requests, customers and quotes belong to your business. HitchPoint does not sell personal information or send your customers to other technicians.'],
];

const STEPS = [
  ['Create your account and connect your bank', 'Sign up, accept the terms, and connect your bank account for direct deposit through Stripe. It takes about 15 minutes.'],
  ['Brand your website', 'Add your logo, colors, photo, services, prices and service area. Your site goes live right away, on our address or your own domain.'],
  ['Take jobs and get paid', 'Requests arrive with GPS and photos. Quote onsite, get a signature on your phone, and get paid by card, bank, cash or check.'],
];

const FEATURES = [
  ['Your own branded website', 'A fast, mobile-friendly site with your name, logo, colors, services and service area, and a request form that captures GPS location and photos.'],
  ['Job inbox with text alerts', 'Every request lands in one list with one-tap call, text and map. Get a text the moment a new job comes in.'],
  ['Deposits up front', 'Collect a diagnosis or trip deposit before you roll. It is credited to the job automatically.'],
  ['Onsite quotes and e-signatures', 'Build the quote from your parts and labor list in the driveway. The customer reviews it and signs with a finger.'],
  ['Paid by card, bank, cash or check', 'Customers pay on a secure Stripe checkout. Your share is deposited to your bank. Record cash and checks in a tap.'],
  ['Bookable packages', 'Sell fixed-price services like winterizing, de-winterizing or inspections that customers book online.'],
];

export function renderLanding({ origin, name = BRAND.name, email }) {
  const url = origin + '/';
  const title = `${name}: Software for Mobile RV & Trailer Repair Techs`;
  const description = 'Branded website, job inbox, onsite quotes with e-signature, deposits, and direct-deposit payouts for mobile RV and trailer repair technicians. No monthly fee.';
  const ld = [
    { '@context': 'https://schema.org', '@type': 'Organization', '@id': url + '#org', name, url, logo: origin + '/favicon.svg', email, description: BRAND.tagline, parentOrganization: { '@type': 'Organization', name: 'Agilities', url: 'https://agilitiestech.com' } },
    { '@context': 'https://schema.org', '@type': 'WebSite', '@id': url + '#site', name, url, publisher: { '@id': url + '#org' } },
    {
      '@context': 'https://schema.org', '@type': 'SoftwareApplication', name, url, applicationCategory: 'BusinessApplication', operatingSystem: 'Web browser on phone, tablet or computer',
      description, audience: { '@type': 'BusinessAudience', audienceType: 'Mobile RV and trailer repair technicians' },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'No monthly fee. Online payments carry a Processing Fee of Stripe’s actual fee plus 3%, deducted before payout. Cash and check payments have no fee.' },
      featureList: FEATURES.map((f) => f[0]), publisher: { '@id': url + '#org' },
    },
    { '@context': 'https://schema.org', '@type': 'HowTo', name: `How to start taking RV repair jobs with ${name}`, totalTime: 'PT15M', step: STEPS.map(([n, t], i) => ({ '@type': 'HowToStep', position: i + 1, name: n, text: t })) },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ];
  const ldTags = ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n');
  const logo = (size = 36) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#FF7A1A"/><path d="M32 54c-1.2 0-2.2-.6-2.9-1.6C24 45 15 35.4 15 26.5 15 17.4 22.6 10 32 10s17 7.4 17 16.5C49 35.4 40 45 34.9 52.4c-.7 1-1.7 1.6-2.9 1.6z" fill="#10243A"/><circle cx="32" cy="26" r="8" fill="#FF7A1A"/><rect x="29" y="33" width="6" height="9" rx="2" fill="#FF7A1A"/></svg>`;
  const check = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FF7A1A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="${BRAND.navy}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(origin)}/static/brand/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(name)}: ${esc(BRAND.tagline)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(origin)}/static/brand/og.png">
<link rel="alternate" type="text/plain" href="/llms.txt" title="${esc(name)} summary for AI assistants">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&amp;family=Barlow:wght@400;500;600&amp;display=swap" rel="stylesheet">
${ldTags}
<style>
:root{--navy:#10243A;--navy2:#183552;--orange:#FF7A1A;--sand:#F5F1EA;--ink:#14202C;--text:#2B3640;--muted:#55616C;--line:#DDD6CA;--head:'Archivo','Arial Narrow',Arial,sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:'Barlow','Helvetica Neue',Arial,sans-serif;font-size:18px;line-height:1.6;color:var(--text);background:#fff}
a{color:#B4500B}:focus-visible{outline:3px solid var(--orange);outline-offset:3px}[hidden]{display:none!important}
.wrap{max-width:1160px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
h1,h2,h3{font-family:var(--head);color:var(--ink);line-height:1.1;margin:0;letter-spacing:-.01em}
h2{font-size:clamp(30px,3.6vw,44px);font-weight:800;margin-bottom:14px}h3{font-size:21px;font-weight:600;margin-bottom:6px}
.eyebrow{font-family:var(--head);font-weight:600;font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:#B4500B;margin:0 0 10px}
.lede{font-size:20px;color:var(--muted);max-width:40em;margin:0 0 36px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 24px;border-radius:8px;font-family:var(--head);font-weight:600;font-size:18px;text-decoration:none;border:2px solid transparent;cursor:pointer}
.btn-o{background:var(--orange);color:var(--navy)}.btn-o:hover{background:#FF8F3D}.btn-l{border-color:#fff;color:#fff}.btn-n{background:var(--navy);color:#fff}
header.top{background:var(--navy);color:#fff;position:sticky;top:0;z-index:5}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:68px}
.logo{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-family:var(--head);font-weight:800;font-size:23px}
nav.main{display:flex;align-items:center;gap:6px}nav.main a{color:#D7E1EA;text-decoration:none;font-weight:600;padding:10px 10px;min-height:44px;display:inline-flex;align-items:center}
nav.main a:hover{color:#fff}nav.main .btn{min-height:44px;padding:0 16px;font-size:16px;color:var(--navy)}
@media(max-width:820px){nav.main a.hide{display:none}}
.hero{background:var(--navy);color:#fff;padding:40px 0 80px;overflow:hidden}
.hero .wrap{display:grid;grid-template-columns:1.15fr .85fr;gap:48px;align-items:center}
@media(max-width:900px){.hero .wrap{grid-template-columns:1fr}}
.hero h1{color:#fff;font-size:clamp(38px,5.4vw,64px);font-weight:800;margin-bottom:20px}
.hero h1 em{font-style:normal;color:var(--orange)}
.hero p.sub{font-size:21px;color:#D7E1EA;margin:0 0 28px;max-width:34em}
.row{display:flex;flex-wrap:wrap;gap:12px}
.trust{list-style:none;padding:0;margin:28px 0 0;display:flex;flex-wrap:wrap;gap:10px 22px;color:#D7E1EA;font-weight:500}
.trust li{display:flex;gap:8px;align-items:center}
.phone{justify-self:center;width:300px;max-width:100%;background:#0A1828;border-radius:38px;padding:14px;box-shadow:0 30px 60px rgba(0,0,0,.45),inset 0 0 0 2px #24496C}
.screen{background:var(--sand);border-radius:28px;padding:18px 14px;display:flex;flex-direction:column;gap:12px;color:var(--ink);font-size:15px;line-height:1.4}
.scr-h{display:flex;justify-content:space-between;align-items:center;font-family:var(--head);font-weight:800;font-size:17px}
.pill{background:var(--orange);color:var(--navy);border-radius:12px;padding:2px 9px;font-size:12px;font-weight:700}
.card{background:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 1px 0 var(--line)}
.card b{font-family:var(--head);font-size:16px;display:block}
.muted{color:var(--muted)}.small{font-size:14px}
.tagx{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;background:#E6EEF6;color:var(--navy);border-radius:4px;padding:1px 6px;margin-right:4px}
.paid{background:var(--navy);color:#fff}.paid b{color:var(--orange);font-size:22px}
section.s{padding:clamp(64px,8vw,104px) 0}section.alt{background:var(--sand)}
.who{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:14px;list-style:none;padding:0;margin:0}
.who li{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;font-weight:600;color:var(--ink);display:flex;gap:10px;align-items:flex-start}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:22px}
.feat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:24px}
.feat .ic{width:44px;height:44px;border-radius:10px;background:var(--navy);display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.feat p{margin:0;color:var(--muted);font-size:17px}
ol.steps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:22px;counter-reset:s}
ol.steps li{counter-increment:s;background:#fff;border-radius:14px;padding:26px;border:1px solid var(--line)}
ol.steps li::before{content:counter(s);display:flex;width:44px;height:44px;border-radius:50%;background:var(--orange);color:var(--navy);font-family:var(--head);font-weight:800;font-size:22px;align-items:center;justify-content:center;margin-bottom:14px}
ol.steps p{margin:0;color:var(--muted);font-size:17px}
.price{display:grid;grid-template-columns:1fr 1.1fr;gap:28px;align-items:start}@media(max-width:860px){.price{grid-template-columns:1fr}}
.big{font-family:var(--head);font-weight:800;font-size:72px;line-height:1;color:var(--ink)}
.big small{font-size:22px;color:var(--muted);font-weight:600}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;border:1px solid var(--line);font-size:17px}
caption{text-align:left;font-family:var(--head);font-weight:600;font-size:18px;color:var(--ink);padding:0 0 10px}
th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left}th[scope=col]{background:var(--navy);color:#fff;font-family:var(--head);font-weight:600;font-size:15px}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr.tot td{font-weight:700;color:var(--ink)}
.own{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center}@media(max-width:860px){.own{grid-template-columns:1fr}}
.own ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:14px}.own li{display:flex;gap:12px;align-items:flex-start;font-size:18px}
details{border-bottom:1px solid var(--line);padding:4px 0}summary{cursor:pointer;font-family:var(--head);font-weight:600;font-size:20px;color:var(--ink);padding:16px 0;min-height:44px;list-style-position:outside}
details p{margin:0 0 18px;color:var(--text);max-width:52em}
.cta{background:var(--navy);color:#fff}.cta h2{color:#fff}.cta .lede{color:#D7E1EA}
.formcard{background:#fff;color:var(--text);border-radius:16px;padding:clamp(20px,3vw,32px);max-width:640px}
.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}@media(max-width:600px){.fgrid{grid-template-columns:1fr}}
label{display:block;font-family:var(--head);font-weight:600;font-size:16px;color:var(--ink);margin:14px 0 4px}
input,textarea{display:block;width:100%;min-height:48px;padding:10px 12px;font:inherit;font-size:17px;border:2px solid #8B96A0;border-radius:8px;color:var(--ink);background:#fff}textarea{min-height:96px;resize:vertical}
.err{background:#FDECEA;color:#8A1C10;font-weight:600;padding:10px 12px;border-radius:8px;margin:14px 0 0}
.ok{background:#E6F4EA;color:#1D5B33;font-weight:600;padding:14px;border-radius:8px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:start}@media(max-width:900px){.split{grid-template-columns:1fr}}
footer{background:#0A1828;color:#AFC0CF;padding:40px 0;font-size:15px}footer a{color:#fff}footer .wrap{display:flex;flex-wrap:wrap;gap:16px 32px;justify-content:space-between;align-items:center}
</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="logo" href="/">${logo()}<span>${esc(name)}</span></a>
  <nav class="main" aria-label="Main">
    <a class="hide" href="#how">How it works</a><a class="hide" href="#pricing">Pricing</a><a class="hide" href="#faq">FAQ</a>
    <a href="/admin/">Log in</a><a class="btn btn-o" href="/signup">Start free</a>
  </nav>
</div></header>

<main>
<section class="hero" aria-labelledby="h1"><div class="wrap">
  <div>
    <p class="eyebrow" style="color:var(--orange)">For mobile RV and trailer repair techs</p>
    <h1 id="h1">Run your mobile RV repair business <em>from your phone.</em></h1>
    <p class="sub">${esc(name)} gives you your own branded website, a job inbox with GPS and photos, onsite quotes customers sign on the spot, and payments deposited straight to your bank.</p>
    <div class="row"><a class="btn btn-o" href="/signup">Start free, set up in 15 minutes</a><a class="btn btn-l" href="#talk">Talk to us first</a></div>
    <ul class="trust">
      <li>${check} No monthly fee</li><li>${check} Your brand, your customers</li><li>${check} Paid by direct deposit</li>
    </ul>
  </div>
  <div class="phone" role="img" aria-label="Example of the ${esc(name)} app on a phone: a new repair request with GPS location and photo, a signed quote, and a payout on its way to the bank">
    <div class="screen" aria-hidden="true">
      <div class="scr-h"><span>Requests</span><span class="pill">2 new</span></div>
      <div class="card"><span class="tagx">Repair</span><span class="tagx">Photo</span><b>Dana W. · I-15 NB, mile 290</b><span class="muted small">2019 Jayco Jay Flight · Left rear blowout, spare stuck under frame</span></div>
      <div class="card"><span class="tagx">Booking</span><b>Lee P. · Winterizing $499</b><span class="muted small">Storage lot, North Ogden · wants Nov 5</span></div>
      <div class="card"><b>Quote #48 signed</b><span class="muted small">2 trailer tires + labor · $587.53</span></div>
      <div class="card paid"><span class="small">Payout on its way</span><b>$552.56</b><span class="small" style="color:#AFC0CF">to your bank by direct deposit</span></div>
    </div>
  </div>
</div></section>

<section class="s" aria-labelledby="who-h"><div class="wrap">
  <p class="eyebrow">Who it’s for</p>
  <h2 id="who-h">Built for the techs who come to the rig</h2>
  <p class="lede">If you fix RVs and trailers where they sit, on the shoulder, at the campground, in the storage lot or the driveway, ${esc(name)} runs the business side so you can stay on the tools.</p>
  <ul class="who">
    <li>${check}<span>Certified RV technicians (RVTI, RVIA/RVDA) going independent</span></li>
    <li>${check}<span>NRVTA-trained mobile RV techs starting out</span></li>
    <li>${check}<span>Mobile trailer, hitch and brake repair</span></li>
    <li>${check}<span>Winterizing and de-winterizing specialists</span></li>
    <li>${check}<span>RV shops adding a mobile service truck</span></li>
    <li>${check}<span>Roadside and emergency RV repair</span></li>
  </ul>
</div></section>

<section class="s alt" aria-labelledby="feat-h"><div class="wrap">
  <p class="eyebrow">Everything in one app</p>
  <h2 id="feat-h">From the first call to money in the bank</h2>
  <p class="lede">No apps to stitch together. It works in the browser on your phone, tablet or computer.</p>
  <div class="grid">${FEATURES.map(([t, d]) => `<article class="feat"><div class="ic">${check}</div><h3>${esc(t)}</h3><p>${esc(d)}</p></article>`).join('')}</div>
</div></section>

<section class="s" id="how" aria-labelledby="how-h"><div class="wrap">
  <p class="eyebrow">How it works</p>
  <h2 id="how-h">Up and running in an afternoon</h2>
  <p class="lede">Three steps. Most techs take their first request the same day.</p>
  <ol class="steps">${STEPS.map(([t, d]) => `<li><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}</ol>
  <p style="margin-top:32px"><a class="btn btn-n" href="/signup">Create your account</a></p>
</div></section>

<section class="s alt" id="pricing" aria-labelledby="price-h"><div class="wrap">
  <p class="eyebrow">Pricing</p>
  <h2 id="price-h">No monthly fee. You only pay when you get paid.</h2>
  <div class="price">
    <div>
      <p class="big">$0<small> per month</small></p>
      <p>No setup fee. When a customer pays online, one <strong>Processing Fee</strong> comes out before your payout: Stripe’s actual fee for that payment plus 3%. It covers card and bank processing, your website, the app, and direct deposit.</p>
      <p><strong>Cash and checks are free.</strong> Record them in a tap and nothing is deducted.</p>
    </div>
    <table>
      <caption>Example: a $1,000.00 repair paid online</caption>
      <thead><tr><th scope="col">Paid by</th><th scope="col" class="n">Card</th><th scope="col" class="n">Bank (ACH)</th></tr></thead>
      <tbody>
        <tr><td>Customer pays</td><td class="n">$1,000.00</td><td class="n">$1,000.00</td></tr>
        <tr><td>Stripe fee*</td><td class="n">−$29.30</td><td class="n">−$5.00</td></tr>
        <tr><td>${esc(name)} 3%</td><td class="n">−$30.00</td><td class="n">−$30.00</td></tr>
        <tr class="tot"><td>Deposited to your bank</td><td class="n">$940.70</td><td class="n">$965.00</td></tr>
      </tbody>
    </table>
  </div>
  <p class="small muted" style="margin-top:14px">*Stripe’s standard U.S. pricing at the time of writing: cards 2.9% + 30¢, ACH bank payments 0.8% capped at $5. International cards and other methods can cost more. The actual Stripe fee for each payment is shown in your dashboard.</p>
</div></section>

<section class="s" aria-labelledby="own-h"><div class="wrap own">
  <div>
    <p class="eyebrow">Your brand, your customers</p>
    <h2 id="own-h">Not a lead marketplace</h2>
    <p class="lede" style="margin-bottom:0">${esc(name)} doesn’t sell your jobs to the next tech on a list. Your website, your phone number and your customers stay yours, and every repeat call comes straight to you.</p>
  </div>
  <ul>
    <li>${check}<span>Customers see your business name, logo and colors on your site, proposals and payment pages.</span></li>
    <li>${check}<span>Use your own domain, or connect the request form to a site you already have.</span></li>
    <li>${check}<span>Signed proposals record the customer’s name, signature, time and device, so the scope is never in question.</span></li>
    <li>${check}<span>Built alongside a working mobile RV repair business in Utah, for real roadside and campground jobs.</span></li>
  </ul>
</div></section>

<section class="s alt" id="faq" aria-labelledby="faq-h"><div class="wrap">
  <p class="eyebrow">Questions</p>
  <h2 id="faq-h">Frequently asked questions</h2>
  ${FAQ.map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n  ')}
</div></section>

<section class="s cta" id="talk" aria-labelledby="talk-h"><div class="wrap split">
  <div>
    <h2 id="talk-h">Ready to run it like a business?</h2>
    <p class="lede">Start free now, or leave your details and we’ll call you, walk you through it, and set up your site with you.</p>
    <p><a class="btn btn-o" href="/signup">Start free</a></p>
    ${email ? `<p class="small" style="color:#AFC0CF">Or email <a href="mailto:${esc(email)}" style="color:#fff">${esc(email)}</a></p>` : ''}
  </div>
  <div class="formcard">
    <form id="lead" novalidate>
      <div style="position:absolute;left:-9999px" aria-hidden="true"><label for="website">Leave empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
      <h3 style="font-size:24px">Talk to us</h3>
      <div class="fgrid">
        <div><label for="l-name">Your name</label><input id="l-name" name="name" autocomplete="name" required></div>
        <div><label for="l-biz">Business name</label><input id="l-biz" name="business_name" autocomplete="organization"></div>
        <div><label for="l-email">Email</label><input id="l-email" name="email" type="email" autocomplete="email"></div>
        <div><label for="l-phone">Mobile phone</label><input id="l-phone" name="phone" type="tel" autocomplete="tel"></div>
        <div><label for="l-loc">City and state</label><input id="l-loc" name="location" autocomplete="address-level2"></div>
        <div><label for="l-cert">Certifications (optional)</label><input id="l-cert" name="certifications" placeholder="RVTI Level 2, NRVTA…"></div>
      </div>
      <label for="l-msg">Anything we should know?</label><textarea id="l-msg" name="message" rows="3"></textarea>
      <p class="err" id="l-err" role="alert" hidden></p>
      <p class="small muted" style="margin:12px 0">We’ll only use this to contact you about ${esc(name)}. <a href="/legal/privacy">Privacy</a></p>
      <button class="btn btn-o" type="submit" style="width:100%">Have someone call me</button>
    </form>
    <div id="l-ok" class="ok" role="status" hidden>Thanks! We’ll be in touch within one business day.</div>
  </div>
</div></section>
</main>

<footer><div class="wrap">
  <div><a class="logo" href="/" style="font-size:20px">${logo(28)}<span>${esc(name)}</span></a><p style="margin:8px 0 0">${esc(BRAND.tagline)}. ${esc(name)} is a d/b/a of Agilities.</p></div>
  <div><a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/payment-terms">Payment terms</a> · <a href="/admin/">Log in</a>${email ? ` · <a href="mailto:${esc(email)}">${esc(email)}</a>` : ''}</div>
</div></footer>
<script src="/static/landing.js"></script>
</body>
</html>`;
}

export function robotsTxt(origin) {
  return `# Search engines and AI assistants are welcome on the public site.
User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Disallow: /p/
Disallow: /pay/

User-agent: GPTBot
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-SearchBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Applebot-Extended
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

export function sitemapXml(origin) {
  const urls = ['/', '/signup', '/legal/terms', '/legal/privacy', '/legal/payment-terms'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`).join('\n')}
</urlset>
`;
}

export function llmsTxt(origin, email) {
  return `# ${BRAND.name}

> ${BRAND.name} is business software for mobile RV and trailer repair technicians in the United States. It gives each business a branded website with a service request form, a job inbox (GPS location, photos, text alerts), deposits, onsite quotes with finger e-signatures, and card and bank payments paid out to the business's bank by direct deposit. ${BRAND.name} is a d/b/a of Agilities.

## Key facts
- Who it's for: mobile RV technicians (including RVTI/RVIA-RVDA certified and NRVTA-trained techs), mobile trailer repair, winterizing specialists, and RV shops with a mobile truck.
- Price: no monthly fee and no setup fee. Online payments carry one Processing Fee, deducted before payout: Stripe's actual processing fee for that payment plus 3%. Cash and check payments have no fee.
- Example: a $1,000 card payment pays out $940.70 (Stripe 2.9% + 30 cents = $29.30, plus 3% = $30.00), using Stripe's standard U.S. card pricing at the time of writing.
- Payouts: by Stripe direct deposit, typically about two business days after a payment clears; first payouts can take longer.
- Customers see the technician's brand. Card statements show HITCHPOINT plus the business name.
- The business owns its customer data; ${BRAND.name} is not a lead marketplace.
- Sign-up takes about 15 minutes, including Stripe identity verification and a bank account for direct deposit.

## Links
- Home: ${origin}/
- Sign up: ${origin}/signup
- Terms: ${origin}/legal/terms
- Payment terms: ${origin}/legal/payment-terms
- Privacy: ${origin}/legal/privacy
${email ? `- Contact: ${email}\n` : ''}`;
}
