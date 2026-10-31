import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---- fake Stripe: Express accounts, platform Checkout sessions, balance transactions, transfers ----
const sessions = new Map();
const accounts = new Map();
const transfers = [];
const stripeFee = (amt) => Math.round(amt * 0.029) + 30;
const stripeMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = new URLSearchParams(body);
    const ok = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const bad = (msg) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: msg } })); };
    if (req.headers['stripe-account']) return bad('platform model: no Stripe-Account header expected');
    let m;
    if (req.method === 'POST' && req.url === '/v1/accounts') {
      const id = 'acct_' + crypto.randomBytes(5).toString('hex');
      accounts.set(id, { id, type: p.get('type'), transfers_requested: p.get('capabilities[transfers][requested]'), payouts_enabled: false, details_submitted: false, capabilities: { transfers: 'inactive' } });
      return ok(accounts.get(id));
    }
    if (req.method === 'POST' && req.url === '/v1/account_links') return ok({ url: 'https://connect.stripe.test/setup/' + p.get('account') });
    if (req.method === 'POST' && (m = /^\/v1\/accounts\/(.+)\/login_links$/.exec(req.url))) return ok({ url: 'https://connect.stripe.test/express/' + m[1] });
    if (req.method === 'GET' && (m = /^\/v1\/accounts\/([^/?]+)$/.exec(req.url))) return ok(accounts.get(m[1]));
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      const id = 'cs_test_' + crypto.randomBytes(6).toString('hex');
      const lines = [];
      for (let i = 0; p.has(`line_items[${i}][price_data][unit_amount]`); i++) lines.push({ name: p.get(`line_items[${i}][price_data][product_data][name]`), amount: Number(p.get(`line_items[${i}][price_data][unit_amount]`)) });
      const s = { id, url: 'https://checkout.stripe.test/' + id, client_reference_id: p.get('client_reference_id'), lines, amount_total: lines.reduce((a, l) => a + l.amount, 0), application_fee: p.get('payment_intent_data[application_fee_amount]'), descriptor_suffix: p.get('payment_intent_data[statement_descriptor_suffix]'), payment_status: 'unpaid' };
      sessions.set(id, s);
      return ok(s);
    }
    if (req.method === 'GET' && (m = /^\/v1\/checkout\/sessions\/([^?]+)\?expand\[\]=payment_intent\.latest_charge\.balance_transaction$/.exec(req.url)) && sessions.has(m[1])) {
      const s = sessions.get(m[1]);
      const out = { ...s, payment_intent: s.payment_status === 'paid' ? { id: 'pi_' + s.id, latest_charge: { id: 'ch_' + s.id, balance_transaction: { id: 'txn_' + s.id, fee: stripeFee(s.amount_total) } } } : null };
      return ok(out);
    }
    if (req.method === 'POST' && req.url === '/v1/transfers') {
      const dest = accounts.get(p.get('destination'));
      if (!dest || dest.capabilities.transfers !== 'active') return bad('Destination account cannot receive transfers yet.');
      const key = req.headers['idempotency-key'];
      const prior = transfers.find((t) => t.key === key);
      if (prior) return ok(prior);
      const t = { id: 'tr_' + crypto.randomBytes(5).toString('hex'), key, amount: Number(p.get('amount')), destination: p.get('destination'), source_transaction: p.get('source_transaction') };
      transfers.push(t);
      return ok(t);
    }
    res.writeHead(404); res.end('{}');
  });
});

let server, base, dataDir;
const WHSEC = 'whsec_platform_test';

// Tiny cookie-jar client per user.
function client() {
  let cookie = '';
  return async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.startsWith('sid=')) cookie = sc.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers, text };
  };
}
const anon = client();
const superA = client();
const mike = client();
const other = client();

function webhook(evt) {
  const raw = JSON.stringify(evt);
  const t = Math.floor(Date.now() / 1000);
  return { raw, header: `t=${t},v1=${crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex')}` };
}

before(async () => {
  await new Promise((r) => stripeMock.listen(0, r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsqu-test-'));
  const { handler } = createApp({
    DATA_DIR: dataDir, SUPER_ADMIN_EMAIL: 'aaron@agilities.test', SUPER_ADMIN_PASSWORD: 'super-secret-pw',
    STRIPE_SECRET_KEY: 'sk_test_platform', STRIPE_API_BASE: `http://localhost:${stripeMock.address().port}`, STRIPE_WEBHOOK_SECRET: WHSEC,
  });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); stripeMock.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SIG = 'data:image/png;base64,' + 'A'.repeat(400);
let mikeId, mikeSlug;

test('super admin creates a business; owner sets password and must accept agreements', async () => {
  assert.equal((await superA('GET', '/api/super/overview')).status, 401);
  assert.equal((await superA('POST', '/api/login', { email: 'aaron@agilities.test', password: 'wrong' })).status, 401);
  assert.equal((await superA('POST', '/api/login', { email: 'aaron@agilities.test', password: 'super-secret-pw' })).status, 200);
  const created = await superA('POST', '/api/super/tenants', { business_name: 'Mike Stevens Emergency RV & Trailer Repair', owner_name: 'Mike', owner_email: 'mike@rv.test', phone: '801-232-4995' });
  assert.equal(created.status, 201);
  mikeId = created.json.tenant.id; mikeSlug = created.json.tenant.slug;
  assert.equal(mikeSlug, 'mike-stevens-emergency-rv-trailer-repair');
  const token = created.json.setup_link.split('/reset/')[1];

  assert.equal((await mike('POST', '/api/password/reset', { token, password: 'short' })).status, 400);
  assert.equal((await mike('POST', '/api/password/reset', { token, password: 'mikes-good-password' })).status, 200);
  assert.equal((await mike('POST', '/api/password/reset', { token, password: 'mikes-good-password' })).status, 400, 'reset links are single use');
  const me = (await mike('GET', '/api/me')).json;
  assert.equal(me.tenant.id, mikeId);
  assert.equal(me.needs_agreements, true);
  assert.equal((await mike('GET', '/api/requests')).status, 428);
  assert.equal((await mike('POST', '/api/agreements/accept', { agree: true })).status, 200);
  // Direct deposit is required before the dashboard opens.
  assert.equal((await mike('GET', '/api/me')).json.needs_payout_setup, true);
  assert.equal((await mike('GET', '/api/requests')).status, 428);
  const c = await mike('POST', '/api/stripe/connect');
  assert.match(c.json.url, /connect\.stripe\.test\/setup\/acct_/);
  const acct = c.json.url.split('/').pop();
  assert.equal(accounts.get(acct).type, 'express');
  assert.equal(accounts.get(acct).transfers_requested, 'true');
  accounts.get(acct).details_submitted = true; // owner finished Stripe's form; verification still pending
  assert.equal((await mike('POST', '/api/stripe/refresh')).json.details_submitted, true);
  assert.equal((await mike('GET', '/api/me')).json.needs_payout_setup, false);
  assert.equal((await mike('GET', '/api/requests')).status, 200);
  assert.equal((await mike('GET', '/api/super/overview')).status, 403, 'owners cannot reach super admin');

  // Set up Mike's business like the real one.
  await mike('PUT', '/api/settings', { deposit_cents: 12900, deposit_label: 'Repair diagnosis and onsite review' });
  await mike('POST', '/api/products', { name: 'Onsite RV winterizing package', price_cents: 49900, on_site: true, bookable: true });
  await mike('PUT', '/api/business', { phone: '801-232-4995', primary_color: '#B0141C', tagline: 'Mobile RV repair', service_area: 'South Salt Lake to North Ogden' });
  assert.equal((await mike('POST', '/api/business/image', { kind: 'owner_photo', image: PNG })).status, 200);
});

test('self sign-up records agreements; businesses cannot see each other', async () => {
  assert.equal((await other('POST', '/api/signup', { business_name: 'Other Co', name: 'Ola', email: 'ola@other.test', password: 'long-enough-pw', agree: false })).status, 400);
  const s = await other('POST', '/api/signup', { business_name: 'Other Co', name: 'Ola', email: 'ola@other.test', password: 'long-enough-pw', agree: true });
  assert.equal(s.status, 201);
  assert.equal((await other('GET', '/api/me')).json.needs_agreements, false);
  assert.equal((await other('GET', '/api/me')).json.needs_payout_setup, true);
  await other('POST', '/api/stripe/connect');
  for (const a of accounts.values()) a.details_submitted = true;
  await other('POST', '/api/stripe/refresh');
  assert.equal((await other('POST', '/api/signup', { business_name: 'X', name: 'Y', email: 'OLA@other.test', password: 'long-enough-pw', agree: true })).status, 409);

  const r = await anon('POST', `/api/public/t/${mikeSlug}/requests`, { type: 'repair', name: 'Dana', phone: '801-555-0100', location: 'I-15 mm 290', year: '2019', make: 'Jayco', issue: 'Blowout', photo: PNG }, { Origin: 'https://agilitiestech.github.io' });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const rid = r.json.id;
  const req = (await mike('GET', '/api/requests/' + rid)).json;
  assert.ok(req.photo.startsWith(`t${mikeId}-req-`));
  assert.equal((await mike('GET', '/api/uploads/' + req.photo)).status, 200);
  // Other business: no access to Mike's request, photo or quotes.
  assert.equal((await other('GET', '/api/requests/' + rid)).status, 404);
  assert.equal((await other('GET', '/api/uploads/' + req.photo)).status, 404);
  assert.equal((await other('GET', '/api/requests')).json.counts.all, 0);
  assert.equal((await other('POST', '/api/quotes', { request_id: rid })).json.request_id, null);
  assert.equal((await anon('GET', `/media/${mikeSlug}/${req.photo}`)).status, 404, 'request photos are never public');
});

test('deposit paid online: platform charge, then payout minus Stripe fee and 3%', async () => {
  const acct = [...accounts.values()][0].id;
  const rid = (await mike('GET', '/api/requests')).json.rows[0].id;
  const dep = await mike('POST', `/api/requests/${rid}/deposit`, { method: 'card' });
  const pub = (await anon('GET', `/api/public/payments/${dep.json.token}`)).json;
  assert.deepEqual([pub.online.fee, pub.online.charge, pub.online.card_payments], [0, 12900, true], 'customer pays only the amount due');
  const co = await anon('POST', `/api/public/payments/${dep.json.token}/checkout`, {});
  assert.ok(co.json.url);
  const sess = [...sessions.values()].find((s) => s.client_reference_id === dep.json.token);
  assert.deepEqual(sess.lines, [{ name: 'Repair diagnosis and onsite review (credited toward the job)', amount: 12900 }]);
  assert.equal(sess.application_fee, null);
  assert.equal(sess.descriptor_suffix, 'MIKE STEVENS EMERGENCY');

  // Paid while Stripe is still verifying the owner: transfer can't go yet.
  sess.payment_status = 'paid';
  const bad = webhook({ type: 'checkout.session.completed', data: { object: sess } });
  assert.equal((await anon('POST', '/api/stripe/webhook', bad.raw, { 'Stripe-Signature': 't=1,v1=bad', 'Content-Type': 'application/json' })).status, 400);
  const wh = webhook({ type: 'checkout.session.completed', data: { object: sess } });
  assert.equal((await anon('POST', '/api/stripe/webhook', wh.raw, { 'Stripe-Signature': wh.header, 'Content-Type': 'application/json' })).status, 200);
  let pay = (await superA('GET', `/api/super/tenants/${mikeId}`)).json.payments.find((p) => p.kind === 'deposit');
  assert.equal(pay.status, 'paid');
  assert.deepEqual([pay.stripe_fee_cents, pay.fee_cents, pay.payout_cents], [404, 387, 12109]); // 2.9%+30¢ = 4.04; 3% = 3.87
  assert.equal(pay.transfer_status, 'failed');
  assert.equal(transfers.length, 0);

  // Stripe finishes verification: account.updated triggers the held payout.
  Object.assign(accounts.get(acct), { payouts_enabled: true, capabilities: { transfers: 'active' } });
  const upd = webhook({ type: 'account.updated', account: acct, data: { object: accounts.get(acct) } });
  await anon('POST', '/api/stripe/webhook', upd.raw, { 'Stripe-Signature': upd.header, 'Content-Type': 'application/json' });
  pay = (await superA('GET', `/api/super/tenants/${mikeId}`)).json.payments.find((p) => p.kind === 'deposit');
  assert.equal(pay.transfer_status, 'sent');
  assert.equal(transfers.length, 1);
  assert.deepEqual([transfers[0].amount, transfers[0].destination, transfers[0].source_transaction], [12109, acct, 'ch_' + sess.id]);
  // Replayed webhook doesn't pay out twice.
  await anon('POST', '/api/stripe/webhook', wh.raw, { 'Stripe-Signature': wh.header, 'Content-Type': 'application/json' });
  assert.equal(transfers.length, 1);
  const mine = (await mike('GET', '/api/payments')).json.find((p) => p.method === 'card');
  assert.equal(mine.stripe_fee_cents + mine.fee_cents, 791);
});

test('quote: deposit credited, signed, paid online with Processing Fee on the balance', async () => {
  const rid = (await mike('GET', '/api/requests')).json.rows[0].id;
  const q = await mike('POST', '/api/quotes', { request_id: rid });
  assert.equal(q.json.deposit_credit_cents, 12900);
  const saved = await mike('PUT', '/api/quotes/' + q.json.id, { ...q.json, tax_rate_bp: 725, items: [{ name: 'Trailer tire', qty: 2, unit_cents: 18999, taxable: 1 }, { name: 'Labor', qty: 1.5, unit_cents: 12000 }] });
  assert.deepEqual(saved.json.totals, { subtotal: 55998, tax: 2755, total: 58753, credit: 12900, balance: 45853 });
  assert.equal(saved.json.online.fee, 0);
  const tok = saved.json.token;
  assert.equal((await other('GET', '/api/quotes/' + q.json.id)).status, 404);

  const pub = (await anon('GET', `/api/public/proposals/${tok}`)).json;
  assert.equal(pub.status, 'sent');
  assert.equal(pub.signer_ip, undefined);
  assert.equal(pub.business.phone, '801-232-4995');
  assert.equal((await anon('POST', `/api/public/proposals/${tok}/checkout`, {})).status, 409);
  assert.equal((await anon('POST', `/api/public/proposals/${tok}/sign`, { name: 'Dana', agree: true, signature: SIG })).status, 200);
  assert.equal((await mike('PUT', '/api/quotes/' + q.json.id, { items: [] })).status, 409);
  await anon('POST', `/api/public/proposals/${tok}/checkout`, {});
  const s = [...sessions.values()].find((x) => x.lines[0].amount === 45853);
  assert.deepEqual(s.lines.map((l) => l.name), [`Repair proposal (#${q.json.id})`]);
  assert.equal(s.amount_total, 45853);
  s.payment_status = 'paid';
  const pay = (await mike('GET', '/api/quotes/' + q.json.id)).json.payments.find((p) => p.status === 'pending');
  assert.equal((await anon('POST', `/api/public/payments/${pay.token}/confirm`, { session_id: s.id })).json.paid, true);
  const done = (await mike('GET', '/api/quotes/' + q.json.id)).json;
  assert.equal(done.status, 'paid');
  const p2 = done.payments.find((p) => p.status === 'paid');
  // Stripe: 2.9% of 458.53 = 13.30 + 0.30 = 13.60; platform 3% = 13.76; payout 458.53 - 27.36 = 431.17
  assert.deepEqual([p2.stripe_fee_cents, p2.fee_cents, p2.payout_cents, p2.transfer_status], [1360, 1376, 43117, 'sent']);
});

test('custom platform share, cash has no fee; super overview, CSV, leads', async () => {
  await superA('PATCH', `/api/super/tenants/${mikeId}`, { fee_bp: 200 });
  const book = await anon('POST', `/api/public/t/${mikeSlug}/requests`, { type: 'winterize', name: 'Lee', phone: '801-555-0101', location: 'Ogden', preferred_date: '2026-11-05' });
  const q = await mike('POST', '/api/quotes', { request_id: book.json.id });
  assert.equal(q.json.title, 'Onsite RV winterizing package');
  assert.equal(q.json.totals.balance, 49900);
  await anon('POST', `/api/public/proposals/${q.json.token}/sign`, { name: 'Lee', agree: true, signature: SIG });
  await anon('POST', `/api/public/proposals/${q.json.token}/checkout`, {});
  const s = [...sessions.values()].find((x) => x.lines[0].amount === 49900);
  s.payment_status = 'paid';
  const wh = webhook({ type: 'checkout.session.completed', data: { object: s } });
  await anon('POST', '/api/stripe/webhook', wh.raw, { 'Stripe-Signature': wh.header, 'Content-Type': 'application/json' });
  const p = (await mike('GET', '/api/quotes/' + q.json.id)).json.payments.find((x) => x.status === 'paid');
  assert.deepEqual([p.stripe_fee_cents, p.fee_cents, p.payout_cents], [1477, 998, 47425]); // 2% custom share
  await superA('PATCH', `/api/super/tenants/${mikeId}`, { fee_bp: null });

  // Cash: no Processing Fee, no transfer.
  const r2 = await mike('POST', '/api/requests', { name: 'Walk-up', phone: '1', location: 'Shop' });
  const q2 = await mike('POST', '/api/quotes', { request_id: r2.json.id });
  await mike('PUT', '/api/quotes/' + q2.json.id, { ...q2.json, items: [{ name: 'Fuse', qty: 1, unit_cents: 1500 }] });
  const cash = await mike('POST', `/api/quotes/${q2.json.id}/payments`, { method: 'cash' });
  const cp = cash.json.payments.find((x) => x.status === 'paid');
  assert.deepEqual([cp.fee_cents, cp.stripe_fee_cents, cp.transfer_status], [0, 0, null]);

  const o = (await superA('GET', '/api/super/overview')).json;
  assert.equal(o.totals.fee_cents, 387 + 1376 + 998);
  assert.equal(o.totals.stripe_fee_cents, 404 + 1360 + 1477);
  assert.equal(o.totals.payouts_waiting, 0);
  const csv = await superA('GET', '/api/super/fees.csv');
  assert.match(csv.text, /Processing Fee total/);
  assert.equal(csv.text.trim().split('\n').length, 4);
  assert.equal((await superA('GET', `/api/super/tenants/${mikeId}`)).json.agreements.length, 3);

  // Owner leads from the HitchPoint landing page.
  assert.equal((await anon('POST', '/api/public/leads', { name: 'Tech' })).status, 400);
  assert.equal((await anon('POST', '/api/public/leads', { name: 'Ray Tech', email: 'ray@tech.test', location: 'Boise, ID', certifications: 'RVTI Level 2' })).status, 201);
  const leads = (await superA('GET', '/api/super/leads')).json;
  assert.equal(leads[0].name, 'Ray Tech');
  assert.equal((await superA('PATCH', `/api/super/leads/${leads[0].id}`, { status: 'contacted' })).json.status, 'contacted');
  assert.equal((await mike('GET', '/api/super/leads')).status, 403);
  assert.equal((await superA('GET', '/api/super/overview')).json.leads_new, 0);
});

test('view-as, suspension, hosted website and custom domain', async () => {
  assert.equal((await superA('GET', '/api/requests')).status, 409);
  await superA('POST', '/api/super/view-as', { tenant_id: mikeId });
  assert.equal((await superA('GET', '/api/me')).json.viewing_as, true);
  assert.ok((await superA('GET', '/api/requests')).json.counts.all >= 2);
  await superA('POST', '/api/super/view-as', { tenant_id: 0 });

  const site = await anon('GET', `/s/${mikeSlug}`);
  assert.equal(site.status, 200);
  assert.match(site.text, /Onsite RV winterizing package/);
  assert.match(site.text, /South Salt Lake to North Ogden/);
  const photo = /\/media\/[\w-]+\/(t\d+-brand-[\w-]+\.png)/.exec(site.text);
  assert.ok(photo, 'owner photo on site');
  assert.equal((await anon('GET', photo[0])).status, 200);

  await mike('PUT', '/api/business', { custom_domain: 'https://www.mikesrv.test/' });
  const viaDomain = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: server.address().port, path: '/', headers: { Host: 'www.mikesrv.test' } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, text: b }));
    }).on('error', reject);
  });
  assert.equal(viaDomain.status, 200);
  assert.match(viaDomain.text, /Mike Stevens Emergency RV/);
  assert.equal((await other('PUT', '/api/business', { custom_domain: 'www.mikesrv.test' })).status, 409);

  await superA('PATCH', `/api/super/tenants/${mikeId}`, { status: 'suspended' });
  assert.equal((await mike('GET', '/api/requests')).status, 403);
  assert.equal((await anon('POST', `/api/public/t/${mikeSlug}/requests`, { phone: '1', location: 'x' })).status, 404);
  assert.equal((await anon('GET', `/s/${mikeSlug}`)).status, 404);
  await superA('PATCH', `/api/super/tenants/${mikeId}`, { status: 'active' });
  assert.equal((await mike('GET', '/api/requests')).status, 200);
});

test('static pages, legal pages and seed script', async () => {
  const home = await anon('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /HitchPoint/);
  assert.match(home.text, /"@type":"FAQPage"/);
  assert.match(home.text, /<link rel="canonical"/);
  assert.match((await anon('GET', '/robots.txt')).text, /Sitemap: .*\/sitemap\.xml/);
  assert.match((await anon('GET', '/sitemap.xml')).text, /<urlset/);
  assert.match((await anon('GET', '/llms.txt')).text, /# HitchPoint/);
  for (const p of ['/admin/', '/favicon.svg', '/static/brand/og.png', '/static/landing.js', '/p/abc', '/pay/abc', '/static/app.css', '/static/admin.js', '/static/site.js', '/legal/terms', '/legal/privacy', '/legal/payment-terms', '/legal/customer-terms']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  assert.equal((await fetch(base + '/static/../server.js')).status, 404);
  assert.equal((await fetch(base + '/legal/nope')).status, 404);

  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsqu-seed-'));
  const out = execFileSync(process.execPath, ['--no-warnings', 'scripts/seed-mike.js', 'mike@seed.test'], { cwd: ROOT, env: { ...process.env, DATA_DIR: seedDir, BASE_URL: 'https://dash.test' } }).toString();
  assert.match(out, /https:\/\/dash\.test\/admin\/#\/reset\//);
  fs.rmSync(seedDir, { recursive: true, force: true });
});
