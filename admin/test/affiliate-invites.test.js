// Affiliate invitations, electronic W-9s, payout details, encryption at rest, and the database upgrade
// that lets affiliates be people or groups (not only businesses).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { openDb, rebuildTable } from '../src/db.js';
import { sealer } from '../src/sealed.js';
import * as W9 from '../src/w9.js';

const KEY = 'test-encryption-key-' + 'k'.repeat(40);
// Test numbers only: an SSN from the range the SSA reserves for advertising (987-65-4320 to 4329),
// a made-up EIN, and the Federal Reserve Bank of Boston's public routing number.
const SSN = '987-65-4321', EIN = '12-3456789', ROUTING = '011000015', ACCOUNT = '000123456789';
const apps = [];
after(() => { for (const a of apps) { a.server.close(); fs.rmSync(a.dir, { recursive: true, force: true }); } });

async function start(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-inv-'));
  const app = createApp({ DATA_DIR: dir, SUPER_ADMIN_EMAIL: 'admin@agilities.test', SUPER_ADMIN_PASSWORD: 'super-secret-pw', NOTIFY_CAPTURE: '1', DISABLE_WORKER: '1', ...extra });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie');
      if (sc && sc.startsWith('sid=')) cookie = sc.split(';')[0];
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, json, text, headers: res.headers };
    };
    call.setCookie = (c) => { cookie = c; };
    return call;
  };
  const a = { dir, server, base, db: app.db, outbox: app.outbox, client };
  apps.push(a);
  a.admin = client();
  assert.equal((await a.admin('POST', '/api/login', { email: 'admin@agilities.test', password: 'super-secret-pw' })).status, 200);
  return a;
}
// A business with an owner who has set a password and accepted the agreements.
async function business(a, name, email) {
  const made = await a.admin('POST', '/api/super/tenants', { business_name: name, owner_name: 'Owner', owner_email: email, phone: '801-555-0100' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const owner = a.client();
  await owner('POST', '/api/password/reset', { token: made.json.setup_link.split('/reset/')[1], password: 'owner-password-1' });
  assert.equal((await owner('POST', '/api/login', { email, password: 'owner-password-1' })).status, 200);
  await owner('POST', '/api/agreements/accept', { agree: true });
  return { id: made.json.tenant.id, owner };
}
const tokenFrom = (link) => link.split('#/join/')[1];
const lookup = (who, token, extra = {}) => who('POST', '/api/public/affiliate-invites/lookup', { token, ...extra });
const accept = (who, token, body) => who('POST', '/api/public/affiliate-invites/accept', { token, ...body });
const MAC = sealer(KEY).fingerprint;
const w9 = (over = {}) => ({ legal_name: 'Pat Example', business_name: '', tax_class: 'individual', address: '100 Main St', city: 'Morgan', state: 'UT', zip: '84050', tin_type: 'ssn', tin: SSN, tin_confirm: SSN, signature: 'Pat Example', certify: true, ...over });
const ach = (over = {}) => ({ method: 'ach', authorize: true, bank: { holder: 'Pat Example', routing: ROUTING, account: ACCOUNT, account_confirm: ACCOUNT, type: 'checking', ...over } });

test('sealed values: round trip, bound to what they are and to the key', () => {
  assert.equal(sealer(''), null);
  assert.equal(sealer('too-short'), null, 'a short key is refused');
  const s = sealer(KEY);
  const box = s.seal('987654321', 'w9-tin:1');
  assert.match(box, /^v1\.[\w-]+$/);
  assert.ok(!box.includes('987654321'));
  assert.notEqual(s.seal('987654321', 'w9-tin:1'), box, 'a fresh IV every time');
  assert.equal(s.open(box, 'w9-tin:1'), '987654321');
  assert.throws(() => s.open(box, 'w9-tin:2'), 'another affiliate’s context can’t open it');
  assert.throws(() => sealer(KEY + 'x').open(box, 'w9-tin:1'), 'another key can’t open it');
  const raw = Buffer.from(box.slice(3), 'base64url'); raw[raw.length - 1] ^= 1;
  assert.throws(() => s.open('v1.' + raw.toString('base64url'), 'w9-tin:1'), 'a changed value is caught');
  const full = Buffer.from(box.slice(3), 'base64url');
  const shortTag = Buffer.concat([full.subarray(0, 16), full.subarray(28)]); // a 4-byte tag
  assert.throws(() => s.open('v1.' + shortTag.toString('base64url'), 'w9-tin:1'), 'a shortened tag is refused');
});

test('W-9 checks: the form’s rules, field by field', () => {
  const ok = W9.checkW9(w9());
  assert.equal(ok.tin, '987654321');
  assert.equal(ok.zip, '84050');
  const field = (over) => { try { W9.checkW9(w9(over)); return null; } catch (e) { return e.field; } };
  assert.equal(field({ legal_name: '' }), 'legal_name');
  assert.equal(field({ tax_class: '' }), 'tax_class');
  assert.equal(field({ tax_class: 'llc' }), 'llc_class');
  assert.equal(field({ tax_class: 'other' }), 'other_class');
  assert.equal(field({ tax_class: 'c_corp' }), 'tin_type', 'a corporation gives an EIN');
  assert.equal(field({ tax_class: 'llc', llc_class: 'S', tin_type: 'ein', tin: EIN, tin_confirm: EIN }), null);
  assert.equal(field({ tin: '000-12-3456', tin_confirm: '000-12-3456' }), 'tin');
  assert.equal(field({ tin: '123-45-678', tin_confirm: '123-45-678' }), 'tin');
  assert.equal(field({ tin: '900-12-3456', tin_confirm: '900-12-3456' }), 'tin', 'not a valid ITIN range');
  assert.equal(field({ tin_confirm: '987-65-4320' }), 'tin_confirm');
  assert.equal(field({ state: 'ZZ' }), 'state');
  assert.equal(field({ zip: '8405' }), 'zip');
  assert.equal(field({ exempt_payee_code: '14' }), 'exempt_payee_code');
  assert.equal(field({ fatca_code: 'Z' }), 'fatca_code');
  assert.equal(field({ signature: '' }), 'signature');
  assert.equal(field({ certify: false }), 'certify');
  assert.equal(W9.checkW9(w9({ foreign_owners: true })).foreign_owners, 0, 'line 3b only applies to flow-through entities');
  assert.equal(W9.checkW9(w9({ tax_class: 'partnership', foreign_owners: true, tin_type: 'ein', tin: EIN, tin_confirm: EIN })).foreign_owners, 1);
  assert.ok(W9.routingOk(ROUTING));
  assert.ok(!W9.routingOk('011000016'), 'a wrong check digit');
  assert.throws(() => W9.checkBank({ holder: 'Pat', routing: ROUTING, account: ACCOUNT, account_confirm: '000123456780' }), /don’t match/);
  assert.equal(W9.maskedTin('ssn', '4321'), 'SSN •••-••-4321');
  assert.equal(W9.recordHash(ok, '2026-11-03 10:00:00', MAC), W9.recordHash({ ...ok }, '2026-11-03 10:00:00', MAC));
  assert.notEqual(W9.recordHash(ok, '2026-11-03 10:00:00', MAC), W9.recordHash({ ...ok, tin: '987654320' }, '2026-11-03 10:00:00', MAC));
  assert.notEqual(W9.recordHash(ok, '2026-11-03 10:00:00', MAC), W9.recordHash(ok, '2026-11-03 10:00:00', sealer(KEY + 'x').fingerprint), 'keyed: no key, no fingerprint');
});

test('database upgrade: older users and affiliates tables are rebuilt without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-mig-'));
  try {
    let db = openDb(dir);
    // Put the tables back the way they were before people could be affiliates.
    rebuildTable(db, 'users', (sql) => sql.replace(",'affiliate'", ''));
    rebuildTable(db, 'affiliates', (sql) => sql.replace(/tenant_id INTEGER UNIQUE/, 'tenant_id INTEGER NOT NULL UNIQUE'));
    assert.doesNotMatch(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get().sql, /'affiliate'/);
    const t = Number(db.prepare(`INSERT INTO tenants (slug, name) VALUES ('rsqu', 'RSQU')`).run().lastInsertRowid);
    const u = Number(db.prepare(`INSERT INTO users (tenant_id, email, password_hash, role, cal_token) VALUES (?, 'o@x.test', 'x', 'owner', 'cal-1')`).run(t).lastInsertRowid);
    db.prepare(`INSERT INTO agreements (user_id, tenant_id, doc, version) VALUES (?, ?, 'terms', 'v')`).run(u, t);
    const aff = Number(db.prepare(`INSERT INTO affiliates (tenant_id, code, share_bp) VALUES (?, 'rsqu', 2500)`).run(t).lastInsertRowid);
    const t2 = Number(db.prepare(`INSERT INTO tenants (slug, name, referred_by_affiliate_id) VALUES ('b2', 'B2', ?)`).run(aff).lastInsertRowid);
    const pay = Number(db.prepare(`INSERT INTO affiliate_payouts (affiliate_id, amount_cents, method, paid_at, created_by) VALUES (?, 100, 'ach', '2026-11-01', ?)`).run(aff, u).lastInsertRowid);
    db.prepare(`INSERT INTO affiliate_ledger (affiliate_id, tenant_id, type, amount_cents, status, payout_id) VALUES (?, ?, 'payout', -100, 'paid', ?)`).run(aff, t2, pay);
    db.close();

    db = openDb(dir); // runs the migrations
    assert.match(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get().sql, /'affiliate'/);
    assert.equal(db.prepare('PRAGMA table_info(affiliates)').all().find((c) => c.name === 'tenant_id').notnull, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(u).email, 'o@x.test');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agreements WHERE user_id = ?').get(u).n, 1);
    assert.equal(db.prepare('SELECT referred_by_affiliate_id AS r FROM tenants WHERE id = ?').get(t2).r, aff);
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'users_cal_token'`).get(), 'indexes come back');
    assert.throws(() => db.prepare(`INSERT INTO users (email, password_hash, role, cal_token) VALUES ('dup@x.test', 'x', 'staff', 'cal-1')`).run(), /UNIQUE/);
    assert.throws(() => db.prepare('DELETE FROM affiliate_ledger').run(), /append-only/, 'the ledger’s triggers still work');
    db.prepare(`INSERT INTO users (email, password_hash, role) VALUES ('p@x.test', 'x', 'affiliate')`).run();
    db.prepare(`INSERT INTO affiliates (code, share_bp, name) VALUES ('person', 2500, 'A person')`).run();
    db.close();
    db = openDb(dir); // and again: nothing to do
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without DATA_ENCRYPTION_KEY, invitations, W-9s and bank details are off', async () => {
  const a = await start();
  const list = (await a.admin('GET', '/api/super/affiliates')).json;
  assert.equal(list.tax_ready, false);
  const r = await a.admin('POST', '/api/super/affiliate-invites', { email: 'pat@example.test', share_bp: 2500, months: '12' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /DATA_ENCRYPTION_KEY/);
});

test('invitation: a person joins with a W-9 and direct deposit, gets a tracked link, and can’t reuse it', async () => {
  const a = await start({ DATA_ENCRYPTION_KEY: KEY });
  const { admin } = a;
  const list = (await admin('GET', '/api/super/affiliates')).json;
  assert.deepEqual([list.tax_ready, list.invites], [true, []]);

  // Bad input is refused field by field.
  assert.equal((await admin('POST', '/api/super/affiliate-invites', { email: 'nope', share_bp: 2500 })).json.field, 'email');
  assert.equal((await admin('POST', '/api/super/affiliate-invites', { email: 'pat@example.test', share_bp: 20000 })).json.field, 'share');
  assert.equal((await admin('POST', '/api/super/affiliate-invites', { email: 'admin@agilities.test', share_bp: 2500 })).status, 409, 'not an admin login');
  const anon = a.client();
  assert.equal((await anon('POST', '/api/super/affiliate-invites', { email: 'x@y.test', share_bp: 2500 })).status, 401);

  const inv = await admin('POST', '/api/super/affiliate-invites', { email: 'Pat@Example.test', share_bp: 2500, months: '12' });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  assert.equal(inv.json.emailed, true);
  assert.equal(inv.json.invite.email, 'pat@example.test');
  const mail = a.outbox.find((m) => m.to === 'pat@example.test');
  assert.match(mail.subject, /invited to the HitchPoint referral program/);
  assert.ok(mail.text.includes(inv.json.link), 'the email carries the link');
  assert.match(mail.text, /25% of the fee/);
  let token = tokenFrom(inv.json.link);
  assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM affiliate_invites WHERE token_hash = ?').get(token).n, 0, 'only a hash of the token is stored');

  // Resending makes a new link; the old one stops working.
  const again = await admin('POST', `/api/super/affiliate-invites/${inv.json.invite.id}/resend`);
  assert.equal(again.status, 200);
  assert.equal((await lookup(anon, token)).status, 404);
  token = tokenFrom(again.json.link);

  const page = await lookup(anon, token);
  assert.equal(page.status, 200);
  assert.deepEqual([page.json.email, page.json.share_bp, page.json.months, page.json.account, page.json.suggested_code, page.json.tax_ready], ['pat@example.test', 2500, 12, 'new', 'pat', true]);
  assert.deepEqual((await lookup(anon, token, { code: 'No Way' })).json.code_check.ok, false);
  assert.equal((await lookup(anon, token, { code: 'fresh-name' })).json.code_check.ok, true);
  assert.equal((await anon('GET', `/api/public/affiliate-invites/${token}`)).status, 404, 'no token in URLs');
  const form = (await anon('GET', '/api/public/w9-form')).json;
  assert.equal(form.revision, 'Rev. March 2024');
  assert.equal(form.certification.items.length, 4);

  // Mistakes come back pointing at the field.
  const join = (body) => accept(anon, token, { name: 'Pat Example', phone: '801-555-0199', audience: 'Utah RV owners group', code: 'utah-rv-club', password: 'pat-password-1', agree: true, w9: w9(), payout: ach(), ...body });
  assert.equal((await join({ password: 'short' })).json.field, 'password');
  assert.equal((await join({ code: 'X!' })).json.field, 'code');
  assert.equal((await join({ w9: w9({ tin: '000-00-0000', tin_confirm: '000-00-0000' }) })).json.field, 'tin');
  assert.equal((await join({ payout: ach({ routing: '123456789' }) })).json.field, 'routing');
  assert.equal((await join({ payout: {} })).json.field, 'payout_method');
  assert.equal((await join({ payout: { ...ach(), authorize: false } })).json.field, 'authorize', 'direct deposit needs the authorization');
  assert.equal((await join({ agree: false })).json.field, 'agree');
  assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM affiliates').get().n, 0, 'nothing saved on a mistake');

  const pat = a.client();
  const joined = await accept(pat, token, { name: 'Pat Example', phone: '801-555-0199', audience: 'Utah RV owners group', code: 'utah-rv-club', password: 'pat-password-1', agree: true, w9: w9(), payout: ach() });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  assert.match(joined.json.link, /\/a\/utah-rv-club$/);
  assert.equal((await accept(anon, token, { password: 'x' })).status, 404, 'the link works once');
  assert.ok(a.outbox.some((m) => m.to === 'pat@example.test' && /Your HitchPoint referral link/.test(m.subject)));
  assert.ok(a.outbox.some((m) => /New affiliate: Pat Example/.test(m.subject)));

  // What Pat agreed to is on record: the terms, the privacy policy, and the direct deposit authorization.
  const patId = a.db.prepare(`SELECT id FROM users WHERE email = 'pat@example.test'`).get().id;
  assert.deepEqual(a.db.prepare('SELECT doc, version FROM agreements WHERE user_id = ? ORDER BY id').all(patId).map((x) => `${x.doc}@${x.version}`),
    ['affiliate-terms@2026-11-03.2', 'privacy@2026-11-03.2', 'ach-authorization@2026-11-03:x6789']);
  // Pat is logged in as a referral partner, not a business.
  const me = (await pat('GET', '/api/me')).json;
  assert.deepEqual([me.user.role, me.tenant, me.needs_agreements], ['affiliate', null, false]);
  assert.equal((await pat('GET', '/api/requests')).status, 403, 'no business pages');
  assert.equal((await pat('GET', '/api/super/affiliates')).status, 403);
  const mine = (await pat('GET', '/api/affiliate')).json;
  assert.equal(mine.affiliate.kind, 'person');
  assert.equal(mine.affiliate.name, 'Pat Example');
  assert.equal(mine.affiliate.share_bp, 2500);
  assert.equal(mine.affiliate.months, 12);
  assert.match(mine.affiliate.link, /\/a\/utah-rv-club$/);
  assert.deepEqual(mine.affiliate.tax.w9.tin, 'SSN •••-••-4321');
  assert.deepEqual(mine.affiliate.tax.payout, { method: 'ach', last4: '6789', updated_at: mine.affiliate.tax.payout.updated_at });
  assert.ok(!JSON.stringify(mine).includes('987654321') && !JSON.stringify(mine).includes(ACCOUNT), 'never the full numbers');
  // Logging out and back in works like any login.
  assert.equal((await a.client()('POST', '/api/login', { email: 'pat@example.test', password: 'pat-password-1' })).status, 200);

  // Stored encrypted: the database file never holds the numbers in the clear.
  const row = a.db.prepare('SELECT * FROM affiliate_w9').get();
  assert.ok(!row.tin_sealed.includes('987654321'));
  assert.equal(row.tin_last4, '4321');
  assert.equal(row.signer_email, 'pat@example.test');
  assert.equal(row.record_sha256, W9.recordHash(W9.checkW9(w9()), row.signed_at, MAC));
  a.db.exec('PRAGMA wal_checkpoint(FULL)');
  const file = fs.readFileSync(path.join(a.dir, 'rsqu.db')).toString('latin1');
  assert.ok(!file.includes('987654321') && !file.includes(ACCOUNT), 'no plain tax ID or account number on disk');
  assert.throws(() => a.db.prepare('UPDATE affiliate_w9 SET legal_name = ?').run('x'), /append-only/);
  assert.throws(() => a.db.prepare('DELETE FROM affiliate_w9').run(), /append-only/);

  // The link credits sign-ups, and Pat can't refer themself.
  const click = await anon('GET', '/a/utah-rv-club', null, { 'X-Forwarded-For': '198.51.100.30' });
  assert.equal(click.status, 302);
  const cookie = click.headers.get('set-cookie').split(';')[0];
  const shop = a.client();
  assert.equal((await shop('POST', '/api/signup', { business_name: 'Bear Lake RV', name: 'Bo', email: 'bo@bearlake.test', phone: '435-555-0101', password: 'long-enough-pw', agree: true }, { Cookie: cookie, 'X-Forwarded-For': '198.51.100.31' })).status, 201);
  const affId = a.db.prepare(`SELECT id FROM affiliates WHERE code = 'utah-rv-club'`).get().id;
  assert.equal(a.db.prepare(`SELECT referred_by_affiliate_id AS r FROM tenants WHERE name = 'Bear Lake RV'`).get().r, affId);
  const selfShop = a.client();
  assert.equal((await selfShop('POST', '/api/signup', { business_name: 'Pat’s Shop', name: 'Pat', email: 'shop@else.test', phone: '801-555-0199', password: 'long-enough-pw', agree: true, referral_code: 'utah-rv-club' }, { 'X-Forwarded-For': '198.51.100.32' })).status, 400, 'same phone as the affiliate');
  assert.deepEqual((await pat('GET', '/api/affiliate')).json.referrals.map((x) => x.name), ['Bear Lake RV']);
  assert.equal((await anon('GET', '/api/public/referral?code=utah-rv-club')).json.name, 'Pat Example');

  // The admin sees it all on the dashboard.
  const all = (await admin('GET', '/api/super/affiliates')).json;
  assert.deepEqual(all.invites.map((i) => [i.email, i.status, i.affiliate_id]), [['pat@example.test', 'accepted', affId]]);
  const row2 = all.affiliates.find((x) => x.id === affId);
  assert.deepEqual([row2.kind, row2.name, row2.email, row2.w9, row2.payout_method, row2.referrals], ['person', 'Pat Example', 'pat@example.test', 'electronic', 'ach', 1]);
  const det = (await admin('GET', `/api/super/affiliates/${affId}`)).json;
  assert.equal(det.affiliate.audience, 'Utah RV owners group');
  assert.equal(det.tax.w9.tin, 'SSN •••-••-4321');
  assert.ok(!JSON.stringify(det).includes('987654321'));
  assert.equal(det.payout_block.includes('W-9'), false, 'the W-9 counts as on file');
  // Inviting the same email again is refused.
  assert.equal((await admin('POST', '/api/super/affiliate-invites', { email: 'pat@example.test', share_bp: 2500 })).status, 409);
});

test('invitation for a business owner: they confirm with their own password, and the business becomes the affiliate', async () => {
  const a = await start({ DATA_ENCRYPTION_KEY: KEY });
  const { id: tid, owner } = await business(a, 'RSQU Mobile RV Service', 'mike@rsqu.test');
  const inv = await a.admin('POST', '/api/super/affiliate-invites', { email: 'mike@rsqu.test', share_bp: 2500, months: '12' });
  assert.equal(inv.status, 201);
  const token = tokenFrom(inv.json.link);
  const anon = a.client();
  const page = (await lookup(anon, token)).json;
  assert.deepEqual([page.account, page.business_name, page.suggested_code], ['business', 'RSQU Mobile RV Service', 'rsqu-mobile-rv-service']);
  const body = { audience: 'Techs I know', code: 'rsqu', agree: true, w9: w9({ legal_name: 'Mike Example', business_name: 'RSQU Mobile RV Service', tax_class: 'llc', llc_class: 'S', tin_type: 'ein', tin: EIN, tin_confirm: EIN, signature: 'Mike Example' }), payout: { method: 'check' } };
  const wrong = await accept(anon, token, { ...body, password: 'not-my-password' });
  assert.deepEqual([wrong.status, wrong.json.field], [400, 'password']);
  const ok = await accept(anon, token, { ...body, password: 'owner-password-1' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const aff = a.db.prepare(`SELECT * FROM affiliates WHERE code = 'rsqu'`).get();
  assert.deepEqual([aff.tenant_id, aff.user_id, aff.share_bp, aff.months, aff.payout_method, aff.payout_sealed], [tid, null, 2500, 12, 'check', null]);
  const page2 = (await owner('GET', '/api/affiliate')).json;
  assert.deepEqual([page2.affiliate.kind, page2.affiliate.name, page2.affiliate.tax.w9.tin, page2.affiliate.tax.w9.classification], ['business', 'RSQU Mobile RV Service', 'EIN ••-•••6789', 'LLC, taxed as S corporation']);
  assert.equal(a.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'mike@rsqu.test'`).get().n, 1, 'no second login');
  // Now that the business is an affiliate, another invitation is refused with a pointer.
  const again = await a.admin('POST', '/api/super/affiliate-invites', { email: 'mike@rsqu.test', share_bp: 2500 });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /already an affiliate/);
});

test('the affiliate updates its W-9 and payout details (password needed); admin views are logged; 1099 export', async () => {
  const a = await start({ DATA_ENCRYPTION_KEY: KEY });
  const inv = await a.admin('POST', '/api/super/affiliate-invites', { email: 'lee@example.test', share_bp: 2000, months: '' });
  const lee = a.client();
  const joined = await accept(lee, tokenFrom(inv.json.link), { name: 'Lee’s RV Club', code: 'lees-club', password: 'lee-password-1', agree: true, w9: w9({ legal_name: 'Lee Example', signature: 'Lee Example' }), payout: { method: 'check' } });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  const affId = a.db.prepare(`SELECT id FROM affiliates WHERE code = 'lees-club'`).get().id;

  // Payout details: the password is required, and the affiliate is emailed about the change.
  assert.deepEqual((await lee('POST', '/api/affiliate/payout', { password: 'wrong', payout: ach() })).json.field, 'password');
  assert.deepEqual((await lee('POST', '/api/affiliate/payout', { password: 'lee-password-1', payout: { ...ach(), authorize: false } })).json.field, 'authorize');
  const before = a.outbox.length;
  const changed = await lee('POST', '/api/affiliate/payout', { password: 'lee-password-1', payout: ach({ holder: 'Lee Example' }) });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.affiliate.tax.payout.last4, '6789');
  const notes = a.outbox.slice(before);
  assert.ok(notes.some((m) => m.to === 'lee@example.test' && /payout details changed/.test(m.subject) && /ending in 6789/.test(m.text)));
  assert.ok(notes.some((m) => /changed payout details/.test(m.subject)));
  const w9Mails = () => a.outbox.filter((m) => m.to === 'lee@example.test' && /new W-9/.test(m.subject)).length;
  const w9Before = w9Mails();

  // A new W-9 is added; the newest one is used.
  const nw = await lee('POST', '/api/affiliate/w9', { password: 'lee-password-1', w9: w9({ legal_name: 'Lee Example', address: '200 New Rd', signature: 'Lee Example', backup_withholding: true }) });
  assert.equal(nw.status, 200, JSON.stringify(nw.json));
  assert.equal(nw.json.affiliate.tax.w9.backup_withholding, true);
  assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM affiliate_w9 WHERE affiliate_id = ?').get(affId).n, 2);
  assert.equal(w9Mails(), w9Before + 1, 'the affiliate is told about a new W-9');

  // The admin can't change an affiliate's own details while viewing, but can see them in full, and each view is logged.
  const det = (await a.admin('GET', `/api/super/affiliates/${affId}`)).json;
  assert.equal(det.w9_history.length, 2);
  assert.equal(det.affiliate.backup_withholding, true);
  const print = await a.admin('GET', `/api/super/affiliates/${affId}/w9`);
  assert.equal(print.status, 200);
  assert.match(print.headers.get('content-type'), /text\/html/);
  assert.equal(print.headers.get('cache-control'), 'no-store');
  assert.ok(print.text.includes('987-65-4321'), 'the full number on the hard copy');
  assert.ok(print.text.includes('200 New Rd') && print.text.includes('class="struck"'), 'the newest W-9, with item 2 crossed out');
  assert.ok(print.text.includes('Under penalties of perjury, I certify that:'));
  assert.ok(print.text.includes('Matches the values above.'), 'the record checks out');
  const older = await a.admin('GET', `/api/super/affiliates/${affId}/w9?w=${det.w9_history[1].id}`);
  assert.ok(older.text.includes('100 Main St'));
  const bank = await a.admin('POST', `/api/super/affiliates/${affId}/bank`);
  assert.deepEqual(bank.json, { holder: 'Lee Example', routing: ROUTING, account: ACCOUNT, type: 'checking', updated_at: bank.json.updated_at });
  assert.equal((await lee('GET', `/api/super/affiliates/${affId}/w9`)).status, 403);
  assert.equal((await lee('POST', `/api/super/affiliates/${affId}/bank`)).status, 403);
  const log = a.db.prepare('SELECT what, user_email FROM sensitive_access_log WHERE affiliate_id = ? ORDER BY id').all(affId).map((l) => `${l.what}:${l.user_email}`);
  assert.deepEqual(log, ['w9_submitted:lee@example.test', 'payout_changed:lee@example.test', 'payout_changed:lee@example.test', 'w9_submitted:lee@example.test', 'w9_viewed:admin@agilities.test', 'w9_viewed:admin@agilities.test', 'bank_viewed:admin@agilities.test']);

  // Asking an existing affiliate for details sends them to their account page.
  const ask = await a.admin('POST', `/api/super/affiliates/${affId}/request-details`);
  assert.deepEqual([ask.json.emailed, ask.json.to, ask.json.link.endsWith('/admin/#/account')], [true, 'lee@example.test', true]);

  // An adjustment, a payout, and the yearly export with the W-9 details (last 4 only).
  await a.admin('POST', `/api/super/affiliates/${affId}/adjustments`, { amount_cents: 5000, note: 'Welcome bonus' });
  const paid = await a.admin('POST', `/api/super/affiliates/${affId}/payouts`, { method: 'check', reference: 'Check 1001', amount_cents: 5000 });
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  const year = new Date().toISOString().slice(0, 4);
  const csv = (await a.admin('GET', `/api/super/affiliate-payouts.csv?year=${year}`)).text;
  assert.ok(csv.includes(`"${year}","Lee’s RV Club","Lee Example","","Individual/sole proprietor","SSN •••-••-4321","200 New Rd, Morgan, UT 84050","lee@example.test","lees-club","electronic (`));
  assert.ok(csv.includes('"yes","1","50.00","no"'), 'backup withholding flagged; under the 1099 threshold');
  assert.ok(!csv.includes('987654321') && !csv.includes('987-65-4321'));

  // Expired and canceled invitations don't work.
  const inv2 = await a.admin('POST', '/api/super/affiliate-invites', { email: 'sam@example.test', share_bp: 2000 });
  const t2 = tokenFrom(inv2.json.link);
  a.db.prepare(`UPDATE affiliate_invites SET expires_at = '2000-01-01 00:00:00' WHERE id = ?`).run(inv2.json.invite.id);
  assert.equal((await lookup(a.client(), t2)).status, 404);
  assert.equal((await a.admin('GET', '/api/super/affiliates')).json.invites.find((i) => i.email === 'sam@example.test').status, 'expired');
  const re = await a.admin('POST', `/api/super/affiliate-invites/${inv2.json.invite.id}/resend`);
  assert.equal((await lookup(a.client(), tokenFrom(re.json.link))).status, 200, 'resending revives it');
  assert.equal((await a.admin('POST', `/api/super/affiliate-invites/${inv2.json.invite.id}/cancel`)).status, 200);
  assert.equal((await lookup(a.client(), tokenFrom(re.json.link))).status, 404);
});
