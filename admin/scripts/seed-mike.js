// Creates Mike Stevens Emergency RV & Trailer Repair as a business on the platform.
// Usage: DATA_DIR=/data BASE_URL=https://your-dashboard node scripts/seed-mike.js mike@example.com
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { hashPassword, randomToken, sha256 } from '../src/auth.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const email = (process.argv[2] || '').toLowerCase();
if (!/^\S+@\S+\.\S+$/.test(email)) { console.error('Usage: node scripts/seed-mike.js mike@example.com'); process.exit(1); }
const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const db = openDb(dataDir);
if (db.prepare(`SELECT 1 FROM tenants WHERE slug = 'mike-stevens'`).get()) { console.error('Mike’s business already exists.'); process.exit(1); }
if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) { console.error('That email already has an account.'); process.exit(1); }

const t = db.prepare(`INSERT INTO tenants (slug, name, phone, email, notify_phone, tagline, hero_headline, about, service_area, primary_color, accent_color, website_url, deposit_cents, deposit_label, terms)
  VALUES ('mike-stevens', 'Mike Stevens Emergency RV & Trailer Repair', '801-232-4995', ?, '+18012324995', ?, ?, ?, ?, '#B0141C', '#F2CE6E', 'https://agilitiestech.github.io/RSQU/', 12900, 'Repair diagnosis and onsite review', ?)`).run(
  email,
  'Mobile emergency repair and onsite winterizing for RVs and trailers.',
  'Emergency RV and trailer repair from a 30-year Salt Lake City firefighter',
  'Mike Stevens has served 30 years as a firefighter in Salt Lake City, Utah. He has worked highway crashes, vehicle fires and rescues in every kind of weather, and he brings the same habits to every breakdown: scene safety first, a size-up before he rolls, and straight answers.',
  'South Salt Lake to North Ogden and the back side of the Wasatch (Park City, Heber Valley, Morgan and Ogden Valley)',
  'Work is done onsite as described above. Parts and labor not listed are quoted separately and only done with your approval. The $129 diagnosis deposit, if paid, is credited toward this job. Payment is due when the work is complete.');
const tid = Number(t.lastInsertRowid);

const photo = `t${tid}-brand-${randomToken(8)}.jpg`;
fs.copyFileSync(path.join(ROOT, 'seed', 'mike-stevens.jpg'), path.join(dataDir, 'uploads', photo));
db.prepare('UPDATE tenants SET owner_photo = ? WHERE id = ?').run(photo, tid);

const ins = db.prepare(`INSERT INTO products (tenant_id, name, description, price_cents, taxable, on_site, bookable) VALUES (?,?,?,?,0,?,?)`);
ins.run(tid, 'Onsite RV winterizing package', 'All 12 winterizing steps, RV antifreeze, labor and travel within the service area.', 49900, 1, 1);
ins.run(tid, 'Repair diagnosis and onsite review', 'Mike finds the problem and gives you a written quote. Credited toward the job if you go ahead.', 12900, 1, 0);

const u = db.prepare(`INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES (?, ?, 'Mike Stevens', ?, 'owner')`).run(tid, email, hashPassword(randomToken(24)));
const tok = randomToken(24);
db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(tok), Number(u.lastInsertRowid), Date.now() + 7 * 864e5);
const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
console.log(`Created. Send Mike this link to set his password (valid 7 days):\n${base}/admin/#/reset/${tok}`);
