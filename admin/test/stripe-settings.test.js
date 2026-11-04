// Stripe settings pasted into Render: harmless extras are ignored, real mistakes are named plainly,
// and the check never repeats the value.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { cleanSecret, stripeSettingProblem } from '../src/stripe.js';

const KEY = 'sk_live_' + 'A1b2C3d4'.repeat(12);
const WHSEC = 'whsec_' + 'Ab12+/Cd'.repeat(5);

test('cleanSecret drops spaces, line breaks and quotes around a value', () => {
  for (const v of [KEY, ` ${KEY}\n`, `"${KEY}"`, `'${KEY}'`, ` "${KEY}" `]) assert.equal(cleanSecret(v), KEY);
  assert.equal(cleanSecret(undefined), '');
});

test('stripeSettingProblem names the mistake without repeating the value', () => {
  assert.equal(stripeSettingProblem('STRIPE_SECRET_KEY', `${KEY}\n`), '');
  assert.equal(stripeSettingProblem('STRIPE_SECRET_KEY', 'rk_live_' + 'x'.repeat(40)), '');
  const cases = {
    ['pk_live_' + 'x'.repeat(90)]: /publishable key/,
    [WHSEC]: /webhook signing secret/,
    [`STRIPE_SECRET_KEY=${KEY}`]: /own name pasted/,
    [`Bearer ${KEY}`]: /Bearer/,
    ['sk_live_abc' + ' ' + 'd'.repeat(40)]: /space or line break/,
    ['sk_live_51Abc']: /cut off/,
    ['hello-world']: /should start with sk_live_/,
  };
  for (const [v, re] of Object.entries(cases)) {
    const msg = stripeSettingProblem('STRIPE_SECRET_KEY', v);
    assert.match(msg, re, v);
    assert.ok(!msg.includes(v.trim()) || v.length < 12, 'the value is never repeated');
    assert.ok(!msg.includes(KEY));
  }
  assert.equal(stripeSettingProblem('W', ` ${WHSEC} `, 'webhook'), '');
  assert.match(stripeSettingProblem('W', KEY, 'webhook'), /API key, not a webhook signing secret/);
});

test('the admin check: a padded key still works, and each setting gets a line', async () => {
  let v2Refused = false;
  const stripeMock = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${KEY}`;
    if (ok && req.url.startsWith('/v2/core/accounts')) {
      res.writeHead(v2Refused ? 400 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(v2Refused ? { error: { message: 'Accounts v2 is not enabled for this platform.' } } : { data: [] }));
    }
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { id: 'acct_platform', business_profile: { name: 'HitchPoint' }, charges_enabled: true, details_submitted: true } : { error: { message: 'Invalid API Key provided.' } }));
  });
  await new Promise((r) => stripeMock.listen(0, r));
  const dirs = [];
  const run = async (env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-stripe-')); dirs.push(dir);
    const app = createApp({ DATA_DIR: dir, SUPER_ADMIN_EMAIL: 'admin@agilities.test', SUPER_ADMIN_PASSWORD: 'super-secret-pw', NOTIFY_CAPTURE: '1', DISABLE_WORKER: '1', STRIPE_API_BASE: `http://localhost:${stripeMock.address().port}`, PLATFORM_URL: 'https://gethitchpoint.com', ...env });
    const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, r));
    const base = `http://localhost:${server.address().port}`;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@agilities.test', password: 'super-secret-pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await (await fetch(base + '/api/super/stripe-check', { method: 'POST', headers: { Cookie: cookie } })).json();
    server.close();
    return r;
  };
  try {
    const good = await run({ STRIPE_SECRET_KEY: ` ${KEY}\n`, STRIPE_CONNECT_WEBHOOK_SECRET: `"${WHSEC}"`, STRIPE_WEBHOOK_SECRET: WHSEC });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.test_mode, false);
    // Webhook secrets, then whether businesses' Stripe accounts can be made (Accounts v2), then the ACH setting.
    assert.deepEqual(good.checks.map((c) => c.ok), [true, true, true, true]);
    assert.match(good.checks[2].name, /Accounts v2/);
    assert.match(good.checks[3].message, /STRIPE_ACH_PAYMENTS/);
    v2Refused = true;
    const noV2 = await run({ STRIPE_SECRET_KEY: KEY, STRIPE_CONNECT_WEBHOOK_SECRET: WHSEC });
    assert.equal(noV2.checks.find((c) => /Accounts v2/.test(c.name)).ok, false);
    assert.match(noV2.checks.find((c) => /Accounts v2/.test(c.name)).message, /Connect Stripe fails: Accounts v2 is not enabled/);
    v2Refused = false;
    const pk = await run({ STRIPE_SECRET_KEY: 'pk_live_' + 'x'.repeat(90) });
    assert.equal(pk.ok, false);
    assert.match(pk.error, /publishable key/);
    assert.match(pk.checks[0].message, /No STRIPE_CONNECT_WEBHOOK_SECRET/);
    const rolled = await run({ STRIPE_SECRET_KEY: 'sk_live_' + 'Z9'.repeat(50), STRIPE_CONNECT_WEBHOOK_SECRET: WHSEC });
    assert.match(rolled.error, /looks right, but Stripe turned it down: Invalid API Key provided/);
    assert.ok(!JSON.stringify(rolled).includes('Z9Z9'), 'never echoes the key');
  } finally { stripeMock.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});
