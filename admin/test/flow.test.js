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

// ---- fake Stripe ----
// Current model: each business has its own v2 account (merchant configuration); Checkout Sessions
// are created ON that account (Stripe-Account header) with an application fee.
// Legacy model (still settled for old payments): Express accounts, platform sessions, transfers.
const sessions = new Map();
const accounts = new Map(); // v1 Express (legacy)
const merchants = new Map(); // v2 merchant accounts
const transfers = [];
const v2Requests = [];
const appFees = new Map(); // application fees (platform account) for refund tests
const appFeeRefunds = [];
const stripeFee = (amt) => Math.round(amt * 0.029) + 30;
const stripeMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ok = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const bad = (msg) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: msg } })); };
    const onAccount = req.headers['stripe-account'] || null;
    let m;
    // ---- API v2 (JSON) ----
    if (req.url.startsWith('/v2/')) {
      if (req.headers['stripe-version'] !== '2026-10-28.endive') return bad('v2 requests need Stripe-Version 2026-10-28.endive');
      const j = body ? JSON.parse(body) : null;
      v2Requests.push({ method: req.method, url: req.url, body: j });
      if (req.method === 'POST' && req.url === '/v2/core/accounts') {
        if ('type' in j) return bad('v2 accounts take no top-level type');
        const id = 'acct_' + crypto.randomBytes(5).toString('hex');
        merchants.set(id, { id, body: j, card: 'inactive', due: 'currently_due', submitted: false });
        return ok({ id, object: 'v2.core.account' });
      }
      if (req.method === 'POST' && req.url === '/v2/core/account_links') {
        if (j.use_case?.account_onboarding?.configurations) return bad('Received unknown parameter: use_case.account_onboarding.configurations');
        return ok({ object: 'v2.core.account_link', url: 'https://connect.stripe.test/setup/' + j.account });
      }
      if (req.method === 'GET' && (m = /^\/v2\/core\/accounts\/([^?]+)\?include\[0\]=configuration\.merchant&include\[1\]=requirements$/.exec(req.url)) && merchants.has(m[1])) {
        const a = merchants.get(m[1]);
        return ok({ id: a.id, configuration: { merchant: { capabilities: { card_payments: { status: a.card } } } }, requirements: { summary: { minimum_deadline: a.due ? { status: a.due } : null } } });
      }
      res.writeHead(404); return res.end('{}');
    }
    // ---- API v1 (form) ----
    const p = new URLSearchParams(body);
    if (req.method === 'POST' && req.url === '/v1/accounts') {
      const id = 'acct_' + crypto.randomBytes(5).toString('hex');
      accounts.set(id, { id, type: p.get('type'), payouts_enabled: false, details_submitted: false, capabilities: { transfers: 'inactive' } });
      return ok(accounts.get(id));
    }
    if (req.method === 'POST' && req.url === '/v1/account_links') return ok({ url: 'https://connect.stripe.test/setup/' + p.get('account') });
    if (req.method === 'POST' && (m = /^\/v1\/accounts\/(.+)\/login_links$/.exec(req.url))) return ok({ url: 'https://connect.stripe.test/express/' + m[1] });
    if (req.method === 'GET' && (m = /^\/v1\/accounts\/([^/?]+)$/.exec(req.url))) {
      if (accounts.has(m[1])) return ok(accounts.get(m[1]));
      const a = merchants.get(m[1]); // v2 accounts are also readable through v1
      return a ? ok({ id: a.id, object: 'account', details_submitted: a.submitted, charges_enabled: a.card === 'active' }) : bad('No such account');
    }
    if (req.method === 'GET' && (m = /^\/v1\/application_fees\/([^/?]+)$/.exec(req.url)) && appFees.has(m[1])) return ok(appFees.get(m[1]));
    if (req.method === 'POST' && (m = /^\/v1\/application_fees\/([^/]+)\/refunds$/.exec(req.url)) && appFees.has(m[1])) {
      const key = req.headers['idempotency-key'];
      const prior = appFeeRefunds.find((r) => r.key === key);
      if (prior) return ok(prior);
      const f = appFees.get(m[1]); const amt = Number(p.get('amount'));
      if (f.amount_refunded + amt > f.amount) return bad('Refund exceeds the application fee');
      f.amount_refunded += amt;
      const r = { id: 'fr_' + crypto.randomBytes(4).toString('hex'), key, fee: f.id, amount: amt };
      appFeeRefunds.push(r);
      return ok(r);
    }
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      if (onAccount && !merchants.has(onAccount)) return bad('No such account');
      const id = 'cs_test_' + crypto.randomBytes(6).toString('hex');
      const lines = [];
      for (let i = 0; p.has(`line_items[${i}][price_data][unit_amount]`); i++) lines.push({ name: p.get(`line_items[${i}][price_data][product_data][name]`), amount: Number(p.get(`line_items[${i}][price_data][unit_amount]`)) });
      const s = {
        id, account: onAccount, url: 'https://checkout.stripe.test/' + id, client_reference_id: p.get('client_reference_id'), lines, amount_total: lines.reduce((a, l) => a + l.amount, 0),
        application_fee: p.get('payment_intent_data[application_fee_amount]'), descriptor_suffix: p.get('payment_intent_data[statement_descriptor_suffix]'),
        terms_version: p.get('metadata[customer_terms_version]'), pi_terms_version: p.get('payment_intent_data[metadata][customer_terms_version]'), payment_status: 'unpaid',
      };
      sessions.set(id, s);
      return ok(s);
    }
    if (req.method === 'GET' && (m = /^\/v1\/checkout\/sessions\/([^?]+)\?expand\[\]=payment_intent\.latest_charge\.balance_transaction$/.exec(req.url)) && sessions.has(m[1])) {
      const s = sessions.get(m[1]);
      if ((s.account || null) !== onAccount) return bad('No such checkout.session (wrong account)');
      const sf = stripeFee(s.amount_total);
      const app = Number(s.application_fee || 0);
      // Direct charge on the business's account: fee = Stripe's fee + the application fee.
      const bt = s.account
        ? { id: 'txn_' + s.id, fee: sf + app, net: s.amount_total - sf - app, fee_details: [{ type: 'stripe_fee', amount: sf }, { type: 'application_fee', amount: app }] }
        : { id: 'txn_' + s.id, fee: sf };
      return ok({ ...s, payment_intent: s.payment_status === 'paid' ? { id: 'pi_' + s.id, latest_charge: { id: 'ch_' + s.id, balance_transaction: bt } } : null });
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

let server, base, dataDir, appDb;
const WHSEC = 'whsec_platform_test';

// ---- fake Anthropic Messages API (photo-to-proposal drafts) ----
const aiCalls = [];
const aiMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body || '{}');
    aiCalls.push({ headers: req.headers, body: b });
    const content = b.messages?.[0]?.content || [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (/FAIL/.test(text)) { res.writeHead(529, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } })); }
    const list = JSON.parse(/Price list \(JSON\): (\[.*\])/.exec(text)[1]);
    const first = list[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: b.model, content: [{ type: 'tool_use', id: 'tu_1', name: 'draft_proposal', input: {
      title: 'Awning arm replacement', customer_summary: 'The front awning arm is bent at the elbow, so the awning can’t roll up.',
      findings: ['Front awning arm bent at the elbow', 'Fabric looks intact'], safety_notes: [], questions_for_technician: ['Confirm the awning brand and arm length'],
      line_items: [{ product_id: first.product_id, name: 'whatever the model said', quantity: 1 }, { product_id: 999999, name: 'Replacement awning arm', description: 'OEM-style arm', quantity: 1 }, { product_id: null, name: '', quantity: 1 }],
    } }] }));
  });
});

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
  await new Promise((r) => aiMock.listen(0, r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsqu-test-'));
  const { handler, db, outbox: ob } = createApp({
    DATA_DIR: dataDir, SUPER_ADMIN_EMAIL: 'aaron@agilities.test', SUPER_ADMIN_PASSWORD: 'super-secret-pw',
    STRIPE_SECRET_KEY: 'sk_test_platform', STRIPE_API_BASE: `http://localhost:${stripeMock.address().port}`, STRIPE_WEBHOOK_SECRET: WHSEC,
    ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_API_BASE: `http://localhost:${aiMock.address().port}`, NOTIFY_CAPTURE: '1',
  });
  appDb = db;
  outbox = ob;
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); stripeMock.close(); aiMock.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SIG = 'data:image/png;base64,' + 'A'.repeat(400);
let mikeId, mikeSlug, outbox;

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
  // The business must connect its OWN Stripe account (it is the seller of record) before the dashboard opens.
  assert.equal((await mike('GET', '/api/me')).json.needs_payout_setup, true);
  assert.equal((await mike('GET', '/api/requests')).status, 428);
  const c = await mike('POST', '/api/stripe/connect');
  assert.match(c.json.url, /connect\.stripe\.test\/setup\/acct_/);
  const acct = c.json.url.split('/').pop();
  const created2 = v2Requests.find((r) => r.url === '/v2/core/accounts');
  assert.deepEqual(created2.body, {
    display_name: 'Mike Stevens Emergency RV & Trailer Repair', contact_email: 'mike@rv.test', identity: { country: 'us' }, dashboard: 'full',
    defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
    configuration: { merchant: { mcc: '7538', capabilities: { card_payments: { requested: true }, ach_debit_payments: { requested: true } } } },
    metadata: { tenant_id: String(mikeId) },
  });
  // Still owes Stripe information: dashboard stays closed.
  assert.equal((await mike('POST', '/api/stripe/refresh')).json.details_submitted, false);
  Object.assign(merchants.get(acct), { due: 'eventually_due', submitted: true }); // owner finished Stripe's form; card payments still being verified
  assert.equal((await mike('POST', '/api/stripe/refresh')).json.details_submitted, true);
  assert.equal((await mike('GET', '/api/me')).json.needs_payout_setup, false);
  assert.equal((await mike('GET', '/api/requests')).status, 200);
  const cfg = (await mike('GET', '/api/config')).json;
  assert.equal(cfg.stripe.account_type, 'merchant');
  assert.equal(cfg.stripe.online_ready, false, 'no online payments until card payments are active and terms approved');
  assert.equal((await mike('POST', '/api/stripe/dashboard')).json.url, 'https://dashboard.stripe.com/');
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
  for (const a of merchants.values()) Object.assign(a, { due: null, submitted: true });
  await other('POST', '/api/stripe/refresh');
  assert.equal((await other('GET', '/api/me')).json.needs_payout_setup, false);
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

function signed(evt) { const w = webhook(evt); return { body: w.raw, headers: { 'Stripe-Signature': w.header, 'Content-Type': 'application/json' } }; }
const post = (who, evt) => { const w = signed(evt); return who('POST', '/api/stripe/webhook', w.body, w.headers); };
let mikeAcct, termsV1;

test('one-time business setup and owner-approved customer Terms & Conditions', async () => {
  mikeAcct = [...merchants.keys()][0];
  let prof = (await mike('GET', '/api/legal-profile')).json;
  assert.equal(prof.saved, false);
  assert.equal(prof.profile.warrantyDays, 30);
  assert.ok(prof.missing.includes('legalName') && prof.missing.includes('taxConfirmed'));
  assert.equal((await mike('GET', '/api/customer-terms')).json.draft, null, 'no draft until details are complete');

  const bad = await mike('PUT', '/api/legal-profile', { profile: { state: 'ZZ', postalCode: '1' }, tax_rate_bp: 99999 });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.field_errors.legalName && bad.json.field_errors.state && bad.json.field_errors.postalCode && bad.json.field_errors.tax_rate_bp);

  const details = { legalName: 'Mike Stevens RV Repair LLC', addressLine1: '1 Main St', city: 'Ogden', state: 'UT', postalCode: '84401', insured: true, licenseNumber: '12345678-5501', warrantyDays: 30, venueCounty: 'Weber County', taxConfirmed: true };
  prof = await mike('PUT', '/api/legal-profile', { profile: details, tax_rate_bp: 725 });
  assert.equal(prof.status, 200);
  assert.equal(prof.json.complete, true);
  assert.equal(prof.json.profile.venueCounty, 'Weber');
  assert.equal((await mike('GET', '/api/config')).json.settings.tax_rate_bp, 725, 'one sales tax rate, used as the quote default');

  let terms = (await mike('GET', '/api/customer-terms')).json;
  assert.match(terms.draft, /\*\*Mike Stevens RV Repair LLC\*\* \(doing business as Mike Stevens Emergency RV & Trailer Repair\)/);
  assert.match(terms.draft, /is the seller of all services, parts, and materials/);
  assert.match(terms.draft, /\$129\.00\*\* repair diagnosis and onsite review deposit/);
  assert.match(terms.draft, /\*\*30 days\*\*/);
  assert.doesNotMatch(terms.draft, /MISSING|\{\{/);
  assert.equal(terms.can_approve, true);

  // Platform staff can view but never give the owner's final approval.
  await superA('POST', '/api/super/view-as', { tenant_id: mikeId });
  assert.equal((await superA('GET', '/api/customer-terms')).json.can_approve, false);
  assert.equal((await superA('POST', '/api/customer-terms/approve', { markdown: terms.draft, name: 'Aaron', title: 'Admin', authorized: true, reviewed: true, seller_of_record: true })).status, 403);
  await superA('POST', '/api/super/view-as', { tenant_id: 0 });

  assert.equal((await mike('POST', '/api/customer-terms/approve', { markdown: terms.draft, name: 'Mike Stevens', title: 'Owner', authorized: true, reviewed: true })).status, 400, 'all three statements required');
  assert.equal((await mike('POST', '/api/customer-terms/approve', { markdown: terms.draft + '\n{{warranty_days}}', name: 'Mike Stevens', title: 'Owner', authorized: true, reviewed: true, seller_of_record: true })).status, 400);
  const ok1 = await mike('POST', '/api/customer-terms/approve', { markdown: terms.draft, name: 'Mike Stevens', title: 'Owner', authorized: true, reviewed: true, seller_of_record: true });
  assert.equal(ok1.status, 201);
  assert.equal(ok1.json.version, 1);
  termsV1 = ok1.json;
  const row = appDb.prepare('SELECT * FROM customer_terms WHERE tenant_id = ?').get(mikeId);
  assert.equal(row.source, 'template');
  assert.match(row.attestation, /^I, Mike Stevens, Owner of Mike Stevens RV Repair LLC, confirm/);
  assert.match(row.attestation, /seller and merchant of record/);

  const page = await anon('GET', `/s/${mikeSlug}/terms`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Version 1 · Approved/);
  assert.match(page.text, /Mike Stevens RV Repair LLC/);
  assert.match(page.text, new RegExp(termsV1.sha256));

  // Card payments become active (v2 accounts also send v1 account.updated to the Connect endpoint).
  merchants.get(mikeAcct).card = 'active';
  await post(anon, { type: 'account.updated', account: mikeAcct, data: { object: { id: mikeAcct, object: 'account', charges_enabled: true, details_submitted: true, capabilities: { card_payments: 'active' } } } });
  assert.equal((await mike('GET', '/api/config')).json.stripe.online_ready, true);

  // Changing a detail used in the wording asks the owner to review again; customers keep v1 meanwhile.
  await mike('PUT', '/api/legal-profile', { profile: { ...details, warrantyDays: 60 }, tax_rate_bp: 725 });
  terms = (await mike('GET', '/api/customer-terms')).json;
  assert.equal(terms.needs_review, true);
  assert.match(terms.draft, /\*\*60 days\*\*/);
  assert.equal((await mike('GET', '/api/config')).json.stripe.online_ready, true);
  await mike('PUT', '/api/legal-profile', { profile: details, tax_rate_bp: 725 });
  assert.equal((await mike('GET', '/api/customer-terms')).json.needs_review, false);
});

test('deposit paid online: direct charge on the business account with the 3% application fee', async () => {
  const rid = (await mike('GET', '/api/requests')).json.rows[0].id;
  const dep = await mike('POST', `/api/requests/${rid}/deposit`, { method: 'card' });
  const pub = (await anon('GET', `/api/public/payments/${dep.json.token}`)).json;
  assert.deepEqual([pub.online.fee, pub.online.charge, pub.online.card_payments], [0, 12900, true], 'customer pays only the amount due');
  assert.deepEqual(pub.customer_terms, { version: 1, url: `/s/${mikeSlug}/terms?v=1` });
  const co = await anon('POST', `/api/public/payments/${dep.json.token}/checkout`, {});
  assert.ok(co.json.url);
  const sess = [...sessions.values()].find((s) => s.client_reference_id === dep.json.token);
  assert.equal(sess.account, mikeAcct, 'created on the business’s own account: the business is merchant of record');
  assert.deepEqual(sess.lines, [{ name: 'Repair diagnosis and onsite review (credited toward the job)', amount: 12900 }]);
  assert.equal(sess.application_fee, '387');
  assert.equal(sess.descriptor_suffix, 'MIKE STEVENS EMERGENCY');
  assert.deepEqual([sess.terms_version, sess.pi_terms_version], ['1', '1']);

  sess.payment_status = 'paid';
  const forged = webhook({ type: 'checkout.session.completed', account: mikeAcct, data: { object: sess } });
  assert.equal((await anon('POST', '/api/stripe/webhook', forged.raw, { 'Stripe-Signature': 't=1,v1=bad', 'Content-Type': 'application/json' })).status, 400);
  // The same session reported as a platform event (no account) is ignored.
  await post(anon, { type: 'checkout.session.completed', data: { object: sess } });
  let pay = (await superA('GET', `/api/super/tenants/${mikeId}`)).json.payments.find((p) => p.kind === 'deposit');
  assert.equal(pay.status, 'pending');
  await post(anon, { type: 'checkout.session.completed', account: mikeAcct, data: { object: sess } });
  pay = (await superA('GET', `/api/super/tenants/${mikeId}`)).json.payments.find((p) => p.kind === 'deposit');
  assert.equal(pay.status, 'paid');
  // Stripe's fee 2.9% + 30¢ = 4.04 (billed to the business by Stripe); platform 3% = 3.87; business keeps 121.09.
  assert.deepEqual([pay.stripe_fee_cents, pay.fee_cents, pay.payout_cents, pay.transfer_status], [404, 387, 12109, 'direct']);
  await post(anon, { type: 'checkout.session.completed', account: mikeAcct, data: { object: sess } }); // replay
  assert.equal(transfers.length, 0, 'no transfers: the money was paid to the business directly');
  const mine = (await mike('GET', '/api/payments')).json.find((p) => p.method === 'card');
  assert.equal(mine.stripe_fee_cents + mine.fee_cents, 791);

  // The business refunds half from its Stripe Dashboard: the platform returns half of its 3%.
  appFees.set('fee_dep', { id: 'fee_dep', amount: 387, amount_refunded: 0 });
  const refunded = { id: 'ch_' + sess.id, object: 'charge', amount: 12900, amount_refunded: 6450, application_fee: 'fee_dep' };
  await post(anon, { type: 'charge.refunded', account: mikeAcct, data: { object: refunded } });
  await post(anon, { type: 'charge.refunded', account: mikeAcct, data: { object: refunded } }); // replay
  assert.equal(appFees.get('fee_dep').amount_refunded, 194);
  assert.equal(appFeeRefunds.length, 1);
  await post(anon, { type: 'charge.refunded', data: { object: refunded } }); // not from the business's account: ignored
  assert.equal(appFeeRefunds.length, 1);

  // A payment page loaded before the owner approved new terms can't check out on the old version.
  const dep2 = await mike('POST', `/api/requests/${rid}/deposit`, { method: 'card' });
  assert.equal((await anon('POST', `/api/public/payments/${dep2.json.token}/checkout`, { terms_version: 99 })).status, 409);
});

test('quote: signed with the business’s terms, paid online with the Processing Fee on the balance', async () => {
  const rid = (await mike('GET', '/api/requests')).json.rows[0].id;
  const q = await mike('POST', '/api/quotes', { request_id: rid });
  assert.equal(q.json.deposit_credit_cents, 12900);
  assert.equal(q.json.tax_rate_bp, 725, 'new quotes use the sales tax rate from setup');
  const saved = await mike('PUT', '/api/quotes/' + q.json.id, { ...q.json, tax_rate_bp: 725, items: [{ name: 'Trailer tire', qty: 2, unit_cents: 18999, taxable: 1 }, { name: 'Labor', qty: 1.5, unit_cents: 12000 }] });
  assert.deepEqual(saved.json.totals, { subtotal: 55998, tax: 2755, total: 58753, credit: 12900, balance: 45853 });
  const tok = saved.json.token;
  assert.equal((await other('GET', '/api/quotes/' + q.json.id)).status, 404);

  const pub = (await anon('GET', `/api/public/proposals/${tok}`)).json;
  assert.equal(pub.status, 'sent');
  assert.equal(pub.signer_ip, undefined);
  assert.deepEqual(pub.customer_terms, { version: 1, url: `/s/${mikeSlug}/terms?v=1` });
  assert.equal((await anon('POST', `/api/public/proposals/${tok}/checkout`, {})).status, 409);
  assert.equal((await anon('POST', `/api/public/proposals/${tok}/sign`, { name: 'Dana', agree: true, signature: SIG })).status, 409, 'must accept the current terms version');
  assert.equal((await anon('POST', `/api/public/proposals/${tok}/sign`, { name: 'Dana', agree: true, signature: SIG, terms_version: 1 })).status, 200);
  const qrow = appDb.prepare('SELECT customer_terms_version, customer_terms_sha256 FROM quotes WHERE token = ?').get(tok);
  assert.deepEqual([qrow.customer_terms_version, qrow.customer_terms_sha256], [1, termsV1.sha256]);
  assert.equal((await mike('PUT', '/api/quotes/' + q.json.id, { items: [] })).status, 409);
  await anon('POST', `/api/public/proposals/${tok}/checkout`, {});
  const s = [...sessions.values()].find((x) => x.lines[0].amount === 45853);
  assert.equal(s.account, mikeAcct);
  assert.equal(s.application_fee, '1376');
  s.payment_status = 'paid';
  const pay = (await mike('GET', '/api/quotes/' + q.json.id)).json.payments.find((p) => p.status === 'pending');
  assert.equal((await anon('POST', `/api/public/payments/${pay.token}/confirm`, { session_id: s.id })).json.paid, true);
  const done = (await mike('GET', '/api/quotes/' + q.json.id)).json;
  assert.equal(done.status, 'paid');
  const p2 = done.payments.find((p) => p.status === 'paid');
  // Stripe: 2.9% of 458.53 = 13.30 + 0.30 = 13.60; platform 3% = 13.76; business keeps 431.17
  assert.deepEqual([p2.stripe_fee_cents, p2.fee_cents, p2.payout_cents, p2.transfer_status], [1360, 1376, 43117, 'direct']);
});

test('custom platform share, cash has no fee; super overview, CSV, leads', async () => {
  await superA('PATCH', `/api/super/tenants/${mikeId}`, { fee_bp: 200 });
  const book = await anon('POST', `/api/public/t/${mikeSlug}/requests`, { type: 'winterize', name: 'Lee', phone: '801-555-0101', location: 'Ogden', preferred_date: '2026-11-05' });
  const q = await mike('POST', '/api/quotes', { request_id: book.json.id });
  assert.equal(q.json.title, 'Onsite RV winterizing package');
  assert.equal(q.json.totals.balance, 49900);
  await anon('POST', `/api/public/proposals/${q.json.token}/sign`, { name: 'Lee', agree: true, signature: SIG, terms_version: 1 });
  await anon('POST', `/api/public/proposals/${q.json.token}/checkout`, {});
  const s = [...sessions.values()].find((x) => x.lines[0].amount === 49900);
  assert.equal(s.application_fee, '998'); // 2% custom share
  s.payment_status = 'paid';
  await post(anon, { type: 'checkout.session.completed', account: mikeAcct, data: { object: s } });
  const p = (await mike('GET', '/api/quotes/' + q.json.id)).json.payments.find((x) => x.status === 'paid');
  assert.deepEqual([p.stripe_fee_cents, p.fee_cents, p.payout_cents], [1477, 998, 47425]);
  await superA('PATCH', `/api/super/tenants/${mikeId}`, { fee_bp: null });

  // Cash: no Processing Fee, no transfer.
  const r2 = await mike('POST', '/api/requests', { name: 'Walk-up', phone: '1', location: 'Shop' });
  const q2 = await mike('POST', '/api/quotes', { request_id: r2.json.id });
  await mike('PUT', '/api/quotes/' + q2.json.id, { ...q2.json, items: [{ name: 'Fuse', qty: 1, unit_cents: 1500 }] });
  const cash = await mike('POST', `/api/quotes/${q2.json.id}/payments`, { method: 'cash' });
  const cp = cash.json.payments.find((x) => x.status === 'paid');
  assert.deepEqual([cp.fee_cents, cp.stripe_fee_cents, cp.transfer_status], [0, 0, null]);

  const o = (await superA('GET', '/api/super/overview')).json;
  assert.equal(o.totals.fee_cents, 387 - 194 + 1376 + 998, 'net of the 3% returned on the refund');
  assert.equal(o.totals.stripe_fee_cents, 404 + 1360 + 1477);
  assert.equal(o.totals.payout_cents, 12109 + 43117 + 47425, 'direct payments count as paid to the business');
  assert.equal(o.totals.payouts_waiting, 0);
  assert.equal(o.tenants.find((t) => t.id === mikeId).terms_version, 1);
  const csv = await superA('GET', '/api/super/fees.csv');
  assert.match(csv.text, /Processing Fee total/);
  assert.equal(csv.text.trim().split('\n').length, 4);
  const detail = (await superA('GET', `/api/super/tenants/${mikeId}`)).json;
  assert.equal(detail.agreements.length, 3);
  assert.deepEqual(detail.customer_terms.map((x) => [x.version, x.approver_name, x.approver_title]), [[1, 'Mike Stevens', 'Owner']]);

  // Owner leads from the HitchPoint landing page.
  assert.equal((await anon('POST', '/api/public/leads', { name: 'Tech' })).status, 400);
  assert.equal((await anon('POST', '/api/public/leads', { name: 'Ray Tech', email: 'ray@tech.test', location: 'Boise, ID', certifications: 'RVTI Level 2' })).status, 201);
  const leads = (await superA('GET', '/api/super/leads')).json;
  assert.equal(leads[0].name, 'Ray Tech');
  assert.equal((await superA('PATCH', `/api/super/leads/${leads[0].id}`, { status: 'contacted' })).json.status, 'contacted');
  assert.equal((await mike('GET', '/api/super/leads')).status, 403);
  assert.equal((await superA('GET', '/api/super/overview')).json.leads_new, 0);
});

test('legacy business on an Express payout account must move to its own Stripe account; old payouts still finish', async () => {
  // A business set up under the old model: Express account, a paid platform charge awaiting transfer.
  const legacyAcct = 'acct_legacy' + crypto.randomBytes(3).toString('hex');
  accounts.set(legacyAcct, { id: legacyAcct, type: 'express', payouts_enabled: false, details_submitted: true, capabilities: { transfers: 'inactive' } });
  const old = client();
  assert.equal((await old('POST', '/api/signup', { business_name: 'Old Co', name: 'Olu', email: 'olu@old.test', password: 'long-enough-pw', agree: true })).status, 201);
  const tid = (await old('GET', '/api/me')).json.tenant.id;
  appDb.prepare('UPDATE tenants SET stripe_account_id = ?, stripe_details_submitted = 1 WHERE id = ?').run(legacyAcct, tid);
  const sid = 'cs_test_legacy' + crypto.randomBytes(3).toString('hex');
  sessions.set(sid, { id: sid, account: null, client_reference_id: 'legacytok', lines: [{ name: 'Old job', amount: 10000 }], amount_total: 10000, payment_status: 'paid' });
  appDb.prepare(`INSERT INTO payments (tenant_id, token, kind, description, amount_cents, method, status, stripe_session_id, paid_at, transfer_status, transfer_error) VALUES (?, 'legacytok', 'deposit', 'Old job', 10000, 'card', 'paid', ?, datetime('now'), 'failed', 'Destination account cannot receive transfers yet.')`).run(tid, sid);

  assert.equal((await old('GET', '/api/me')).json.needs_payout_setup, true, 'legacy accounts are sent through the new setup');
  const c = await old('POST', '/api/stripe/connect');
  const newAcct = c.json.url.split('/').pop();
  assert.ok(merchants.has(newAcct));
  const t = appDb.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  assert.deepEqual([t.stripe_account_id, t.stripe_account_type, t.legacy_stripe_account_id], [newAcct, 'v2_merchant', legacyAcct]);

  // The old Express account is verified later: its held payout goes to the OLD account, not the new one.
  Object.assign(accounts.get(legacyAcct), { payouts_enabled: true, capabilities: { transfers: 'active' } });
  await post(anon, { type: 'account.updated', account: legacyAcct, data: { object: accounts.get(legacyAcct) } });
  const tr = transfers.find((x) => x.destination === legacyAcct);
  assert.ok(tr, 'legacy payout sent');
  assert.equal(tr.amount, 10000 - stripeFee(10000) - 300);
  const after = appDb.prepare('SELECT * FROM tenants WHERE id = ?').get(tid);
  assert.equal(after.stripe_account_type, 'v2_merchant', 'legacy webhook does not overwrite the new account status');

  // Super admin relinks a legacy business by hand: the old payout account is kept and the new one starts unverified.
  const t2 = appDb.prepare(`INSERT INTO tenants (slug, name, stripe_account_id, stripe_payouts_enabled, stripe_details_submitted) VALUES ('relink-co', 'Relink Co', 'acct_oldexpress', 1, 1)`).run();
  const rid2 = Number(t2.lastInsertRowid);
  assert.equal((await superA('PATCH', `/api/super/tenants/${rid2}`, { stripe_account_id: 'acct_newmerchant' })).status, 200);
  const rl = appDb.prepare('SELECT * FROM tenants WHERE id = ?').get(rid2);
  assert.deepEqual([rl.stripe_account_id, rl.stripe_account_type, rl.legacy_stripe_account_id, rl.stripe_payouts_enabled, rl.stripe_details_submitted], ['acct_newmerchant', 'v2_merchant', 'acct_oldexpress', 0, 0]);
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
  const termsViaDomain = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: server.address().port, path: '/terms', headers: { Host: 'www.mikesrv.test' } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, text: b }));
    }).on('error', reject);
  });
  assert.equal(termsViaDomain.status, 200);
  assert.match(termsViaDomain.text, /Terms and Conditions of Service/);

  await superA('PATCH', `/api/super/tenants/${mikeId}`, { status: 'suspended' });
  assert.equal((await mike('GET', '/api/requests')).status, 403);
  assert.equal((await anon('POST', `/api/public/t/${mikeSlug}/requests`, { phone: '1', location: 'x' })).status, 404);
  assert.equal((await anon('GET', `/s/${mikeSlug}`)).status, 404);
  await superA('PATCH', `/api/super/tenants/${mikeId}`, { status: 'active' });
  assert.equal((await mike('GET', '/api/requests')).status, 200);
});

function viaHost(host, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: server.address().port, path: p, headers: { Host: host } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, text: b, headers: r.headers }));
    }).on('error', reject);
  });
}

test('website sections, city pages, PDFs and local-search markup', async () => {
  const st = await mike('GET', '/api/website');
  assert.equal(st.status, 200);
  assert.ok(st.json.checklist.length >= 10);
  assert.equal(st.json.checklist.find((c) => c.key === 'base').done, false);

  const bad = await mike('PUT', '/api/website', { base_city: 'Ogden', base_state: 'ZZ', cities: [{ name: 'Layton' }], videos: [{ url: 'https://vimeo.com/123' }], links: { facebook: 'not a url' }, search_console: '<script>' });
  assert.equal(bad.status, 422);
  for (const k of ['base_state', 'cities.0.state', 'videos.0.url', 'links.facebook', 'search_console']) assert.ok(bad.json.field_errors[k], k);

  const longIntro = 'We fix water heaters, slide-outs and roof leaks at Fort Buenaventura, the Ogden Valley campgrounds and driveways all over town, usually within a day of your call.';
  const good = await mike('PUT', '/api/website', {
    service_phrase: 'Mobile RV repair', base_city: 'Ogden', base_state: 'ut', radius_miles: '60',
    cities: [{ name: 'Ogden', state: 'UT', intro: longIntro }, { name: 'Layton', state: 'UT', intro: 'Short note.' }, { name: '', state: '', intro: '' }],
    hours: { always_open: false, note: 'Emergency calls answered after hours', days: { mon: { open: '08:00', close: '17:00' }, sat: { open: '09:00', close: '13:00' } } },
    credentials: [{ title: 'RVTI Certified Technician, Level 2', detail: 'Since 2015' }],
    faqs: [{ q: 'Do you come to campgrounds?', a: 'Yes, anywhere within about 60 miles.' }],
    videos: [{ url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Water heater repair' }, { url: 'https://www.youtube.com/shorts/abcdefghijk' }],
    links: { google_review: 'g.page/r/abc123/review', google_profile: 'https://maps.app.goo.gl/xyz' },
    search_console: '<meta name="google-site-verification" content="abcDEF123_-abcDEF123_-xyz" />',
  });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  const P = good.json.profile;
  assert.equal(P.base_state, 'UT');
  assert.equal(P.radius_miles, 60);
  assert.equal(P.cities.length, 2);
  assert.deepEqual(P.videos.map((v) => v.id), ['dQw4w9WgXcQ', 'abcdefghijk']);
  assert.equal(P.links.google_review, 'https://g.page/r/abc123/review');
  assert.equal(P.search_console, 'abcDEF123_-abcDEF123_-xyz');
  assert.equal(good.json.checklist.find((c) => c.key === 'base').done, true);
  assert.equal(good.json.checklist.find((c) => c.key === 'city_intros').done, false); // Layton is too short

  // PDFs: only real PDFs, then listed and downloadable
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% test checklist\n%%EOF').toString('base64');
  assert.equal((await mike('POST', '/api/website/resources', { title: 'Tank checklist', file: PNG.replace('image/png', 'application/pdf') })).status, 400);
  assert.equal((await mike('POST', '/api/website/resources', { title: '', file: pdf })).status, 400);
  const up = await mike('POST', '/api/website/resources', { title: 'Black and grey tank checklist', description: 'Print before your trip', file: pdf });
  assert.equal(up.status, 201);
  const doc = up.json.profile.resources[0];
  assert.match(doc.file, /^t\d+-doc-[\w-]+\.pdf$/);
  // Saving other sections keeps the file; renaming works
  const again = await mike('PUT', '/api/website', { ...P, resources: [{ file: doc.file, title: 'Tank checklist', description: 'Print before your trip' }, { file: 't999-doc-evil.pdf', title: 'x' }] });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.profile.resources.map((r) => [r.file, r.title]), [[doc.file, 'Tank checklist']]);
  // Another business can't touch it
  assert.equal((await other('DELETE', '/api/website/resources/' + doc.file)).status, 404);

  // Mike uses his own domain: canonical URLs point there; pages on the platform keep /s/<slug> links
  const site = await anon('GET', `/s/${mikeSlug}`);
  assert.equal(site.status, 200);
  assert.match(site.headers.get('content-security-policy'), /frame-src https:\/\/www\.youtube-nocookie\.com/);
  assert.match(site.text, /<link rel="canonical" href="https:\/\/www\.mikesrv\.test\/">/);
  assert.match(site.text, /<meta name="google-site-verification" content="abcDEF123_-abcDEF123_-xyz">/);
  const ld = [...site.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
  const biz = ld.find((x) => x['@type'] === 'AutoRepair');
  assert.ok(biz, 'business markup');
  assert.deepEqual(biz.areaServed.map((a) => a.name), ['Ogden, UT', 'Layton, UT']);
  assert.equal(biz.address.addressLocality, 'Ogden');
  assert.deepEqual(biz.openingHoursSpecification.map((h) => h.dayOfWeek), ['Monday', 'Saturday']);
  assert.deepEqual(biz.sameAs, ['https://maps.app.goo.gl/xyz']);
  assert.equal(biz.hasCredential[0].name, 'RVTI Certified Technician, Level 2');
  assert.ok(ld.find((x) => x['@type'] === 'FAQPage'));
  assert.match(site.text, /data-yt="dQw4w9WgXcQ"/);
  assert.match(site.text, new RegExp(`href="/s/${mikeSlug}/areas/ogden-ut"`));
  assert.match(site.text, new RegExp(`href="/s/${mikeSlug}/files/${doc.file}"`));
  assert.match(site.text, /Review us on Google/);
  assert.match(site.text, /9 AM–1 PM/);

  const ogden = await anon('GET', `/s/${mikeSlug}/areas/ogden-ut`);
  assert.equal(ogden.status, 200);
  assert.match(ogden.text, /<title>Mobile RV repair in Ogden, UT \| /);
  assert.match(ogden.text, /<meta name="robots" content="index,follow">/);
  assert.match(ogden.text, /Fort Buenaventura/);
  assert.match(ogden.text, /"@type":"Service"/);
  assert.match((await anon('GET', `/s/${mikeSlug}/areas/layton-ut`)).text, /<meta name="robots" content="noindex,follow">/);
  assert.equal((await anon('GET', `/s/${mikeSlug}/areas/provo-ut`)).status, 404);

  const file = await fetch(`${base}/s/${mikeSlug}/files/${doc.file}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /filename="tank-checklist\.pdf"/);
  assert.equal((await fetch(`${base}/s/${mikeSlug}/files/t1-doc-nope.pdf`)).status, 404);

  // On his own domain: links are relative to the domain; sitemap lists indexable pages only
  const home = await viaHost('www.mikesrv.test', '/');
  assert.match(home.text, /href="\/areas\/ogden-ut"/);
  assert.equal((await viaHost('www.mikesrv.test', '/areas/ogden-ut')).status, 200);
  assert.equal((await viaHost('www.mikesrv.test', `/files/${doc.file}`)).status, 200);
  const sm = await viaHost('www.mikesrv.test', '/sitemap.xml');
  assert.match(sm.text, /<loc>https:\/\/www\.mikesrv\.test\/<\/loc>/);
  assert.match(sm.text, /<loc>https:\/\/www\.mikesrv\.test\/areas\/ogden-ut<\/loc>/);
  assert.doesNotMatch(sm.text, /layton/);
  assert.match(sm.text, new RegExp(`/files/${doc.file}`));
  assert.match((await viaHost('www.mikesrv.test', '/robots.txt')).text, /Sitemap: https:\/\/www\.mikesrv\.test\/sitemap\.xml/);
  // The platform sitemap lists hosted business sites, but not ones on their own domain
  const psm = await anon('GET', '/sitemap.xml');
  assert.doesNotMatch(psm.text, new RegExp(`/s/${mikeSlug}/`));
  assert.match(psm.text, /\/s\/[\w-]+\/<\/loc>/);

  // A domain becomes canonical only once requests actually arrive on it
  assert.equal((await other('PUT', '/api/business', { custom_domain: 'not a domain' })).status, 400);
  assert.equal((await other('PUT', '/api/business', { custom_domain: 'www.other-rv.test' })).status, 200);
  const before = await other('GET', '/api/website');
  assert.match(before.json.site_url, /\/s\/[\w-]+\/$/);
  assert.match((await anon('GET', '/sitemap.xml')).text, new RegExp(before.json.site_url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.equal((await viaHost('www.other-rv.test', '/')).status, 200);
  assert.equal((await other('GET', '/api/website')).json.site_url, 'https://www.other-rv.test/');
  await other('PUT', '/api/business', { custom_domain: '' });
  // Lenient inputs: YouTube links without https://, closing at midnight
  const lenient = await other('PUT', '/api/website', { videos: [{ url: 'youtube.com/watch?v=dQw4w9WgXcQ' }], hours: { days: { fri: { open: '18:00', close: '00:00' } } } });
  assert.equal(lenient.status, 200, JSON.stringify(lenient.json));
  assert.equal(lenient.json.profile.videos[0].id, 'dQw4w9WgXcQ');
  assert.deepEqual(lenient.json.profile.hours.days.fri, { open: '18:00', close: '23:59' });

  const del = await mike('DELETE', '/api/website/resources/' + doc.file);
  assert.equal(del.status, 200);
  assert.equal(del.json.profile.resources.length, 0);
  assert.equal((await fetch(`${base}/s/${mikeSlug}/files/${doc.file}`)).status, 404);
});

test('photo quote: AI draft from the price list, photos on the proposal, consent, receipt by text and email, unsubscribe', async () => {
  const JPG = PNG; // tiny valid image
  assert.equal((await mike('POST', '/api/quotes/from-photos', { photos: [] })).status, 400);
  assert.equal((await mike('POST', '/api/quotes/from-photos', { photos: ['data:text/plain;base64,aGk='] })).status, 400);

  const d = await mike('POST', '/api/quotes/from-photos', { photos: [JPG, JPG], rig: '2019 Jayco Jay Flight', note: 'Awning will not retract' });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  const call = aiCalls.at(-1);
  assert.equal(call.headers['x-api-key'], 'sk-ant-test');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.model, 'claude-sonnet-5-5');
  assert.equal(call.body.messages[0].content.filter((c) => c.type === 'image').length, 2);
  const q = d.json;
  assert.equal(q.title, 'Awning arm replacement');
  assert.match(q.notes, /awning arm is bent/);
  assert.equal(q.photos.length, 2);
  assert.deepEqual(q.ai_draft.findings, ['Front awning arm bent at the elbow', 'Fabric looks intact']);
  // Price-list line keeps the business's own name and price; unknown product id becomes a $0 line to price
  const products = (await mike('GET', '/api/products')).json.filter((p) => p.active);
  const listed = products.sort((a, b) => a.name.localeCompare(b.name))[0];
  assert.equal(q.items[0].name, listed.name);
  assert.equal(q.items[0].unit_cents, listed.price_cents);
  assert.equal(q.items[1].name, 'Replacement awning arm');
  assert.equal(q.items[1].unit_cents, 0);
  assert.equal(q.items.length, 2); // nameless line dropped
  assert.deepEqual(q.ai_draft.needs_price, ['Replacement awning arm']);

  // AI failure still keeps the photos
  const failed = await mike('POST', '/api/quotes/from-photos', { photos: [JPG], note: 'FAIL please' });
  assert.equal(failed.status, 201);
  assert.match(failed.json.ai_draft.error, /529/);
  assert.equal(failed.json.photos.length, 1);
  assert.equal(failed.json.items.length, 0);
  assert.equal(failed.json.notes, ''); // the technician's note stays private
  assert.equal(failed.json.ai_draft.note, 'FAIL please');
  assert.equal((await other('GET', `/api/uploads/${failed.json.photos[0].file}`)).status, 404); // other businesses can't see it

  // Owner prices the open line, hides one photo, adds the customer
  const items = q.items.map((it) => ({ ...it, unit_cents: it.unit_cents || 18500 }));
  const saved = await mike('PUT', `/api/quotes/${q.id}`, { title: q.title, customer_name: 'Pat Camper', customer_phone: '801-555-0142', customer_email: '', rig: q.rig, notes: q.notes, terms: '', tax_rate_bp: 0, items, photos: [{ file: q.photos[0].file, show: true }, { file: q.photos[1].file, show: false }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.photos.map((p) => p.show), [true, false]);

  const pub = await anon('GET', `/api/public/proposals/${q.token}`);
  assert.equal(pub.json.photos.length, 1);
  assert.equal((await fetch(base + pub.json.photos[0].url)).status, 200);
  assert.equal((await fetch(`${base}/api/public/proposals/${q.token}/photos/${q.photos[1].file}`)).status, 404);
  assert.equal(pub.json.customer_phone, '801-555-0142');
  assert.match(pub.json.consent.sms, /Reply STOP/);

  // Sign: confirm contact, keep email updates on, opt in to texts
  const tv = pub.json.customer_terms?.version;
  assert.equal((await anon('POST', `/api/public/proposals/${q.token}/sign`, { name: 'Pat Camper', agree: true, signature: SIG, terms_version: tv, email: 'not-an-email' })).status, 400);
  const signed = await anon('POST', `/api/public/proposals/${q.token}/sign`, { name: 'Pat Camper', agree: true, signature: SIG, terms_version: tv, phone: '(801) 555-0142', email: 'Pat@Example.test', subscribe_email: true, subscribe_sms: true });
  assert.equal(signed.status, 200, JSON.stringify(signed.json));
  const custs = (await mike('GET', '/api/customers')).json;
  const pat = custs.find((c) => c.email === 'pat@example.test');
  assert.ok(pat && pat.email_opt_in === 1 && pat.sms_opt_in === 1);
  assert.match(appDb.prepare('SELECT sms_consent_text FROM customers WHERE id = ?').get(pat.id).sms_consent_text, /Consent isn't required to buy/);
  assert.equal((await other('GET', '/api/customers')).json.some((c) => c.email === 'pat@example.test'), false);
  const csv = await mike('GET', '/api/customers.csv');
  assert.match(csv.text, /pat@example\.test,yes/);

  // Paid (cash): receipt by text and email, once
  const before = outbox.length;
  assert.equal((await mike('POST', `/api/quotes/${q.id}/payments`, { method: 'cash' })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const sent = outbox.slice(before);
  const sms = sent.find((m) => m.kind === 'sms' && m.to === '+18015550142');
  assert.ok(sms, 'receipt text');
  assert.match(sms.body, /Thanks, Pat! We received your payment of \$/);
  const rpath = /(\/r\/[\w-]+)/.exec(sms.body)[1];
  const mail = sent.find((m) => m.kind === 'email' && m.to === 'pat@example.test');
  assert.ok(mail, 'receipt email');
  assert.match(mail.text, new RegExp(rpath));
  const unsub = /(\/u\/[\w-]+)/.exec(mail.text)[1];
  assert.match(mail.headers['List-Unsubscribe'], new RegExp(unsub));
  const receipt = await anon('GET', rpath);
  assert.equal(receipt.status, 200);
  assert.match(receipt.text, /Receipt/);
  assert.match(receipt.text, /Replacement awning arm/);
  assert.match(receipt.text, /Cash/);
  const again = appDb.prepare('SELECT receipt_sent_at FROM payments WHERE token = ?').get(rpath.slice(3));
  assert.ok(again.receipt_sent_at);
  assert.match((await anon('GET', `/api/public/proposals/${q.token}`)).json.receipts[0].url, /^\/r\//);

  // Unsubscribe: GET asks, POST does it
  assert.match((await anon('GET', unsub)).text, /Unsubscribe from/);
  assert.equal(appDb.prepare('SELECT email_opt_in FROM customers WHERE id = ?').get(pat.id).email_opt_in, 1);
  assert.match((await anon('POST', unsub, 'List-Unsubscribe=One-Click', { 'Content-Type': 'application/x-www-form-urlencoded' })).text, /You’re unsubscribed/);
  assert.equal(appDb.prepare('SELECT email_opt_in FROM customers WHERE id = ?').get(pat.id).email_opt_in, 0);
  assert.equal((await anon('GET', '/u/nope')).status, 404);
  assert.equal((await anon('GET', '/r/nope')).status, 404);
});

test('consent follows the person and the number; STOP and unsubscribe stick; CSV is safe', async () => {
  const newQuote = async (fields) => {
    const q = (await mike('POST', '/api/quotes', {})).json;
    await mike('PUT', `/api/quotes/${q.id}`, { title: 'Check-up', customer_name: 'Pat Camper', customer_phone: '', customer_email: '', rig: '', notes: '', terms: '', tax_rate_bp: 0, items: [{ name: 'Visit', qty: 1, unit_cents: 5000 }], ...fields });
    const pub = (await anon('GET', `/api/public/proposals/${q.token}`)).json;
    return { q, pub, sign: (body) => anon('POST', `/api/public/proposals/${q.token}/sign`, { name: 'Pat Camper', agree: true, signature: SIG, terms_version: pub.customer_terms?.version, ...body }) };
  };
  const pat = () => appDb.prepare(`SELECT * FROM customers WHERE email = 'pat@example.test'`).get();
  // Pat unsubscribed in the last test: the email box starts unchecked for her
  const a = await newQuote({ customer_email: 'pat@example.test' });
  assert.equal(a.pub.subscribe_email_default, false);
  // Same email, new number, texts not re-checked: text consent doesn't move to the new number
  assert.equal((await a.sign({ phone: '801-555-0199', email: 'pat@example.test', subscribe_email: false, subscribe_sms: false })).status, 200);
  assert.equal(pat().phone_key, '8015550199');
  assert.equal(pat().sms_opt_in, 0);
  assert.equal(pat().email_opt_in, 0);
  const log = appDb.prepare('SELECT channel, action, address FROM consent_log WHERE customer_id = ? ORDER BY id').all(pat().id);
  assert.deepEqual(log.map((l) => `${l.channel}:${l.action}`), ['email:opt_in', 'sms:opt_in', 'email:opt_out', 'sms:opt_out']);

  // A household number that already belongs to someone else's email doesn't overwrite them
  const b = await newQuote({});
  await b.sign({ phone: '801-555-0199', email: 'sam@example.test', subscribe_email: true, subscribe_sms: true });
  assert.equal(pat().email, 'pat@example.test');
  const sam = appDb.prepare(`SELECT * FROM customers WHERE email = 'sam@example.test'`).get();
  assert.ok(sam && sam.email_opt_in === 1 && sam.sms_opt_in === 1);

  // STOP from that number removes text consent everywhere
  assert.equal((await anon('POST', '/api/twilio/inbound', 'From=%2B18015550199&Body=Stop', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 200);
  assert.equal(appDb.prepare('SELECT sms_opt_in FROM customers WHERE id = ?').get(sam.id).sms_opt_in, 0);

  // A stored phone that isn't a number (e.g. "-") doesn't block signing from an old page
  const c = await newQuote({ customer_phone: '-' });
  assert.equal(c.pub.customer_phone, undefined);
  assert.equal((await anon('POST', `/api/public/proposals/${c.q.token}/sign`, { name: 'Pat Camper', agree: true, signature: SIG, terms_version: c.pub.customer_terms?.version })).status, 200);

  // Control characters can't sneak a formula into the CSV
  const d = await newQuote({});
  await d.sign({ name: 'Eve\r=1+2', phone: '801-555-0177', email: 'eve@example.test', subscribe_email: true });
  const csv = (await mike('GET', '/api/customers.csv')).text;
  assert.doesNotMatch(csv, /\r=1\+2/);
  assert.match(csv, /Eve =1\+2/);
});

test('service pages with the same name get their own addresses', async () => {
  const one = (await mike('POST', '/api/products', { name: 'Awning repair', price_cents: 0, on_site: true, details: 'First.' })).json;
  const two = (await mike('POST', '/api/products', { name: 'Awning repair!', price_cents: 0, on_site: true, details: 'Second.' })).json;
  assert.match((await anon('GET', `/s/${mikeSlug}/services/awning-repair`)).text, /<p>First\.<\/p>/);
  assert.match((await anon('GET', `/s/${mikeSlug}/services/awning-repair-${two.id}`)).text, /<p>Second\.<\/p>/);
  await mike('PATCH', `/api/products/${one.id}`, { active: false });
  await mike('PATCH', `/api/products/${two.id}`, { active: false });
});

test('bold look: banner, service tiles, highlights, service pages', async () => {
  const st = (await mike('GET', '/api/website')).json;
  assert.deepEqual(st.icons.slice(0, 2), ['tools', 'shield']);
  const look = await mike('PUT', '/api/website', { ...st.profile, theme: 'bold', banner: { alt: 'Mike’s banner' }, highlights: [{ icon: 'tools', title: 'On-site service', text: 'At your location' }, { icon: 'nope', title: 'Reliable repairs', text: '' }, { title: '', text: 'no title' }] });
  assert.equal(look.status, 422);
  assert.ok(look.json.field_errors['highlights.2.title']);
  const ok = await mike('PUT', '/api/website', { ...st.profile, theme: 'bold', banner: { alt: 'Mike’s banner' }, highlights: [{ icon: 'tools', title: 'On-site service', text: 'At your location' }, { icon: 'nope', title: 'Reliable repairs', text: '' }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.profile.highlights[1].icon, 'star');
  assert.equal((await other('POST', '/api/website/banner', { kind: 'desktop', image: PNG })).status, 200); // other business, own banner
  const banner = await mike('POST', '/api/website/banner', { kind: 'desktop', image: PNG });
  assert.equal(banner.status, 200);
  assert.equal((await mike('POST', '/api/website/banner', { kind: 'side', image: PNG })).status, 400);
  assert.equal((await fetch(base + banner.json.banner_urls.desktop)).status, 200);

  const products = (await mike('GET', '/api/products')).json;
  const svc = products.find((p) => p.on_site) || products[0];
  await mike('PATCH', `/api/products/${svc.id}`, { on_site: true, sort: -5, details: '## What’s included\n- Every step\n- Antifreeze\n\nCall to book.' });
  const pic = await mike('POST', `/api/products/${svc.id}/image`, { image: PNG });
  assert.equal(pic.status, 200);
  assert.match(pic.json.image, /^t\d+-prod-/);
  assert.equal((await other('POST', `/api/products/${svc.id}/image`, { image: PNG })).status, 404);

  const home = await anon('GET', `/s/${mikeSlug}`);
  assert.match(home.text, /<body class="bold">/);
  assert.match(home.text, /class="bnav"/);
  assert.match(home.text, new RegExp(`<img src="${banner.json.banner_urls.desktop}" alt="Mike’s banner"`));
  assert.match(home.text, new RegExp(`/media/${mikeSlug}/${pic.json.image}`));
  assert.match(home.text, /On-site service/);
  assert.equal((await fetch(`${base}/media/${mikeSlug}/${pic.json.image}`)).status, 200);
  const slug = svc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  assert.match(home.text, new RegExp(`/s/${mikeSlug}/services/${slug}`));
  const page = await anon('GET', `/s/${mikeSlug}/services/${slug}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h2>What’s included<\/h2>/);
  assert.match(page.text, /<li>Antifreeze<\/li>/);
  assert.match(page.text, /"@type":"Service"/);
  assert.equal((await anon('GET', `/s/${mikeSlug}/services/not-a-service`)).status, 404);
  assert.match((await viaHost('www.mikesrv.test', '/sitemap.xml')).text, new RegExp(`/services/${slug}`));
  // Removing the picture stops serving it
  await mike('POST', `/api/products/${svc.id}/image`, { image: null });
  assert.equal((await fetch(`${base}/media/${mikeSlug}/${pic.json.image}`)).status, 404);
  await mike('PUT', '/api/website', { ...ok.json.profile, theme: 'classic' });
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
  // Moving Mike's RSQU site onto HitchPoint: twice, to prove it's safe to re-run
  const apply = (...a) => execFileSync(process.execPath, ['--no-warnings', 'scripts/apply-rsqu-site.js', ...a], { cwd: ROOT, env: { ...process.env, DATA_DIR: seedDir } }).toString();
  assert.match(apply(), /Done\. 11 cities, 9 services \(7 with tile pictures\), 5 files/);
  assert.match(apply(), /Already applied on .*Nothing changed/);
  assert.match(apply('--force'), /Done\. 11 cities/);
  const { handler: h2 } = createApp({ DATA_DIR: seedDir, SUPER_ADMIN_EMAIL: 's@seed.test', SUPER_ADMIN_PASSWORD: 'super-secret-pw', BASE_URL: 'https://dash.test' });
  const srv2 = http.createServer(h2); await new Promise((r) => srv2.listen(0, r));
  const b2 = `http://localhost:${srv2.address().port}`;
  const rsqu = await (await fetch(b2 + '/s/mike-stevens')).text();
  assert.match(rsqu, /<body class="bold">/);
  assert.match(rsqu, /RSQU Mobile RV Service/);
  assert.equal([...rsqu.matchAll(/class="tile-grid"[\s\S]*?<\/ul>/g)][0][0].match(/<img /g).length, 7);
  const winter = await fetch(b2 + '/s/mike-stevens/services/onsite-rv-winterizing-package');
  assert.equal(winter.status, 200);
  assert.match(await winter.text(), /The 12-step winterizing checklist/);
  assert.equal(fs.readdirSync(path.join(seedDir, 'uploads')).length, 15); // photo, 2 banners, 7 tiles, 5 PDFs: nothing left over
  srv2.close();
  fs.rmSync(seedDir, { recursive: true, force: true });
});
