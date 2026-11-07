// Gives each of Mike's RSQU services its own page by adding a write-up (products.details): what goes
// wrong, what Mike checks and fixes on site, what it costs and where he works. A service only gets a
// page once it has a write-up (hasPage in src/site.js), so until this runs, ads for slide-out or furnace
// repair can only land on the home page.
//
// Drafts for Mike to approve before they go live. A service that already has a write-up (Mike wrote
// one, or this ran before) is left alone unless --force is given.
//
// Usage (Render shell): node scripts/apply-rsqu-services.js             (rsqu-mobile-rv-service, else mike-stevens)
//                       node scripts/apply-rsqu-services.js other-slug
//                       node scripts/apply-rsqu-services.js --dry-run   (say what would change, change nothing)
//                       node scripts/apply-rsqu-services.js --print     (print the drafts for review)
//                       node scripts/apply-rsqu-services.js --force     (replace existing write-ups too)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { slugify } from '../src/site-profile.js';

const COST = `## What it costs
Mike’s diagnosis and onsite review is $129, paid up front. He finds the problem and gives you a written quote to approve and sign on the spot. If you go ahead with the repair, the $129 is credited toward the job.`;

const AREA = `## Where Mike works
Northern Utah: Box Elder, Weber, Davis, Salt Lake, Morgan, Summit and Wasatch counties. That’s Tremonton and Brigham City south through Ogden, Layton, Farmington and Bountiful to Salt Lake City, plus Park City, Heber Valley, Morgan and Ogden Valley. He comes to campgrounds and RV parks, storage lots, driveways and the roadside.`;

const SEND = `## Send a photo first
Use the request form, or text a photo of the problem with your location and your RV or trailer’s year, make and model. Mike sizes it up by phone before he rolls, so he shows up ready.`;

// [service name as in Mike's price list, its write-up]
export const SERVICE_PAGES = [
  ['Slides', `RV slide-out repair at your campsite, storage lot or driveway. When a slide won’t move, moves slowly or goes in crooked, Mike comes to the RV so you don’t have to get it to a shop.

## Signs your slide-out needs attention
- It won’t extend or retract, or it stops partway
- It moves slowly, jerks, or grinds or clicks
- One end moves ahead of the other, so it goes in crooked
- Seals are torn or dragging, or water gets in around the room
- You hear the motor run but the room doesn’t move

## What Mike checks and fixes on site
Most slide problems come down to power, the motor, the drive (cables, gears or hydraulics), alignment or the seals. Mike starts with the battery and wiring, because low voltage stops a lot of slides. Then he checks the motor and controller, the gears, cables or rams and their fluid, and the wipers and seals, and adjusts or replaces what has failed.

## Need to leave?
Tell Mike when you call. The first job is getting the room in safely so you can travel.`],

  ['Awnings', `RV awning repair where your rig is parked: awnings that won’t open or close, power awnings that quit, and fabric torn by Utah wind.

## Signs your awning needs attention
- A power awning won’t extend or retract, or stops partway
- It creeps open while you drive, or won’t stay closed
- The fabric is torn, sagging or pulling off the roller
- An arm is bent, or the awning won’t sit square
- You need to pack up and the awning is stuck out

## What Mike checks and fixes on site
Mike checks power, the switch and motor, and the controls, then repairs or replaces the motor, arms, hardware or fabric. In wind, he secures a stuck awning first so it can’t do more damage.`],

  ['Leveling systems', `RV leveling jack repair on site: jacks stuck down, systems that won’t level the coach, and warning lights on the panel.

## Signs your leveling system needs attention
- A jack won’t retract, so you can’t drive away
- The system won’t level, or levels and then drifts
- Error codes or warning lights on the control panel
- Hydraulic fluid leaking, or the pump runs but the jacks don’t move
- A jack is noisy or moves unevenly

## What Mike checks and fixes on site
Mike checks battery voltage and connections, the control panel and sensors, the pump and fluid level, hoses and fittings, and the jacks themselves. A jack stuck down comes first: he gets it up so you can move.`],

  ['Black and grey tanks', `RV black and grey tank service where you’re camped or stored: slow drains, backups, odors, stuck valves and tank monitors that read wrong.

## Signs your tanks need attention
- Sinks or the shower drain slowly or back up
- A sewer smell inside the RV
- A dump valve that’s stuck, hard to pull or leaking
- The tank monitor reads full when the tank is empty, or the other way around
- Leaks under the RV near the tanks or drain lines

## What Mike checks and fixes on site
Mike finds where it’s blocked or leaking, frees or replaces stuck valves, clears and flushes lines and tanks, and checks the vents, since a blocked vent causes odors and slow drains. He cleans or replaces tank sensors that read wrong. His free black and grey tank spot check, in the checklists on this site, helps you describe the problem when you call.`],

  ['Plumbing', `RV plumbing repair at your campsite, storage lot or driveway: leaks, burst lines and freeze damage, water pumps, water heaters, faucets and fittings.

## Signs your plumbing needs attention
- Water under a sink, behind a panel or under the floor
- The water pump cycles on and off by itself, or won’t run
- No water, low pressure, or air in the lines
- Cracked lines or fittings after a cold night
- No hot water, or a leaking water heater

## What Mike checks and fixes on site
Mike traces a leak to where it starts, repairs or replaces lines and fittings, fixes or replaces water pumps, and repairs water heaters. Before he leaves, he runs the water and checks his work for leaks.

## Utah freeze damage
Cold nights on the Wasatch Front, and earlier ones in Park City, Heber and Ogden Valley, crack lines that weren’t winterized. Mike finds and repairs freeze damage, and his winterizing package helps prevent it.`],

  ['Air conditioning and heating', `RV air conditioner and furnace repair where your RV is parked: AC units, furnaces and heat pumps that won’t turn on, cool or heat.

## Signs your AC or furnace needs attention
- The AC runs but doesn’t cool, or won’t turn on
- The furnace fan runs but there’s no heat, or it clicks and won’t light
- The thermostat is blank or doesn’t respond
- A breaker trips, or the unit hums, rattles or smells hot
- A heat pump won’t switch between heating and cooling

## What Mike checks and fixes on site
Mike checks power and the thermostat first. On an air conditioner he checks the control board, capacitors and fan motor; on a furnace, the igniter, switches, gas supply and blower. Then he repairs or replaces the part that failed.

## Safety first
If you smell propane or a carbon monoxide alarm goes off, get everyone out, turn off the propane at the tank, and call 911 before you call Mike.`],

  ['Electrical', `RV and trailer electrical repair on site: dead house batteries, converters, fuses and breakers, running lights, turn signals and 7-pin plugs.

## Signs of an electrical problem
- Lights and outlets are dead or dim, or the battery won’t hold a charge
- Things work on shore power but not on battery, or the other way around
- Fuses that keep blowing or breakers that keep tripping
- Trailer lights or turn signals out, or working on one side only
- A damaged or corroded 7-pin plug or wiring

## What Mike checks and fixes on site
Mike tests the batteries, the converter or charger, fuses, breakers, the transfer switch and the grounds, then traces and repairs the wiring. On trailers he repairs lights, brake wiring and 7-pin plugs and connectors.`],

  ['Roadside breakdowns', `Mobile roadside help for RVs and trailers across Northern Utah: flat tires and blowouts, hot wheel bearings and hubs, electric brakes, breakaway switches, couplers and safety chains.

## When to call Mike
- A blowout or flat on an RV or trailer
- A hub that’s smoking or too hot to touch, or a wheel that wobbles
- Trailer brakes that drag, lock up or don’t work
- Trouble with a breakaway switch, coupler, tongue jack or safety chains
- You’ve stopped on I-15, I-80 or I-84 and aren’t sure it’s safe to keep going

## First, get safe
Pull as far off the road as you can, turn on your hazard lights and stay out of traffic. If anyone is hurt or you’re stopped somewhere dangerous, call 911 first. Then call Mike with your location: the mile marker, the nearest exit, or a pin from your phone.

## What Mike does
Mike comes to the shoulder, the nearest exit or a truck stop. He changes tires, services or replaces wheel bearings and hubs, repairs electric brakes and wiring, and fixes couplers, jacks and safety chains. If it can’t be fixed safely where you are, he tells you and helps you plan a tow.`],

  ['Roof and storm damage', `RV roof and storm damage repair where your RV is parked: wind and hail damage sealed up so you can get home dry.

## Signs of roof or storm damage
- Water stains on the ceiling or walls, or soft spots
- Cracked, lifted or missing sealant around vents, skylights or the AC
- A torn roof membrane, or hail dents and cracks
- A vent cover or skylight broken by wind or a branch
- Leaks that show up only when it rains or snow melts

## What Mike checks and fixes on site
Mike inspects the roof, finds where water is getting in and seals it up: resealing seams and fixtures, patching tears and replacing broken vent covers. If the roof needs replacing or a structural repair, he tells you on the spot and helps you plan the next step.`],
].map(([name, body]) => [name, `${body}\n\n${COST}\n\n${SEND}\n\n${AREA}`]);

// Run as a script (not when a test imports the drafts).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  if (has('--print')) {
    for (const [name, text] of SERVICE_PAGES) console.log(`==== ${name} (/services/${slugify(name)}) ====\n\n${text}\n`);
    process.exit(0);
  }
  const db = openDb(path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')));
  const slug = args.find((a) => !a.startsWith('--'))
    || (db.prepare(`SELECT 1 FROM tenants WHERE slug = 'rsqu-mobile-rv-service'`).get() ? 'rsqu-mobile-rv-service' : 'mike-stevens');
  const t = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  if (!t) { console.error(`No business with the address "${slug}".`); process.exit(1); }
  const added = [], kept = [], missing = [];
  for (const [name, text] of SERVICE_PAGES) {
    const p = db.prepare('SELECT * FROM products WHERE tenant_id = ? AND lower(name) = lower(?)').get(t.id, name);
    if (!p) { missing.push(name); continue; }
    if (String(p.details || '').trim() && !has('--force')) { kept.push(name); continue; }
    if (!has('--dry-run')) db.prepare('UPDATE products SET details = ?, on_site = 1, active = 1 WHERE id = ?').run(text, p.id);
    added.push(name);
  }
  const say = [];
  if (added.length) say.push(`${has('--dry-run') ? 'Would add' : 'Added'} pages for ${added.length} services: ${added.join(', ')}.`);
  if (kept.length) say.push(`Kept ${kept.length} that already had a page: ${kept.join(', ')}.`);
  if (missing.length) say.push(`Not in the price list, skipped: ${missing.join(', ')}.`);
  if (!added.length && !kept.length) say.push('Nothing changed.');
  if (added.length && !has('--dry-run')) say.push(`See them at /s/${slug}/services/${slugify(added[0])} and the other service links on the site.`);
  console.log(say.join(' '));
}
