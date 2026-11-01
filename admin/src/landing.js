// HitchPoint: the platform's owner-facing marketing site (d/b/a of Agilities).
// Server-rendered for speed and for search and AI answer engines.
export const BRAND = {
  name: 'HitchPoint',
  tagline: 'Business software for mobile RV and trailer repair technicians',
  navy: '#10243A', orange: '#FF7A1A', sand: '#F4EBDD', pine: '#1F3D35',
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
  // Line icons (24px grid, stroke = currentColor)
  const I = {
    trailer: '<rect x="2" y="6" width="15" height="10" rx="4"/><path d="M17 13h5M5 9h4v3H5z"/><circle cx="8" cy="17.5" r="2"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    badge: '<circle cx="12" cy="9" r="6"/><path d="M8.5 13.5 7 22l5-3 5 3-1.5-8.5"/><path d="m9.5 9 1.7 1.7L14.5 7.5"/>',
    snow: '<path d="M12 2v20M4.9 6.5l14.2 11M4.9 17.5l14.2-11M9.5 3.5 12 6l2.5-2.5M9.5 20.5 12 18l2.5 2.5"/>',
    van: '<path d="M2 7h11v9H2zM13 10h4l4 3v3h-8z"/><circle cx="6" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/>',
    cone: '<path d="M10 3h4l5 17H5zM7.5 12h9M6.3 16h11.4M3 20h18"/>',
    site: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20M12 18s-3.5-3-3.5-5.5a3.5 3.5 0 0 1 7 0C15.5 15 12 18 12 18z"/>',
    inbox: '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/><path d="M3 21h18"/>',
    dollar: '<circle cx="12" cy="12" r="9.5"/><path d="M15 9.2c-.6-1-1.7-1.6-3-1.6-1.8 0-3 1-3 2.3 0 3.1 6.2 1.6 6.2 4.6 0 1.4-1.4 2.4-3.2 2.4-1.5 0-2.8-.7-3.3-1.8M12 6v1.6M12 16.9v1.6"/>',
    pen: '<path d="M3 21c3-1 5-1 7 0s4 1 7 0"/><path d="M14.5 3.5a2.1 2.1 0 0 1 3 3L8 16l-4 1 1-4z"/>',
    bank: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M12 13v6M9.4 14.5l5.2 3M9.4 17.5l5.2-3"/>',
    fire: '<path d="M12 22c4 0 6.5-2.5 6.5-6 0-4-3.5-6-4-9.5C12 9 11 11 11 13c-1.5-1-2-2.5-2-4C6.5 11 5.5 13.5 5.5 16c0 3.5 2.5 6 6.5 6z"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
  };
  const ic = (k, size = 26, sw = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;
  const WHO = [['badge', 'Certified RV technicians (RVTI, RVIA/RVDA) going independent'], ['wrench', 'NRVTA-trained mobile RV techs starting out'], ['trailer', 'Mobile trailer, hitch and brake repair'], ['snow', 'Winterizing and de-winterizing specialists'], ['van', 'RV shops adding a mobile service truck'], ['cone', 'Roadside and emergency RV repair']];
  const FEAT_ICONS = ['site', 'inbox', 'dollar', 'pen', 'bank', 'cal'];
  const ridge = (fill, flip = false) => `<svg class="ridge${flip ? ' flip' : ''}" viewBox="0 0 1600 90" preserveAspectRatio="none" aria-hidden="true"><path d="M0,90 L0,58 L90,30 L170,52 L260,12 L340,46 L420,24 L520,60 L610,28 L700,50 L790,8 L880,44 L960,26 L1060,58 L1150,20 L1240,48 L1330,30 L1420,56 L1510,24 L1600,46 L1600,90 Z" fill="${fill}"/></svg>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#0E2236">
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
<link rel="preload" as="image" href="/static/brand/hero.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bitter:wght@700;800&amp;family=Barlow:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
${ldTags}
<style>
:root{--night:#0E2236;--navy:#10243A;--orange:#FF7A1A;--ember:#FF9A3C;--pine:#1F3D35;--pine2:#16302A;--sand:#F4EBDD;--cream:#FBF7F0;--ink:#16212B;--text:#2B3640;--muted:#566370;--line:#E2D7C5;--head:'Bitter',Rockwell,'Roboto Slab',Georgia,serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:'Barlow','Helvetica Neue',Arial,sans-serif;font-size:18px;line-height:1.6;color:var(--text);background:var(--cream)}
a{color:#B4500B}:focus-visible{outline:3px solid var(--orange);outline-offset:3px}[hidden]{display:none!important}
img,svg{display:block}
.wrap{max-width:1180px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
h1,h2,h3{font-family:var(--head);color:var(--ink);line-height:1.1;margin:0}
h2{font-size:clamp(30px,3.8vw,46px);font-weight:800;margin-bottom:14px}h3{font-size:21px;font-weight:700;margin-bottom:6px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#B4500B;margin:0 0 12px}
.eyebrow::before{content:"";width:22px;height:3px;background:var(--orange);border-radius:2px}
.lede{font-size:20px;color:var(--muted);max-width:40em;margin:0 0 40px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:54px;padding:0 26px;border-radius:999px;font-weight:700;font-size:18px;text-decoration:none;border:2px solid transparent;cursor:pointer;transition:transform .15s ease,background .15s ease}
.btn:hover{transform:translateY(-1px)}
.btn-o{background:var(--orange);color:var(--night);box-shadow:0 6px 20px rgba(255,122,26,.35)}.btn-o:hover{background:#FF8D3D}
.btn-l{border-color:rgba(255,255,255,.7);color:#fff}.btn-l:hover{background:rgba(255,255,255,.08)}
.btn-n{background:var(--pine);color:#fff}
/* header */
header.top{position:absolute;top:0;left:0;right:0;z-index:5}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:76px}
.logo{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-family:var(--head);font-weight:800;font-size:24px;letter-spacing:-.01em}
nav.main{display:flex;align-items:center;gap:4px}nav.main a{color:#D9E3EC;text-decoration:none;font-weight:600;padding:10px 12px;min-height:44px;display:inline-flex;align-items:center}
nav.main a{white-space:nowrap}nav.main a:hover{color:#fff}nav.main .btn{min-height:44px;padding:0 18px;font-size:16px;color:var(--night);margin-left:6px}
@media(max-width:480px){.logo{font-size:20px}.logo svg{width:30px;height:30px}nav.main .btn{padding:0 14px;font-size:15px}nav.main a{padding:10px 8px}}
@media(max-width:820px){nav.main a.hide{display:none}}
/* hero */
.hero{position:relative;background:var(--night);color:#fff;overflow:hidden}
.hero-copy{position:relative;z-index:2;padding:clamp(120px,14vw,170px) 0 0;text-align:center}
.hero h1{color:#fff;font-size:clamp(33px,6vw,74px);overflow-wrap:break-word;font-weight:800;letter-spacing:-.015em;max-width:15em;margin:0 auto 20px;text-shadow:0 2px 24px rgba(0,0,0,.25)}
.hero h1 em{font-style:normal;color:var(--ember)}
.hero p.sub{font-size:clamp(18px,1.8vw,22px);color:#D9E3EC;margin:0 auto 30px;max-width:36em}
.row{display:flex;flex-wrap:wrap;gap:12px}.hero .row{justify-content:center}
.hero-art{position:relative;margin-top:-20px;height:clamp(300px,40vw,600px)}
.hero-art img{width:100%;height:100%;object-fit:cover;object-position:62% 100%}
@media(max-width:700px){.hero-art img{object-position:74% 100%}}
.trust{position:relative;z-index:2;background:var(--pine2);color:#E9EFE9}
.trust ul{list-style:none;margin:0;padding:18px 0;display:flex;flex-wrap:wrap;justify-content:center;gap:12px 40px;font-weight:600}
.trust li{display:flex;align-items:center;gap:10px}.trust svg{color:var(--ember)}
/* sections */
section.s{position:relative;padding:clamp(72px,9vw,120px) 0}
.topo{background-color:var(--sand);background-image:url(/static/brand/topo.svg);background-size:800px 800px}
.ridge{width:100%;height:clamp(40px,6vw,90px)}.ridge.flip{transform:scaleY(-1)}
.who{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:16px;list-style:none;padding:0;margin:0}
.who li{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 20px;font-weight:600;color:var(--ink);display:flex;gap:14px;align-items:center;box-shadow:0 1px 0 rgba(16,36,58,.04)}
.who .b{flex:0 0 auto;width:48px;height:48px;border-radius:12px;background:var(--pine);color:var(--sand);display:flex;align-items:center;justify-content:center}
.feat-wrap{display:grid;grid-template-columns:1.25fr .75fr;gap:56px;align-items:center}@media(max-width:960px){.feat-wrap{grid-template-columns:1fr}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:22px}
.feat{background:#fff;border:1px solid var(--line);border-radius:18px;padding:24px}
.feat .ic{width:50px;height:50px;border-radius:14px;background:var(--night);color:var(--ember);display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.feat p{margin:0;color:var(--muted);font-size:17px}
.phone{justify-self:center;width:300px;max-width:100%;background:#0A1828;border-radius:40px;padding:14px;box-shadow:0 30px 60px rgba(14,34,54,.35),inset 0 0 0 2px #24496C;transform:rotate(2deg)}
.screen{background:var(--sand);border-radius:28px;padding:18px 14px;display:flex;flex-direction:column;gap:12px;color:var(--ink);font-size:15px;line-height:1.4}
.scr-h{display:flex;justify-content:space-between;align-items:center;font-family:var(--head);font-weight:800;font-size:17px}
.pill{background:var(--orange);color:var(--night);border-radius:12px;padding:2px 9px;font-size:12px;font-weight:700;font-family:'Barlow',sans-serif}
.card{background:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 1px 0 var(--line)}
.card b{font-family:var(--head);font-size:15px;display:block}
.muted{color:var(--muted)}.small{font-size:14px}
.tagx{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;background:#E6EEF6;color:var(--navy);border-radius:4px;padding:1px 6px;margin-right:4px}
.paid{background:var(--pine);color:#fff}.paid b{color:var(--ember);font-size:22px}
/* trail steps */
.trail{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(3,1fr);gap:28px;position:relative}
.trail::before{content:"";position:absolute;left:8%;right:8%;top:34px;border-top:4px dashed var(--orange);opacity:.6}
@media(max-width:860px){.trail{grid-template-columns:1fr}.trail::before{left:33px;right:auto;top:20px;bottom:20px;border-top:0;border-left:4px dashed var(--orange)}}
.trail li{position:relative;background:#fff;border:1px solid var(--line);border-radius:18px;padding:26px;padding-top:30px}
.pin{position:relative;z-index:1;width:68px;height:68px;margin:-64px 0 12px;display:flex;align-items:center;justify-content:center}
.pin span{position:absolute;top:13px;font-family:var(--head);font-weight:800;font-size:22px;color:var(--night)}
@media(max-width:860px){.trail li{margin-left:70px}.pin{position:absolute;left:-70px;top:4px;margin:0}}
.trail p{margin:0;color:var(--muted);font-size:17px}
/* pricing */
.price{display:grid;grid-template-columns:1fr 1.1fr;gap:32px;align-items:start}@media(max-width:860px){.price{grid-template-columns:1fr}}
.sign{background:var(--pine);color:#F2EDE3;border-radius:20px;padding:30px;border:4px solid #2E5A4E;box-shadow:inset 0 0 0 2px #0F241F}
.sign h3{color:#fff}.big{font-family:var(--head);font-weight:800;font-size:76px;line-height:1;color:#fff}
.big small{font-size:22px;color:#C9D6CF;font-weight:700}.sign strong{color:var(--ember)}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:16px;overflow:hidden;border:1px solid var(--line);font-size:17px}
caption{text-align:left;font-family:var(--head);font-weight:700;font-size:19px;color:var(--ink);padding:0 0 10px}
th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left}th[scope=col]{background:var(--night);color:#fff;font-weight:700;font-size:15px}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr.tot td{font-weight:800;color:var(--pine);background:#F1F6F2}
/* own */
.own{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center}@media(max-width:860px){.own{grid-template-columns:1fr}}
.own ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:16px}.own li{display:flex;gap:12px;align-items:flex-start;font-size:18px}
.own li svg{flex:0 0 auto;color:var(--orange);margin-top:3px}
.dark{background:var(--night);color:#D9E3EC}.dark h2{color:#fff}.dark .lede{color:#B9C7D4}.dark .eyebrow{color:var(--ember)}
/* faq */
details{background:#fff;border:1px solid var(--line);border-radius:14px;padding:0 20px;margin-bottom:10px}
summary{cursor:pointer;font-family:var(--head);font-weight:700;font-size:19px;color:var(--ink);padding:18px 0;min-height:44px;list-style-position:outside}
details p{margin:0 0 18px;color:var(--text);max-width:52em}
/* cta */
.cta{background:radial-gradient(ellipse at 20% 100%,rgba(255,122,26,.28),transparent 55%),var(--pine2);color:#E9EFE9}
.cta h2{color:#fff}.cta .lede{color:#C9D6CF}
.formcard{background:#fff;color:var(--text);border-radius:20px;padding:clamp(20px,3vw,32px);max-width:640px;box-shadow:0 20px 40px rgba(0,0,0,.25)}
.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}@media(max-width:600px){.fgrid{grid-template-columns:1fr}}
label{display:block;font-weight:700;font-size:16px;color:var(--ink);margin:14px 0 4px}
input,textarea{display:block;width:100%;min-height:48px;padding:10px 12px;font:inherit;font-size:17px;border:2px solid #9AA4AD;border-radius:10px;color:var(--ink);background:#fff}textarea{min-height:96px;resize:vertical}
input:focus,textarea:focus{border-color:var(--pine);outline:none;box-shadow:0 0 0 3px rgba(31,61,53,.2)}
.err{background:#FDECEA;color:#8A1C10;font-weight:600;padding:10px 12px;border-radius:8px;margin:14px 0 0}
.ok{background:#E6F4EA;color:#1D5B33;font-weight:600;padding:14px;border-radius:8px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center}@media(max-width:900px){.split{grid-template-columns:1fr}}
.campfire{color:var(--ember);margin-bottom:18px}
footer{background:#0A1A16;color:#AFC0B8;padding:8px 0 40px;font-size:15px}footer a{color:#fff}footer .wrap{display:flex;flex-wrap:wrap;gap:16px 32px;justify-content:space-between;align-items:center}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.btn{transition:none}}
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
<section class="hero" aria-labelledby="h1">
  <div class="wrap hero-copy">
    <p class="eyebrow" style="color:var(--ember)">For mobile RV &amp; trailer repair techs</p>
    <h1 id="h1">Run your mobile RV repair business <em>from your phone.</em></h1>
    <p class="sub">${esc(name)} gives you your own branded website, a job inbox with GPS and photos, onsite quotes customers sign on the spot, and payments deposited straight to your bank.</p>
    <div class="row"><a class="btn btn-o" href="/signup">Start free, set up in 15 minutes</a><a class="btn btn-l" href="#talk">Talk to us first</a></div>
  </div>
  <div class="hero-art"><img src="/static/brand/hero.svg" width="1600" height="640" alt="Illustration of a ${esc(name)} mobile RV service truck parked beside a travel trailer at a mountain campground at dusk" fetchpriority="high"></div>
</section>
<div class="trust"><ul class="wrap">
  <li>${ic('check', 20, 3)} No monthly fee</li><li>${ic('check', 20, 3)} Your brand, your customers</li><li>${ic('check', 20, 3)} Paid by direct deposit</li><li>${ic('check', 20, 3)} Works on any phone</li>
</ul></div>

<section class="s" aria-labelledby="who-h"><div class="wrap">
  <p class="eyebrow">Who it’s for</p>
  <h2 id="who-h">Built for the techs who come to the rig</h2>
  <p class="lede">On the shoulder, at the campground, in the storage lot or the driveway: if you fix RVs and trailers where they sit, ${esc(name)} runs the business side so you can stay on the tools.</p>
  <ul class="who">${WHO.map(([k, t]) => `<li><span class="b">${ic(k)}</span><span>${esc(t)}</span></li>`).join('')}</ul>
</div></section>

${ridge('#F4EBDD')}
<section class="s topo" aria-labelledby="feat-h" style="padding-top:clamp(40px,5vw,72px)"><div class="wrap">
  <p class="eyebrow">Everything in one app</p>
  <h2 id="feat-h">From the first call to money in the bank</h2>
  <p class="lede">No apps to stitch together. It runs in the browser on your phone, tablet or computer.</p>
  <div class="feat-wrap">
    <div class="grid">${FEATURES.map(([t, d], i) => `<article class="feat"><div class="ic">${ic(FEAT_ICONS[i])}</div><h3>${esc(t)}</h3><p>${esc(d)}</p></article>`).join('')}</div>
    <div class="phone" role="img" aria-label="Example of the ${esc(name)} app on a phone: new repair requests with GPS and photos, a signed quote, and a payout on its way to the bank">
      <div class="screen" aria-hidden="true">
        <div class="scr-h"><span>Requests</span><span class="pill">2 new</span></div>
        <div class="card"><span class="tagx">Repair</span><span class="tagx">Photo</span><b>Dana W. · I-15 NB, mile 290</b><span class="muted small">2019 Jayco Jay Flight · Left rear blowout, spare stuck under frame</span></div>
        <div class="card"><span class="tagx">Booking</span><b>Lee P. · Winterizing $499</b><span class="muted small">Storage lot, North Ogden · wants Nov 5</span></div>
        <div class="card"><b>Quote #48 signed</b><span class="muted small">2 trailer tires + labor · $587.53</span></div>
        <div class="card paid"><span class="small">Payout on its way</span><b>$552.56</b><span class="small" style="color:#C9D6CF">to your bank by direct deposit</span></div>
      </div>
    </div>
  </div>
</div></section>
${ridge('#F4EBDD', true)}

<section class="s" id="how" aria-labelledby="how-h"><div class="wrap">
  <p class="eyebrow">How it works</p>
  <h2 id="how-h">Up and running in an afternoon</h2>
  <p class="lede" style="margin-bottom:72px">Three stops on the trail. Most techs take their first request the same day.</p>
  <ol class="trail">${STEPS.map(([t, d], i) => `<li><div class="pin" aria-hidden="true"><svg width="68" height="68" viewBox="0 0 64 64"><path d="M32 60c-1.4 0-2.6-.7-3.4-1.9C22.5 49.3 12 38 12 27.5 12 16.2 21 7 32 7s20 9.2 20 20.5C52 38 41.5 49.3 35.4 58.1c-.8 1.2-2 1.9-3.4 1.9z" fill="#FF7A1A"/><circle cx="32" cy="27" r="13" fill="#FBF7F0"/></svg><span>${i + 1}</span></div><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}</ol>
  <p style="margin-top:40px"><a class="btn btn-n" href="/signup">Create your account</a></p>
</div></section>

<section class="s topo" id="pricing" aria-labelledby="price-h"><div class="wrap">
  <p class="eyebrow">Pricing</p>
  <h2 id="price-h">No monthly fee. You only pay when you get paid.</h2>
  <div class="price" style="margin-top:28px">
    <div class="sign">
      <p class="big">$0<small> per month</small></p>
      <p>No setup fee. When a customer pays online, one <strong>Processing Fee</strong> comes out before your payout: Stripe’s actual fee for that payment plus 3%. It covers card and bank processing, your website, the app and direct deposit.</p>
      <p style="margin-bottom:0"><strong>Cash and checks are free.</strong> Record them in a tap and nothing is deducted.</p>
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
  <p class="small muted" style="margin-top:16px">*Stripe’s standard U.S. pricing at the time of writing: cards 2.9% + 30¢, ACH bank payments 0.8% capped at $5. International cards and other methods can cost more. The actual Stripe fee for each payment is shown in your dashboard.</p>
</div></section>

<section class="s dark" aria-labelledby="own-h"><div class="wrap own">
  <div>
    <p class="eyebrow">Your brand, your customers</p>
    <h2 id="own-h">Not a lead marketplace</h2>
    <p class="lede" style="margin-bottom:0">${esc(name)} doesn’t sell your jobs to the next tech on a list. Your website, your phone number and your customers stay yours, and every repeat call comes straight to you.</p>
  </div>
  <ul>
    <li>${ic('check', 22, 3)}<span>Customers see your business name, logo and colors on your site, proposals and payment pages.</span></li>
    <li>${ic('check', 22, 3)}<span>Use your own domain, or connect the request form to a site you already have.</span></li>
    <li>${ic('check', 22, 3)}<span>Signed proposals record the customer’s name, signature, time and device, so the scope is never in question.</span></li>
    <li>${ic('check', 22, 3)}<span>Built alongside a working mobile RV repair business in Utah, for real roadside and campground jobs.</span></li>
  </ul>
</div></section>

<section class="s" id="faq" aria-labelledby="faq-h"><div class="wrap" style="max-width:900px">
  <p class="eyebrow">Questions</p>
  <h2 id="faq-h" style="margin-bottom:28px">Frequently asked questions</h2>
  ${FAQ.map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n  ')}
</div></section>

${ridge('#16302A')}
<section class="s cta" id="talk" aria-labelledby="talk-h" style="padding-top:clamp(40px,5vw,72px)"><div class="wrap split">
  <div>
    <div class="campfire">${ic('fire', 44, 1.8)}</div>
    <h2 id="talk-h">Pull up a chair. Let’s get you set up.</h2>
    <p class="lede">Start free now, or leave your details and we’ll call you, walk you through it, and set up your site with you.</p>
    <p><a class="btn btn-o" href="/signup">Start free</a></p>
    ${email ? `<p class="small" style="color:#C9D6CF">Or email <a href="mailto:${esc(email)}" style="color:#fff">${esc(email)}</a></p>` : ''}
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

<div style="background:#16302A">${ridge('#0A1A16')}</div>
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
