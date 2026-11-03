// Moves Mike's RSQU Mobile RV Service website onto his HitchPoint-hosted site (Bold look) so he can
// edit it himself: name and tagline, banner, service tiles, highlights, services (with a full page
// for winterizing), credentials, FAQs, cities served and his customer checklists.
// Runs once. After that it stops, because Mike may have edited his site; add --force to apply it
// again, which replaces those sections and the pictures and files this script added (never his own).
//
// Usage (Render shell): node scripts/apply-rsqu-site.js            (rsqu-mobile-rv-service, Mike's live
//                                                                  business, else mike-stevens from seed-mike.js)
//                       node scripts/apply-rsqu-site.js other-slug
//                       node scripts/apply-rsqu-site.js --copy     (already moved: update only the
//                                                                  service-area copy below)
//                       node scripts/apply-rsqu-site.js --force
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { randomToken } from '../src/auth.js';
import { parseProfile } from '../src/site-profile.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'seed', 'rsqu');
const args = process.argv.slice(2);
const force = args.includes('--force');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const db = openDb(dataDir);
const slug = args.find((a) => !a.startsWith('--'))
  || (db.prepare(`SELECT 1 FROM tenants WHERE slug = 'rsqu-mobile-rv-service'`).get() ? 'rsqu-mobile-rv-service' : 'mike-stevens');
const uploads = path.join(dataDir, 'uploads');
const t = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
if (!t) { console.error(`No business with the address "${slug}". Run scripts/seed-mike.js first, or pass the right slug.`); process.exit(1); }

const findProduct = (name) => db.prepare('SELECT * FROM products WHERE tenant_id = ? AND lower(name) = lower(?)').get(t.id, name);
const WINTER = `## Why winterizing matters
Any water left in an RV’s plumbing when the temperature drops below freezing can do real damage.
- Water expands when it freezes. Water that freezes inside a pipe, fitting, pump or water heater pushes outward hard enough to crack it.
- The damage hides until spring. Cracked lines and fittings often don’t show until you fill up for the first trip and find water inside the walls or under the floor.
- Utah freezes early, and harder up high. Nights drop below freezing along the Wasatch Front through the fall and winter, and earlier and colder in Park City, Heber and Ogden Valley.
- Freeze damage is expensive and avoidable. Replacing a water heater, pump or hidden lines costs far more than winterizing, and many warranties don’t cover freeze damage.

## The 12-step winterizing checklist
Every step Mike does on every rig. Doing it yourself? Use this as your list, and call Mike if you get stuck.
- Drain the fresh water tank, so there’s no standing water to freeze and split the tank.
- Dump and flush the holding tanks, and rinse the black tank so waste doesn’t freeze into the valves.
- Drain the water heater with it off, cool and depressurized. Mike checks the anode rod while it’s out.
- Open the low-point drains and every faucet, hot and cold, inside and out.
- Bypass the water heater so antifreeze goes through the lines instead of filling the tank.
- Blow out the lines with compressed air so the antifreeze isn’t diluted.
- Pump non-toxic RV antifreeze through every line until it runs pink at each faucet, the shower, the toilet and the outside shower.
- Protect the drains and traps with antifreeze in every sink, shower drain and the toilet.
- Take care of the extras: ice makers, washing machines, dishwashers and water filters get drained, bypassed or removed.
- Close everything up: faucets closed, drain plugs back in, water pump off.
- Batteries charged and disconnected, and propane shut off at the tank.
- A quick look over the roof, seals and tires, with a note on anything that could cause trouble before spring.

## What $499 covers
- All 12 checklist steps, done by Mike at your rig
- Non-toxic RV antifreeze
- Travel to you anywhere in the service area
- A walk-around of the roof, seals and tires
- A short written list of anything he notices
Repairs found during the visit are quoted separately, and only done if you say yes.

## When should I winterize?
Before the first night below freezing, which usually comes in October on the Wasatch Front and earlier in the mountain valleys. If the forecast is close, don’t wait.

## Do I need to be there?
Not if Mike can get into the rig and reach it with his truck. Just arrange access when you book.

## Can Mike de-winterize in the spring?
Yes. Call or text to set up a spring visit to flush the antifreeze and check for leaks before your first trip.`;
// The winterizing package and its page. A business that signed up on its own doesn't have the
// package yet, so it's added at $499, the price on Mike's old site.
const WINTER_NAME = 'Onsite RV winterizing package';
function ensureWinter(sort) {
  const w = findProduct(WINTER_NAME);
  if (w) { db.prepare('UPDATE products SET on_site = 1, bookable = 1, active = 1, sort = ?, details = ? WHERE id = ?').run(sort, WINTER, w.id); return false; }
  db.prepare('INSERT INTO products (tenant_id, name, description, price_cents, on_site, bookable, details, sort) VALUES (?,?,?,?,1,1,?,?)')
    .run(t.id, WINTER_NAME, 'All 12 winterizing steps, RV antifreeze, labor and travel within the service area.', 49900, WINTER, sort);
  return true;
}

// What the site says about where Mike works and what he works on: Northern Utah, by county, RVs and
// trailers, repair and maintenance (for local and AI search). --copy updates only these on a site
// that has already moved, leaving everything else Mike changed alone.
const COUNTIES = 'Salt Lake, Davis, Weber, Morgan, Summit and Wasatch counties';
const COPY = {
  hero_headline: 'Mobile RV and trailer repair in Northern Utah',
  tagline: `Mobile RV and trailer repair and maintenance in Northern Utah’s ${COUNTIES}. Mike Stevens comes to your campsite, storage lot, driveway or roadside, with the calm of 30 years in the fire service.`,
  service_area: `Northern Utah: ${COUNTIES}. South Salt Lake to North Ogden, plus Park City, Heber Valley, Morgan and Ogden Valley`,
  about: 'RSQU Mobile RV Service is Mike Stevens’s mobile repair and maintenance service for RVs and trailers across Northern Utah: motorhomes, travel trailers, fifth wheels, toy haulers, and cargo, utility, horse and boat trailers, whether they’re parked at home, at a campsite or broken down on the road. Mike covers Salt Lake, Davis, Weber, Morgan, Summit and Wasatch counties.\n\nMike has served 30 years as a firefighter in Salt Lake City, Utah. He brings the same habits to every call: scene safety first, a size-up by phone before he rolls so he shows up ready, and straight answers. If it can be fixed on the spot, he fixes it. If it can’t, he tells you and helps you plan the next move.',
  highlights: {
    'All RV types': { icon: 'gear', title: 'RVs and trailers', text: 'Motorhomes · travel trailers · 5th wheels · toy haulers · utility trailers' },
    'RVs and trailers': { icon: 'gear', title: 'RVs and trailers', text: 'Motorhomes · travel trailers · 5th wheels · toy haulers · utility trailers' },
    'Service area': { icon: 'pin', title: 'Service area', text: `Northern Utah: ${COUNTIES}` },
  },
  faqs: {
    'Does Mike come to me?': 'Yes. Mike is fully mobile for RV and trailer repair and maintenance. He works on highway shoulders, at campgrounds and RV parks, in storage lots and in driveways across Northern Utah.',
    'What area does Mike cover?': `Northern Utah: ${COUNTIES}. That’s South Salt Lake north to North Ogden (Salt Lake City, Bountiful, Farmington, Layton, Ogden), plus the back side of the Wasatch: Park City, Heber Valley, Morgan and Ogden Valley. That includes breakdowns on I-15, I-80 and I-84.`,
  },
};

const before = parseProfile(t.site_profile);
if (before.import && before.import.by === 'rsqu' && !force) {
  // Already moved: a re-run adds a missing winterizing page, and with --copy updates the copy above.
  // Nothing else changes.
  const notes = [];
  if (!findProduct(WINTER_NAME)) { ensureWinter(10); notes.push('Added the winterizing package and its page ($499, as on the old site).'); }
  if (args.includes('--copy')) {
    db.prepare('UPDATE tenants SET tagline = ?, hero_headline = ?, about = ?, service_area = ? WHERE id = ?').run(COPY.tagline, COPY.hero_headline, COPY.about, COPY.service_area, t.id);
    const site = parseProfile(t.site_profile);
    site.highlights = site.highlights.map((h) => COPY.highlights[h.title] || h);
    site.faqs = site.faqs.map((f) => (COPY.faqs[f.q] ? { ...f, a: COPY.faqs[f.q] } : f));
    db.prepare('UPDATE tenants SET site_profile = ? WHERE id = ?').run(JSON.stringify(site), t.id);
    notes.push('Updated the headline, description, service area, About text, the “RVs and trailers” and “Service area” highlights and the two service-area FAQs.');
  }
  if (notes.length) { console.log(`${notes.join(' ')} Nothing else changed.`); process.exit(0); }
  console.log(`Already applied on ${before.import.at}. Nothing changed. Run with --force to apply it again (that replaces Mike's edits to these sections).`);
  process.exit(0);
}
// Only files this script added before are ever deleted.
const ownFiles = new Set(before.import?.files || []);
const added = [];
const copy = (file, prefix) => {
  const ext = path.extname(file);
  const name = `t${t.id}-${prefix}-${randomToken(8)}${ext}`;
  fs.copyFileSync(path.join(SRC, file), path.join(uploads, name));
  added.push(name);
  return name;
};
const remove = (name) => { if (name && ownFiles.has(name)) try { fs.unlinkSync(path.join(uploads, path.basename(name))); } catch { /* gone */ } };

// ---- business details ----
db.prepare(`UPDATE tenants SET name = ?, tagline = ?, hero_headline = ?, about = ?, service_area = ?, primary_color = ?, accent_color = ? WHERE id = ?`).run(
  'RSQU Mobile RV Service', COPY.tagline, COPY.hero_headline, COPY.about, COPY.service_area, '#C8101A', '#F0242E', t.id);

// ---- services (price list + website) ----
const SERVICES = [
  ['Slides', 'Slide-outs stuck open or closed, or moving slowly or unevenly.', 'service-slides.webp'],
  ['Awnings', 'Awnings that won’t extend or retract, including when you need to pack up and leave.', 'service-awnings.webp'],
  ['Leveling systems', 'Leveling jacks stuck down and systems that won’t level the coach.', 'service-leveling-systems.webp'],
  ['Black and grey tanks', 'Slow drains, backups, odors and tank monitors that read wrong.', 'service-black-grey-tanks.webp'],
  ['Plumbing', 'Leaks, burst lines and loose fittings, from freeze damage to worn connections, plus odors and slow drains.', 'service-plumbing.webp'],
  ['Air conditioning and heating', 'AC units, furnaces and heat pumps that won’t turn on, cool or heat.', 'service-air-conditioning-heating.webp'],
  ['Electrical', 'Dead house batteries, blown fuses and converters that quit, plus running lights, turn signals and 7-pin plugs.', 'service-electrical.webp'],
  ['Roadside breakdowns', 'Flat tires and blowouts, hot wheel bearings and hubs, electric brakes and breakaway switches, couplers, tongue jacks and safety chains.', null],
  ['Roof and storm damage', 'Wind and hail damage sealed up so you can get home dry.', null],
];
SERVICES.forEach(([name, description, image], i) => {
  let p = findProduct(name);
  if (!p) p = db.prepare('SELECT * FROM products WHERE id = ?').get(db.prepare('INSERT INTO products (tenant_id, name, description, price_cents, on_site) VALUES (?,?,?,0,1)').run(t.id, name, description).lastInsertRowid);
  if (image && (!p.image || ownFiles.has(p.image))) { remove(p.image); db.prepare('UPDATE products SET image = ? WHERE id = ?').run(copy(image, 'prod'), p.id); }
  db.prepare('UPDATE products SET description = ?, on_site = 1, active = 1, sort = ? WHERE id = ?').run(description, i + 1, p.id);
});
ensureWinter(SERVICES.length + 1);
const diag = findProduct('Repair diagnosis and onsite review');
if (diag) db.prepare('UPDATE products SET sort = ? WHERE id = ?').run(SERVICES.length + 2, diag.id);

// ---- website sections ----
const profile = parseProfile(t.site_profile);
remove(profile.banner.desktop); remove(profile.banner.mobile);
for (const r of profile.resources) if (ownFiles.has(r.file)) remove(r.file);
const resource = (file, title, description) => {
  const name = copy(file, 'doc');
  return { file: name, title, description, size: fs.statSync(path.join(uploads, name)).size, added_at: new Date().toISOString() };
};
const keepCities = new Map(profile.cities.map((c) => [`${c.name}|${c.state}`, c.intro]));
const keepBanner = (kind) => (profile.banner[kind] && !ownFiles.has(profile.banner[kind]) ? profile.banner[kind] : '');
const next = {
  ...profile,
  theme: 'bold',
  service_phrase: profile.service_phrase || 'Mobile RV repair',
  // Keeps a banner Mike uploaded himself; otherwise uses the RSQU banner.
  banner: { desktop: keepBanner('desktop') || copy('rsqu-hero.jpg', 'site'), mobile: keepBanner('mobile') || copy('rsqu-hero-mobile.jpg', 'site'), alt: profile.banner.alt || 'RSQU Mobile RV Service: mobile RV maintenance and repair service' },
  highlights: [
    { icon: 'tools', title: 'On-site service', text: 'At your location' },
    { icon: 'shield', title: 'Reliable repairs', text: 'Get back on the road' },
    COPY.highlights['All RV types'],
    COPY.highlights['Service area'],
  ],
  credentials: [
    { title: 'RV systems certificate training', detail: 'National RV Training Academy (NRVTA), Athens, Texas' },
    { title: '30 years in the fire service', detail: 'Salt Lake City Fire: recognizing hazards, communicating clearly and working safety-first' },
  ],
  faqs: [
    { q: 'Does Mike come to me?', a: COPY.faqs['Does Mike come to me?'] },
    { q: 'What area does Mike cover?', a: COPY.faqs['What area does Mike cover?'] },
    { q: 'Can I text instead of calling?', a: `Yes. Text ${t.phone || 'Mike'} with your location, your RV or trailer’s year, make and model, and a photo of the problem.` },
    { q: 'What kinds of RVs and trailers does Mike repair?', a: 'Class A, B and C motorhomes, travel trailers, fifth wheels, toy haulers, pop-up campers, and cargo, utility, horse and boat trailers.' },
    { q: 'How much does a repair cost?', a: 'Mike’s diagnosis and onsite review is $129, paid up front. He finds the problem and gives you a written quote to approve and sign on the spot. If you go ahead with the repair, the $129 is credited toward the job.' },
    { q: 'What if it can’t be fixed where it’s parked?', a: 'Mike will tell you on the spot and help you work out the next step, such as a tow to a repair shop.' },
    { q: 'Is Mike really a firefighter?', a: 'Yes. Mike Stevens has 30 years in the fire service in Salt Lake City, Utah, and he runs every repair call with a firefighter’s focus on scene safety.' },
  ],
  // Cities from his service area. Each page goes to Google once Mike writes a few sentences for it.
  cities: [['South Salt Lake', 'UT'], ['Salt Lake City', 'UT'], ['Bountiful', 'UT'], ['Farmington', 'UT'], ['Layton', 'UT'], ['Ogden', 'UT'], ['North Ogden', 'UT'], ['Park City', 'UT'], ['Heber City', 'UT'], ['Morgan', 'UT'], ['Huntsville', 'UT']]
    .map(([name, state]) => ({ name, state, intro: keepCities.get(`${name}|${state}`) || '' }))
    .concat(profile.cities.filter((c) => !['South Salt Lake', 'Salt Lake City', 'Bountiful', 'Farmington', 'Layton', 'Ogden', 'North Ogden', 'Park City', 'Heber City', 'Morgan', 'Huntsville'].includes(c.name)))
    .slice(0, 20),
  resources: [
    ...profile.resources.filter((r) => !ownFiles.has(r.file)),
    resource('know-before-you-go-10-minute-rv-check.pdf', 'Know Before You Go: 10-minute RV check', 'A walk-around before you leave: tires, water and electrical, slides and awnings, propane and alarms, hitch and lights.'),
    resource('plumbing-spot-check.pdf', 'Plumbing spot check', 'Odors, leaks and drains: where you notice it, which fixture, and when it happens.'),
    resource('heating-and-air-spot-check.pdf', 'Heating and air conditioning spot check', 'AC, furnace and heat pump problems, plus what to do first if you smell gas or hear a CO alarm.'),
    resource('black-and-grey-tank-spot-check.pdf', 'Black and grey tank spot check', 'Odors, slow drains, backups and what your tank monitor shows.'),
    resource('mike-stevens-credentials-and-experience.pdf', 'Mike’s credentials and experience', 'RV systems training and 30 years in the fire service.'),
  ],
};
next.import = { by: 'rsqu', at: new Date().toISOString(), files: added };
db.prepare('UPDATE tenants SET site_profile = ? WHERE id = ?').run(JSON.stringify(next), t.id);
console.log(`Done. ${next.cities.length} cities, ${SERVICES.length} services (${SERVICES.filter((s) => s[2]).length} with tile pictures), ${next.resources.length} files. Open /s/${slug} to see it.`);
console.log('Still for Mike to fill in (Business → Edit website sections): base city, hours, Google links, and a few sentences for each city. Set prices for the new services in Products.');
