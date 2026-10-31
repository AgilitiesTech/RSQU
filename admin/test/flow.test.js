import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server.js';

// A tiny fake Stripe API: creates checkout sessions and lets the test mark them paid.
const sessions = new Map();
const stripeMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      const p = new URLSearchParams(body);
      const id = 'cs_test_' + crypto.randomBytes(6).toString('hex');
      const s = { id, url: 'https://checkout.stripe.test/' + id, client_reference_id: p.get('client_reference_id'), amount_total: Number(p.get('line_items[0][price_data][unit_amount]')), payment_status: 'unpaid', account: req.headers['stripe-account'] || null };
      sessions.set(id, s);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(s));
    }
    const m = /^\/v1\/checkout\/sessions\/(.+)$/.exec(req.url);
    if (req.method === 'GET' && m && sessions.has(m[1])) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(sessions.get(m[1]))); }
    res.writeHead(404); res.end('{}');
  });
});

let server, base, dataDir, cookie = '';
const WHSEC = 'whsec_test123';

async function call(method, p, body, opts = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(opts.auth === false ? {} : { Cookie: cookie }), ...(opts.headers || {}) },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc && sc.startsWith('sid=')) cookie = sc.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

function signedWebhook(event) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex');
  return { raw, header: `t=${t},v1=${sig}` };
}

before(async () => {
  await new Promise((r) => stripeMock.listen(0, r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsqu-test-'));
  const { handler } = createApp({
    DATA_DIR: dataDir, ADMIN_PASSWORD: 'correct horse', ALLOWED_ORIGINS: 'https://agilitiestech.github.io',
    STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_BASE: `http://localhost:${stripeMock.address().port}`, STRIPE_WEBHOOK_SECRET: WHSEC,
  });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => { server.close(); stripeMock.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SIG = 'data:image/png;base64,' + 'A'.repeat(400);

test('admin endpoints need login', async () => {
  assert.equal((await call('GET', '/api/requests', null, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'correct horse' })).status, 200);
  assert.ok(cookie.startsWith('sid='));
});

test('full repair flow: request → deposit → quote with credit → sign → card payment', async () => {
  // Website form posts a request (CORS from the GitHub Pages origin).
  const pre = await fetch(base + '/api/public/requests', { method: 'OPTIONS', headers: { Origin: 'https://agilitiestech.github.io' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://agilitiestech.github.io');
  const intake = await call('POST', '/api/public/requests', { type: 'repair', name: 'Dana', phone: '801-555-0100', location: 'I-15 NB mm 290', year: '2019', make: 'Jayco', model: 'Jay Flight', issue: 'Blowout', photo: PNG_1PX }, { auth: false, headers: { Origin: 'https://agilitiestech.github.io' } });
  assert.equal(intake.status, 201);
  assert.equal(intake.headers.get('access-control-allow-origin'), 'https://agilitiestech.github.io');
  const rid = intake.json.id;
  assert.equal((await call('POST', '/api/public/requests', { phone: '' }, { auth: false })).status, 400);

  const list = await call('GET', '/api/requests?filter=new');
  assert.equal(list.json.counts.new, 1);
  const req = await call('GET', '/api/requests/' + rid);
  assert.equal(req.json.rig, '2019 Jayco Jay Flight');
  assert.ok(req.json.photo);
  assert.equal((await call('GET', '/api/uploads/' + req.json.photo)).status, 200);
  assert.equal((await call('GET', '/api/uploads/' + req.json.photo, null, { auth: false })).status, 401);

  // $129 deposit by card link; customer pays through Stripe; webhook confirms.
  const dep = await call('POST', `/api/requests/${rid}/deposit`, { method: 'card' });
  assert.equal(dep.json.amount_cents, 12900);
  const ptoken = dep.json.token;
  const co = await call('POST', `/api/public/payments/${ptoken}/checkout`, {}, { auth: false });
  assert.match(co.json.url, /checkout\.stripe\.test/);
  const sess = [...sessions.values()].find((s) => s.client_reference_id === ptoken);
  assert.equal(sess.amount_total, 12900);
  sess.payment_status = 'paid';
  const bad = await call('POST', '/api/stripe/webhook', JSON.stringify({ type: 'checkout.session.completed', data: { object: sess } }), { auth: false, headers: { 'Stripe-Signature': 't=1,v1=bad', 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);
  const wh = signedWebhook({ type: 'checkout.session.completed', data: { object: sess } });
  assert.equal((await call('POST', '/api/stripe/webhook', wh.raw, { auth: false, headers: { 'Stripe-Signature': wh.header, 'Content-Type': 'application/json' } })).status, 200);
  assert.equal((await call('GET', `/api/public/payments/${ptoken}`, null, { auth: false })).json.status, 'paid');

  // Build a quote: deposit is credited.
  const products = (await call('GET', '/api/products')).json;
  assert.ok(products.find((p) => p.price_cents === 49900));
  const tire = await call('POST', '/api/products', { name: 'Trailer tire', price_cents: 18999, taxable: true });
  const q = await call('POST', '/api/quotes', { request_id: rid });
  assert.equal(q.json.deposit_credit_cents, 12900);
  const saved = await call('PUT', '/api/quotes/' + q.json.id, {
    ...q.json, tax_rate_bp: 725,
    items: [{ product_id: tire.json.id, name: 'Trailer tire', qty: 2, unit_cents: 18999, taxable: 1 }, { name: 'Labor', qty: 1.5, unit_cents: 12000, taxable: 0 }],
  });
  // subtotal 37998 + 18000 = 55998; tax 7.25% of 37998 = 2755; total 58753; balance 58753 - 12900 = 45853
  assert.deepEqual(saved.json.totals, { subtotal: 55998, tax: 2755, total: 58753, credit: 12900, balance: 45853 });
  const qtoken = saved.json.token;

  // Customer can't pay before signing; signs; then pays.
  assert.equal((await call('POST', `/api/public/proposals/${qtoken}/checkout`, {}, { auth: false })).status, 409);
  const pub = await call('GET', `/api/public/proposals/${qtoken}`, null, { auth: false });
  assert.equal(pub.json.status, 'sent');
  assert.equal(pub.json.signer_ip, undefined);
  assert.equal((await call('POST', `/api/public/proposals/${qtoken}/sign`, { name: 'Dana', agree: false, signature: SIG }, { auth: false })).status, 400);
  assert.equal((await call('POST', `/api/public/proposals/${qtoken}/sign`, { name: 'Dana', agree: true, signature: SIG }, { auth: false })).status, 200);
  assert.equal((await call('POST', `/api/public/proposals/${qtoken}/sign`, { name: 'Dana', agree: true, signature: SIG }, { auth: false })).status, 409);
  assert.equal((await call('PUT', '/api/quotes/' + q.json.id, { items: [] })).status, 409, 'signed quotes are locked');

  const qco = await call('POST', `/api/public/proposals/${qtoken}/checkout`, {}, { auth: false });
  const qs = [...sessions.values()].find((s) => s.amount_total === 45853);
  assert.ok(qco.json.url && qs);
  // Return page confirms before any webhook arrives.
  qs.payment_status = 'paid';
  const pay = (await call('GET', '/api/quotes/' + q.json.id)).json.payments.find((p) => p.status === 'pending');
  const conf = await call('POST', `/api/public/payments/${pay.token}/confirm`, { session_id: qs.id }, { auth: false });
  assert.equal(conf.json.paid, true);
  const done = await call('GET', '/api/quotes/' + q.json.id);
  assert.equal(done.json.status, 'paid');
  assert.equal((await call('GET', '/api/requests/' + rid)).json.status, 'paid');
});

test('winterizing booking prefills the $499 package; cash payment', async () => {
  const intake = await call('POST', '/api/public/requests', { type: 'winterize', name: 'Lee', phone: '801-555-0101', location: 'Storage lot, Ogden', rig: '2021 Grand Design', preferred_date: '2026-11-05' }, { auth: false });
  const q = await call('POST', '/api/quotes', { request_id: intake.json.id });
  assert.equal(q.json.items.length, 1);
  assert.equal(q.json.totals.balance, 49900);
  await call('POST', `/api/public/proposals/${q.json.token}/sign`, { name: 'Lee', agree: true, signature: SIG }, { auth: false });
  const paid = await call('POST', `/api/quotes/${q.json.id}/payments`, { method: 'cash' });
  assert.equal(paid.json.status, 'paid');
  assert.equal(paid.json.payments[0].method, 'cash');
});

test('honeypot and static pages', async () => {
  assert.equal((await call('POST', '/api/public/requests', { website: 'spam', phone: '1', location: 'x' }, { auth: false })).status, 201);
  assert.equal((await call('GET', '/api/requests?filter=all')).json.rows.length, 2);
  for (const p of ['/admin/', '/p/abc', '/pay/abc', '/static/app.css', '/static/admin.js']) assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal((await fetch(base + '/static/../server.js')).status, 404);
});
