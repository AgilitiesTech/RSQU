import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, platformSettings, processingFee, quoteTotals, slugify, AGREEMENT_VERSION, BUSINESS_AGREEMENTS } from './src/db.js';
import { hashPassword, verifyPassword, sessions, randomToken, sha256 } from './src/auth.js';
import { stripeClient, verifyStripeSignature } from './src/stripe.js';
import { notifier } from './src/notify.js';
import { renderSite } from './src/site.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

export function createApp(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const db = openDb(dataDir);
  const uploads = path.join(dataDir, 'uploads');
  const stripe = stripeClient(env);
  const notify = notifier(env);

  // Session secret: from env, else generated once and kept in the database.
  let secret = env.SESSION_SECRET || db.prepare(`SELECT value FROM platform_settings WHERE key = 'session_secret'`).get()?.value;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO platform_settings (key, value) VALUES ('session_secret', ?)`).run(secret);
  }
  const sess = sessions(secret);

  // Bootstrap the Agilities super admin from the environment.
  if (env.SUPER_ADMIN_EMAIL && env.SUPER_ADMIN_PASSWORD) {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(env.SUPER_ADMIN_EMAIL);
    if (!u) db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES (?, 'Agilities admin', ?, 'super')`).run(env.SUPER_ADMIN_EMAIL, hashPassword(env.SUPER_ADMIN_PASSWORD));
  }

  // ---------- helpers ----------
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const clean = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
  const cents = (v) => Math.max(0, Math.round(Number(v) || 0));
  const hexColor = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : d);
  const money = (c) => `$${(c / 100).toFixed(2)}`;

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  async function json(req, limit = 1_000_000) {
    const raw = await readBody(req, limit);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  function baseUrl(req) {
    if (env.BASE_URL) return env.BASE_URL.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    return `${proto}://${req.headers.host}`;
  }
  const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

  const buckets = new Map();
  function limited(key, max, windowMs) {
    const t = Date.now(); const b = buckets.get(key);
    if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowMs }); return false; }
    b.n += 1; return b.n > max;
  }

  function cookie(req, value, maxAge) {
    const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
    return `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
  }

  // ---------- data access ----------
  const getTenant = (id) => db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  const getTenantBySlug = (s) => db.prepare('SELECT * FROM tenants WHERE slug = ?').get(s);
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const getItems = (qid) => db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort, id').all(qid);
  const getPayment = (t) => db.prepare('SELECT * FROM payments WHERE token = ?').get(t);
  const getQuoteByToken = (t) => db.prepare('SELECT * FROM quotes WHERE token = ?').get(t);
  const scoped = (table, id, tid) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`).get(id, tid);

  function publicTenant(t) {
    if (!t) return null;
    const { id, slug, name, status, phone, email, notify_phone, tagline, hero_headline, about, service_area, primary_color, accent_color, logo, owner_photo, website_url, custom_domain, tax_rate_bp, deposit_cents, deposit_label, terms, stripe_account_id, stripe_charges_enabled, stripe_details_submitted, created_at } = t;
    return { id, slug, name, status, phone, email, notify_phone, tagline, hero_headline, about, service_area, primary_color, accent_color, logo, owner_photo, website_url, custom_domain, tax_rate_bp, deposit_cents, deposit_label, terms, stripe_account_id, stripe_charges_enabled, stripe_details_submitted, created_at };
  }
  // Brand details safe to show customers.
  const brand = (t) => ({ name: t.name, phone: t.phone, primary_color: t.primary_color, accent_color: t.accent_color, logo: t.logo ? `/media/${t.slug}/${t.logo}` : null, slug: t.slug });

  function uniqueSlug(name) {
    const base = slugify(name); let s = base, i = 2;
    while (getTenantBySlug(s) || ['admin', 'api', 'static', 'media', 'legal', 'signup', 'login', 'super'].includes(s)) s = `${base}-${i++}`;
    return s;
  }

  function needsAgreements(user) {
    if (!user || user.role === 'super') return false;
    const have = db.prepare(`SELECT doc FROM agreements WHERE tenant_id = ? AND user_id = ? AND version = ?`).all(user.tenant_id, user.id, AGREEMENT_VERSION).map((r) => r.doc);
    return user.role === 'owner' && BUSINESS_AGREEMENTS.some((d) => !have.includes(d));
  }
  function recordAgreements(req, user, tenantId) {
    const ins = db.prepare(`INSERT INTO agreements (user_id, tenant_id, doc, version, ip, ua) VALUES (?,?,?,?,?,?)`);
    for (const d of BUSINESS_AGREEMENTS) ins.run(user.id, tenantId, d, AGREEMENT_VERSION, clientIp(req), clean(req.headers['user-agent'], 400));
  }

  function setRequestStatus(id, status, onlyFrom) {
    if (!id) return;
    const r = db.prepare('SELECT status FROM requests WHERE id = ?').get(id); if (!r) return;
    if (onlyFrom && !onlyFrom.includes(r.status)) return;
    db.prepare(`UPDATE requests SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
  }
  function paidDeposits(requestId) {
    if (!requestId) return 0;
    return db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE request_id = ? AND kind = 'deposit' AND status = 'paid'`).get(requestId).s;
  }
  // Open (unpaid) quotes pick up any paid deposit as a credit.
  function refreshCredits(requestId) {
    if (!requestId) return;
    db.prepare(`UPDATE quotes SET deposit_credit_cents = ? WHERE request_id = ? AND status IN ('draft','sent','signed')`).run(paidDeposits(requestId), requestId);
  }
  function quoteFull(q) {
    const items = getItems(q.id);
    const payments = db.prepare('SELECT * FROM payments WHERE quote_id = ? ORDER BY id').all(q.id);
    return { ...q, items, totals: quoteTotals(q, items), payments };
  }

  function markPaid(payment, method, sessionId) {
    if (payment.status === 'paid') return;
    const offline = method !== 'card';
    db.prepare(`UPDATE payments SET status = 'paid', paid_at = ?, method = ?, stripe_session_id = COALESCE(?, stripe_session_id), fee_cents = CASE WHEN ? THEN 0 ELSE fee_cents END WHERE id = ?`)
      .run(now(), method, sessionId || null, offline ? 1 : 0, payment.id);
    const t = getTenant(payment.tenant_id);
    if (payment.kind === 'deposit') {
      refreshCredits(payment.request_id);
      notify.sms(t?.notify_phone, `${money(payment.amount_cents)} deposit paid (request #${payment.request_id}).`);
    } else if (payment.quote_id) {
      db.prepare(`UPDATE quotes SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), payment.quote_id);
      const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(payment.quote_id);
      setRequestStatus(q?.request_id, 'paid');
      notify.sms(t?.notify_phone, `Payment received: ${money(payment.amount_cents)} for quote #${payment.quote_id} (${q?.customer_name || 'customer'}).`);
    }
  }

  function saveImage(dataUrl, prefix, maxBytes) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > maxBytes) throw new HttpError(413, 'That photo is too large.');
    const name = `${prefix}-${randomToken(12)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(uploads, name), buf);
    return name;
  }
  function sendUpload(res, name) {
    const file = path.join(uploads, path.basename(name));
    if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
    const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[name.split('.').pop()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  // ---------- payments ----------
  function onlineQuote(t, amount) {
    const pf = processingFee(db, t, amount);
    return { mode: pf.mode, bp: pf.bp, fee: pf.mode === 'customer' ? pf.fee : 0, charge: pf.charge, card_payments: stripe.enabled && Boolean(t.stripe_account_id && t.stripe_charges_enabled) };
  }

  async function startCheckout(req, t, payment, { successPath, cancelPath, email }) {
    if (!stripe.enabled || !t.stripe_account_id || !t.stripe_charges_enabled) throw new HttpError(503, 'Online payments aren’t set up yet for this business. Please pay directly.');
    const pf = processingFee(db, t, payment.amount_cents);
    const lines = [{ name: payment.description, amountCents: payment.amount_cents }];
    if (pf.mode === 'customer' && pf.fee > 0) lines.push({ name: 'Processing Fee', amountCents: pf.fee });
    const base = baseUrl(req);
    const sep = successPath.includes('?') ? '&' : '?';
    const session = await stripe.createCheckout({
      account: t.stripe_account_id,
      lines,
      feeCents: pf.fee,
      successUrl: `${base}${successPath}${sep}paid=${payment.token}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}${cancelPath}`,
      ref: payment.token,
      email,
      statementName: t.name,
    });
    db.prepare(`UPDATE payments SET stripe_session_id = ?, stripe_account_id = ?, fee_cents = ?, fee_mode = ? WHERE id = ?`).run(session.id, t.stripe_account_id, pf.fee, pf.mode, payment.id);
    return session.url;
  }

  async function confirmCheckout(payment, sessionId) {
    if (payment.status === 'paid') return true;
    if (!sessionId || !stripe.enabled || !payment.stripe_account_id) return false;
    const s = await stripe.retrieveCheckout(sessionId, payment.stripe_account_id);
    if (s.client_reference_id !== payment.token) return false;
    if (s.payment_status === 'paid') { markPaid(getPayment(payment.token), 'card', s.id); return true; }
    return false;
  }

  async function refreshStripeStatus(t) {
    if (!stripe.enabled || !t.stripe_account_id) return t;
    const a = await stripe.getAccount(t.stripe_account_id);
    db.prepare(`UPDATE tenants SET stripe_charges_enabled = ?, stripe_details_submitted = ? WHERE id = ?`).run(a.charges_enabled ? 1 : 0, a.details_submitted ? 1 : 0, t.id);
    return getTenant(t.id);
  }

  // ---------- auth context ----------
  function context(req) {
    const s = sess.read(req.headers.cookie);
    if (!s) return null;
    const user = getUser(s.userId);
    if (!user) return null;
    const isSuper = user.role === 'super';
    const tenantId = isSuper ? s.viewAs : user.tenant_id;
    const tenant = tenantId ? getTenant(tenantId) : null;
    return { user, isSuper, tenant, viewAs: isSuper ? s.viewAs : 0 };
  }

  // ---------- routes ----------
  const routes = [];
  // auth: 'tenant' (business user, or super viewing a business) | 'owner' | 'super' | 'user' (any logged-in user)
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };

  // ===== accounts =====
  route('POST', '/api/signup', async (req, res) => {
    if (limited('signup:' + clientIp(req), 10, 3600_000)) throw new HttpError(429, 'Too many sign-ups from this network. Try again later.');
    const b = await json(req);
    const business = clean(b.business_name, 120), name = clean(b.name, 120), email = clean(b.email, 200).toLowerCase(), phone = clean(b.phone, 40);
    if (!business || !name || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Business name, your name and a valid email are required.');
    if (String(b.password || '').length < 10) throw new HttpError(400, 'Use a password of at least 10 characters.');
    if (!b.agree) throw new HttpError(400, 'Please accept the Terms of Service, Privacy Policy and Payment Processing and Fee Terms.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email already has an account. Log in instead.');
    const t = db.prepare(`INSERT INTO tenants (slug, name, phone, email, notify_phone, terms) VALUES (?,?,?,?,?,?)`)
      .run(uniqueSlug(business), business, phone, email, phone, 'Work is done as described above. Anything not listed is quoted separately and only done with your approval. Payment is due when the work is complete.');
    const tid = Number(t.lastInsertRowid);
    const u = db.prepare(`INSERT INTO users (tenant_id, email, name, password_hash, role, last_login_at) VALUES (?,?,?,?, 'owner', ?)`).run(tid, email, name, hashPassword(b.password), now());
    const user = getUser(Number(u.lastInsertRowid));
    recordAgreements(req, user, tid);
    send(res, 201, { ok: true }, { 'Set-Cookie': cookie(req, sess.create(user.id), sess.maxAge) });
  });

  route('POST', '/api/login', async (req, res) => {
    if (limited('login:' + clientIp(req), 15, 900_000)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
    const b = await json(req);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(clean(b.email, 200));
    if (!user || !verifyPassword(b.password || '', user.password_hash)) throw new HttpError(401, 'Wrong email or password.');
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, sess.create(user.id), sess.maxAge) });
  });
  route('POST', '/api/logout', async (req, res) => send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }));

  route('GET', '/api/me', async (req, res, p, url, ctx) => {
    if (!ctx) return send(res, 200, { authed: false });
    send(res, 200, {
      authed: true,
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role },
      tenant: ctx.tenant ? publicTenant(ctx.tenant) : null,
      viewing_as: Boolean(ctx.viewAs),
      needs_agreements: needsAgreements(ctx.user),
      agreement_version: AGREEMENT_VERSION,
    });
  });

  route('POST', '/api/agreements/accept', async (req, res, p, url, ctx) => {
    const b = await json(req);
    if (!b.agree) throw new HttpError(400, 'Please accept the agreements to continue.');
    if (ctx.user.role === 'super') return send(res, 200, { ok: true });
    recordAgreements(req, ctx.user, ctx.user.tenant_id);
    send(res, 200, { ok: true });
  }, { auth: 'user' });

  route('POST', '/api/password/forgot', async (req, res) => {
    if (limited('forgot:' + clientIp(req), 5, 3600_000)) throw new HttpError(429, 'Too many requests. Try again later.');
    const b = await json(req);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(clean(b.email, 200));
    let emailed = false;
    if (user) {
      const tok = randomToken(24);
      db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(tok), user.id, Date.now() + 3600_000);
      emailed = await notify.email(user.email, 'Reset your password', `Use this link within an hour to set a new password:\n\n${baseUrl(req)}/admin/#/reset/${tok}\n\nIf you didn't ask for this, ignore this email.`);
    }
    send(res, 200, { ok: true, email_enabled: notify.emailEnabled, emailed });
  });

  route('POST', '/api/password/reset', async (req, res) => {
    const b = await json(req);
    const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(String(b.token || '')));
    if (!r || r.used || r.expires_at < Date.now()) throw new HttpError(400, 'This reset link has expired. Ask for a new one.');
    if (String(b.password || '').length < 10) throw new HttpError(400, 'Use a password of at least 10 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), r.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(r.token_hash);
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, sess.create(r.user_id), sess.maxAge) });
  });

  route('POST', '/api/password/change', async (req, res, p, url, ctx) => {
    const b = await json(req);
    if (!verifyPassword(b.current || '', ctx.user.password_hash)) throw new HttpError(401, 'Your current password is wrong.');
    if (String(b.password || '').length < 10) throw new HttpError(400, 'Use a password of at least 10 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), ctx.user.id);
    send(res, 200, { ok: true });
  }, { auth: 'user' });

  // ===== public: website intake =====
  async function intake(req, res, t) {
    if (!t || t.status !== 'active') throw new HttpError(404, 'This business isn’t accepting requests online. Please call them.');
    if (limited('intake:' + clientIp(req), 20, 3600_000)) throw new HttpError(429, 'Too many requests. Please call or text instead.');
    const b = await json(req, 12_000_000);
    if (b.website) return send(res, 201, { ok: true }); // honeypot
    let type = b.type === 'repair' || !b.type ? 'repair' : 'booking';
    let productId = null;
    if (b.type === 'winterize') { // the original Mike Stevens site posts this
      productId = db.prepare(`SELECT id FROM products WHERE tenant_id = ? AND name LIKE '%winteriz%' ORDER BY id LIMIT 1`).get(t.id)?.id ?? null;
    } else if (type === 'booking' && b.product_id) {
      productId = db.prepare(`SELECT id FROM products WHERE tenant_id = ? AND id = ? AND bookable = 1 AND active = 1`).get(t.id, Number(b.product_id))?.id ?? null;
    }
    if (b.type === 'winterize' || productId) type = 'booking';
    const phone = clean(b.phone, 40), location = clean(b.location, 1000);
    if (!phone || !location) throw new HttpError(400, 'Location and phone are required.');
    const rig = clean(b.rig, 200) || [b.year, b.make, b.model].map((v) => clean(v, 80)).filter(Boolean).join(' ');
    const photo = b.photo ? saveImage(b.photo, `t${t.id}-req`, 8_000_000) : null;
    const r = db.prepare(`INSERT INTO requests (tenant_id, type, product_id, name, phone, email, location, rig, issue, preferred_date, photo) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.id, type, productId, clean(b.name, 120), phone, clean(b.email, 200), location, rig, clean(b.issue, 4000), clean(b.preferred_date, 40), photo);
    const id = Number(r.lastInsertRowid);
    const pname = productId ? db.prepare('SELECT name FROM products WHERE id = ?').get(productId)?.name : '';
    notify.sms(t.notify_phone, `New ${type === 'booking' ? 'BOOKING' + (pname ? ' (' + pname + ')' : '') : 'REPAIR request'} from ${clean(b.name, 60) || 'customer'} ${phone}\n${location.slice(0, 200)}\n${rig}\n${baseUrl(req)}/admin/#/requests/${id}`);
    send(res, 201, { ok: true, id });
  }
  route('POST', '/api/public/t/:slug/requests', async (req, res, p) => intake(req, res, getTenantBySlug(p.slug)), { cors: true });

  // ===== public: proposals and payments =====
  route('GET', '/api/public/proposals/:token', async (req, res, p) => {
    const q = getQuoteByToken(p.token);
    const t = q && getTenant(q.tenant_id);
    if (!q || q.status === 'void' || !t) throw new HttpError(404, 'This proposal isn’t available.');
    if (q.status === 'draft') db.prepare(`UPDATE quotes SET status = 'sent', updated_at = ? WHERE id = ?`).run(now(), q.id);
    const full = quoteFull({ ...q, status: q.status === 'draft' ? 'sent' : q.status });
    send(res, 200, {
      id: full.id, title: full.title, status: full.status, customer_name: full.customer_name, location: full.location, rig: full.rig,
      notes: full.notes, terms: full.terms, tax_rate_bp: full.tax_rate_bp, created_at: full.created_at,
      items: full.items.map(({ name, description, qty, unit_cents, taxable }) => ({ name, description, qty, unit_cents, taxable })),
      totals: full.totals, signer_name: full.signer_name, signature_png: full.signature_png, signed_at: full.signed_at, paid_at: full.paid_at,
      online: onlineQuote(t, full.totals.balance),
      business: brand(t),
    });
  });

  route('POST', '/api/public/proposals/:token/sign', async (req, res, p) => {
    const q = getQuoteByToken(p.token);
    if (!q || q.status === 'void') throw new HttpError(404, 'This proposal isn’t available.');
    if (q.signed_at) throw new HttpError(409, 'This proposal is already signed.');
    const b = await json(req, 1_000_000);
    const name = clean(b.name, 120);
    if (!name || !b.agree) throw new HttpError(400, 'Type your name and check the box to accept.');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/.test(b.signature || '')) throw new HttpError(400, 'Please sign in the box.');
    if (b.signature.length > 700_000) throw new HttpError(413, 'Signature is too large.');
    const ts = now();
    db.prepare(`UPDATE quotes SET status = 'signed', signer_name = ?, signature_png = ?, signer_ip = ?, signer_ua = ?, signed_at = ?, updated_at = ? WHERE id = ?`)
      .run(name, b.signature, clientIp(req), clean(req.headers['user-agent'], 400), ts, ts, q.id);
    setRequestStatus(q.request_id, 'accepted');
    notify.sms(getTenant(q.tenant_id)?.notify_phone, `Proposal #${q.id} signed by ${name}.`);
    send(res, 200, { ok: true });
  });

  route('POST', '/api/public/proposals/:token/checkout', async (req, res, p) => {
    const q = getQuoteByToken(p.token);
    const t = q && getTenant(q.tenant_id);
    if (!q || q.status === 'void' || !t) throw new HttpError(404, 'This proposal isn’t available.');
    if (!q.signed_at) throw new HttpError(409, 'Please sign the proposal first.');
    if (q.status === 'paid') throw new HttpError(409, 'This proposal is already paid.');
    const { balance } = quoteTotals(q, getItems(q.id));
    if (balance < 50) throw new HttpError(409, 'Nothing is due on this proposal.');
    let pay = db.prepare(`SELECT * FROM payments WHERE quote_id = ? AND status = 'pending' AND amount_cents = ? ORDER BY id DESC`).get(q.id, balance);
    if (!pay) {
      const tok = randomToken();
      db.prepare(`INSERT INTO payments (tenant_id, token, kind, quote_id, request_id, description, amount_cents, method) VALUES (?, ?, 'quote', ?, ?, ?, ?, 'card')`)
        .run(t.id, tok, q.id, q.request_id, `${q.title} (#${q.id})`, balance);
      pay = getPayment(tok);
    }
    const url = await startCheckout(req, t, pay, { successPath: `/p/${q.token}`, cancelPath: `/p/${q.token}`, email: q.customer_email });
    send(res, 200, { url });
  });

  route('GET', '/api/public/payments/:token', async (req, res, p) => {
    const pay = getPayment(p.token);
    const t = pay && getTenant(pay.tenant_id);
    if (!pay || !t) throw new HttpError(404, 'This payment link isn’t valid.');
    send(res, 200, { description: pay.description, amount_cents: pay.amount_cents, status: pay.status, kind: pay.kind, paid_at: pay.paid_at, fee_cents: pay.status === 'paid' && pay.fee_mode === 'customer' ? pay.fee_cents : 0, online: onlineQuote(t, pay.amount_cents), business: brand(t) });
  });

  route('POST', '/api/public/payments/:token/checkout', async (req, res, p) => {
    const pay = getPayment(p.token);
    const t = pay && getTenant(pay.tenant_id);
    if (!pay || !t) throw new HttpError(404, 'This payment link isn’t valid.');
    if (pay.status === 'paid') throw new HttpError(409, 'This is already paid.');
    const r = pay.request_id ? db.prepare('SELECT email FROM requests WHERE id = ?').get(pay.request_id) : null;
    const url = await startCheckout(req, t, pay, { successPath: `/pay/${pay.token}`, cancelPath: `/pay/${pay.token}`, email: r?.email });
    send(res, 200, { url });
  });

  route('POST', '/api/public/payments/:token/confirm', async (req, res, p) => {
    const pay = getPayment(p.token);
    if (!pay) throw new HttpError(404, 'Payment not found.');
    const b = await json(req);
    send(res, 200, { paid: await confirmCheckout(pay, clean(b.session_id, 200)) });
  });

  // Stripe webhooks: platform endpoint and Connect endpoint can share this URL.
  route('POST', '/api/stripe/webhook', async (req, res) => {
    const raw = await readBody(req, 1_000_000);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET])) throw new HttpError(400, 'Bad signature');
    const evt = JSON.parse(raw);
    const o = evt.data?.object;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(evt.type) && o?.payment_status === 'paid') {
      const pay = getPayment(o.client_reference_id || o.metadata?.payment_token || '');
      if (pay && (!evt.account || evt.account === pay.stripe_account_id)) markPaid(pay, 'card', o.id);
    } else if (evt.type === 'account.updated' && o?.id) {
      db.prepare(`UPDATE tenants SET stripe_charges_enabled = ?, stripe_details_submitted = ? WHERE stripe_account_id = ?`).run(o.charges_enabled ? 1 : 0, o.details_submitted ? 1 : 0, o.id);
    }
    send(res, 200, { received: true });
  });

  // ===== business dashboard =====
  route('GET', '/api/config', async (req, res, p, url, { tenant: t }) => {
    const pf = processingFee(db, t, 10000);
    send(res, 200, {
      stripe: { platform_ready: stripe.enabled, test_mode: stripe.testMode, account: t.stripe_account_id, charges_enabled: Boolean(t.stripe_charges_enabled), details_submitted: Boolean(t.stripe_details_submitted) },
      processing_fee: { bp: pf.bp, mode: pf.mode },
      sms_alerts: notify.smsEnabled && Boolean(t.notify_phone),
      settings: { tax_rate_bp: t.tax_rate_bp, deposit_cents: t.deposit_cents, deposit_label: t.deposit_label, terms: t.terms || '' },
    });
  }, { auth: 'tenant' });

  route('GET', '/api/requests', async (req, res, p, url, { tenant: t }) => {
    const f = url.searchParams.get('filter') || 'open';
    const where = f === 'new' ? `AND r.status = 'new'` : f === 'open' ? `AND r.status NOT IN ('paid','closed')` : '';
    const rows = db.prepare(`SELECT r.id, r.type, r.status, r.name, r.phone, r.location, r.rig, r.issue, r.preferred_date, r.photo IS NOT NULL AS has_photo, r.created_at, pr.name AS product_name
      FROM requests r LEFT JOIN products pr ON pr.id = r.product_id WHERE r.tenant_id = ? ${where} ORDER BY r.id DESC LIMIT 300`).all(t.id);
    const c = db.prepare(`SELECT SUM(status = 'new') AS n, SUM(status NOT IN ('paid','closed')) AS o, COUNT(*) AS a FROM requests WHERE tenant_id = ?`).get(t.id);
    send(res, 200, { rows, counts: { new: c.n || 0, open: c.o || 0, all: c.a || 0 } });
  }, { auth: 'tenant' });

  route('GET', '/api/requests/:id', async (req, res, p, url, { tenant: t }) => {
    const r = scoped('requests', p.id, t.id); if (!r) throw new HttpError(404, 'Not found');
    const quotes = db.prepare('SELECT * FROM quotes WHERE request_id = ? ORDER BY id DESC').all(r.id)
      .map((q) => ({ id: q.id, token: q.token, title: q.title, status: q.status, created_at: q.created_at, totals: quoteTotals(q, getItems(q.id)) }));
    const payments = db.prepare('SELECT * FROM payments WHERE request_id = ? ORDER BY id DESC').all(r.id);
    const product = r.product_id ? db.prepare('SELECT name, price_cents FROM products WHERE id = ?').get(r.product_id) : null;
    send(res, 200, { ...r, product, quotes, payments, deposit_paid_cents: paidDeposits(r.id) });
  }, { auth: 'tenant' });

  route('PATCH', '/api/requests/:id', async (req, res, p, url, { tenant: t }) => {
    const r = scoped('requests', p.id, t.id); if (!r) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const statuses = ['new', 'contacted', 'quoted', 'accepted', 'paid', 'closed'];
    db.prepare(`UPDATE requests SET status = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .run(statuses.includes(b.status) ? b.status : r.status, b.notes !== undefined ? clean(b.notes, 8000) : r.notes, now(), r.id);
    send(res, 200, scoped('requests', r.id, t.id));
  }, { auth: 'tenant' });

  route('POST', '/api/requests', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    const r = db.prepare(`INSERT INTO requests (tenant_id, type, status, name, phone, location, rig, issue) VALUES (?, 'repair', 'contacted', ?, ?, ?, ?, ?)`)
      .run(t.id, clean(b.name, 120), clean(b.phone, 40) || '-', clean(b.location, 1000) || '-', clean(b.rig, 200), clean(b.issue, 4000));
    send(res, 201, scoped('requests', Number(r.lastInsertRowid), t.id));
  }, { auth: 'tenant' });

  route('POST', '/api/requests/:id/deposit', async (req, res, p, url, { tenant: t }) => {
    const r = scoped('requests', p.id, t.id); if (!r) throw new HttpError(404, 'Not found');
    if (!t.deposit_cents) throw new HttpError(400, 'Set a deposit amount in Settings first.');
    const b = await json(req);
    const method = ['card', 'cash', 'check', 'other'].includes(b.method) ? b.method : 'card';
    const tok = randomToken();
    db.prepare(`INSERT INTO payments (tenant_id, token, kind, request_id, description, amount_cents, method) VALUES (?, ?, 'deposit', ?, ?, ?, ?)`)
      .run(t.id, tok, r.id, `${t.deposit_label} (credited toward the job)`, t.deposit_cents, method);
    if (method !== 'card') markPaid(getPayment(tok), method);
    setRequestStatus(r.id, 'contacted', ['new']);
    send(res, 201, { ...getPayment(tok), pay_url: `${baseUrl(req)}/pay/${tok}` });
  }, { auth: 'tenant' });

  route('GET', '/api/uploads/:file', async (req, res, p, url, { tenant: t }) => {
    const name = path.basename(p.file);
    if (!name.startsWith(`t${t.id}-`)) throw new HttpError(404, 'Not found');
    sendUpload(res, name);
  }, { auth: 'tenant' });

  // Products
  route('GET', '/api/products', async (req, res, p, url, { tenant: t }) => send(res, 200, db.prepare('SELECT * FROM products WHERE tenant_id = ? ORDER BY active DESC, name').all(t.id)), { auth: 'tenant' });
  route('POST', '/api/products', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    if (!clean(b.name)) throw new HttpError(400, 'Name is required.');
    const r = db.prepare(`INSERT INTO products (tenant_id, name, description, price_cents, taxable, on_site, bookable) VALUES (?,?,?,?,?,?,?)`)
      .run(t.id, clean(b.name, 200), clean(b.description, 1000), cents(b.price_cents), b.taxable ? 1 : 0, b.on_site ? 1 : 0, b.bookable ? 1 : 0);
    send(res, 201, scoped('products', Number(r.lastInsertRowid), t.id));
  }, { auth: 'tenant' });
  route('PATCH', '/api/products/:id', async (req, res, p, url, { tenant: t }) => {
    const cur = scoped('products', p.id, t.id); if (!cur) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : cur[k]);
    const flag = (v) => (v ? 1 : 0);
    db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, taxable = ?, active = ?, on_site = ?, bookable = ? WHERE id = ?`).run(
      pick('name', (v) => clean(v, 200) || cur.name), pick('description', (v) => clean(v, 1000)), pick('price_cents', cents),
      pick('taxable', flag), pick('active', flag), pick('on_site', flag), pick('bookable', flag), cur.id);
    send(res, 200, scoped('products', cur.id, t.id));
  }, { auth: 'tenant' });

  // Quotes
  route('GET', '/api/quotes', async (req, res, p, url, { tenant: t }) => {
    send(res, 200, db.prepare('SELECT * FROM quotes WHERE tenant_id = ? ORDER BY id DESC LIMIT 300').all(t.id).map((q) => ({
      id: q.id, title: q.title, status: q.status, customer_name: q.customer_name, created_at: q.created_at, request_id: q.request_id, totals: quoteTotals(q, getItems(q.id)),
    })));
  }, { auth: 'tenant' });

  route('POST', '/api/quotes', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    const r = b.request_id ? scoped('requests', b.request_id, t.id) : null;
    const product = r?.product_id ? scoped('products', r.product_id, t.id) : null;
    const ins = db.prepare(`INSERT INTO quotes (tenant_id, token, request_id, title, customer_name, customer_phone, customer_email, location, rig, terms, tax_rate_bp, deposit_credit_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.id, randomToken(), r?.id ?? null, product ? product.name : 'Repair proposal', r?.name || '', r?.phone || '', r?.email || '', r?.location || '', r?.rig || '', t.terms || '', t.tax_rate_bp, paidDeposits(r?.id));
    const qid = Number(ins.lastInsertRowid);
    if (product) db.prepare(`INSERT INTO quote_items (quote_id, product_id, name, description, qty, unit_cents, taxable) VALUES (?,?,?,?,1,?,?)`).run(qid, product.id, product.name, product.description, product.price_cents, product.taxable);
    setRequestStatus(r?.id, 'quoted', ['new', 'contacted']);
    send(res, 201, quoteFull(scoped('quotes', qid, t.id)));
  }, { auth: 'tenant' });

  route('GET', '/api/quotes/:id', async (req, res, p, url, { tenant: t }) => {
    const q = scoped('quotes', p.id, t.id); if (!q) throw new HttpError(404, 'Not found');
    send(res, 200, { ...quoteFull(q), proposal_url: `${baseUrl(req)}/p/${q.token}`, online: onlineQuote(t, quoteTotals(q, getItems(q.id)).balance) });
  }, { auth: 'tenant' });

  route('PUT', '/api/quotes/:id', async (req, res, p, url, { tenant: t }) => {
    const q = scoped('quotes', p.id, t.id); if (!q) throw new HttpError(404, 'Not found');
    if (q.signed_at || q.status === 'paid') throw new HttpError(409, 'This quote is signed, so it can’t be changed. Make a new quote instead.');
    const b = await json(req);
    db.prepare(`UPDATE quotes SET title = ?, customer_name = ?, customer_phone = ?, customer_email = ?, location = ?, rig = ?, notes = ?, terms = ?, tax_rate_bp = ?, updated_at = ? WHERE id = ?`).run(
      clean(b.title, 200) || 'Repair proposal', clean(b.customer_name, 120), clean(b.customer_phone, 40), clean(b.customer_email, 200),
      clean(b.location, 1000), clean(b.rig, 200), clean(b.notes, 4000), clean(b.terms, 4000), Math.min(3000, cents(b.tax_rate_bp)), now(), q.id);
    db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(q.id);
    const ins = db.prepare(`INSERT INTO quote_items (quote_id, product_id, name, description, qty, unit_cents, taxable, sort) VALUES (?,?,?,?,?,?,?,?)`);
    (Array.isArray(b.items) ? b.items : []).slice(0, 100).forEach((it, i) => {
      if (!clean(it.name)) return;
      const pid = it.product_id && scoped('products', it.product_id, t.id) ? it.product_id : null;
      ins.run(q.id, pid, clean(it.name, 200), clean(it.description, 1000), Math.max(0, Math.min(10000, Number(it.qty) || 0)), cents(it.unit_cents), it.taxable ? 1 : 0, i);
    });
    refreshCredits(q.request_id);
    const fresh = scoped('quotes', q.id, t.id);
    send(res, 200, { ...quoteFull(fresh), proposal_url: `${baseUrl(req)}/p/${q.token}`, online: onlineQuote(t, quoteTotals(fresh, getItems(q.id)).balance) });
  }, { auth: 'tenant' });

  route('POST', '/api/quotes/:id/status', async (req, res, p, url, { tenant: t }) => {
    const q = scoped('quotes', p.id, t.id); if (!q) throw new HttpError(404, 'Not found');
    const b = await json(req);
    if (b.status === 'void' && q.status !== 'paid') db.prepare(`UPDATE quotes SET status = 'void', updated_at = ? WHERE id = ?`).run(now(), q.id);
    else if (b.status === 'draft' && q.status === 'void' && !q.signed_at) db.prepare(`UPDATE quotes SET status = 'draft', updated_at = ? WHERE id = ?`).run(now(), q.id);
    send(res, 200, quoteFull(scoped('quotes', q.id, t.id)));
  }, { auth: 'tenant' });

  route('POST', '/api/quotes/:id/payments', async (req, res, p, url, { tenant: t }) => {
    const q = scoped('quotes', p.id, t.id); if (!q) throw new HttpError(404, 'Not found');
    if (q.status === 'paid') throw new HttpError(409, 'Already paid.');
    const b = await json(req);
    const method = ['cash', 'check', 'other'].includes(b.method) ? b.method : 'cash';
    const { balance } = quoteTotals(q, getItems(q.id));
    const tok = randomToken();
    db.prepare(`INSERT INTO payments (tenant_id, token, kind, quote_id, request_id, description, amount_cents, method) VALUES (?, ?, 'quote', ?, ?, ?, ?, ?)`)
      .run(t.id, tok, q.id, q.request_id, `${q.title} (#${q.id})`, balance, method);
    markPaid(getPayment(tok), method);
    send(res, 200, quoteFull(scoped('quotes', q.id, t.id)));
  }, { auth: 'tenant' });

  route('PUT', '/api/settings', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    db.prepare(`UPDATE tenants SET tax_rate_bp = ?, deposit_cents = ?, deposit_label = ?, terms = ? WHERE id = ?`).run(
      b.tax_rate_bp !== undefined ? Math.min(3000, cents(b.tax_rate_bp)) : t.tax_rate_bp,
      b.deposit_cents !== undefined ? cents(b.deposit_cents) : t.deposit_cents,
      b.deposit_label !== undefined ? clean(b.deposit_label, 120) || 'Deposit' : t.deposit_label,
      b.terms !== undefined ? clean(b.terms, 4000) : t.terms, t.id);
    send(res, 200, { ok: true });
  }, { auth: 'owner' });

  // Business profile, brand and website
  route('GET', '/api/business', async (req, res, p, url, { tenant: t }) => {
    send(res, 200, { ...publicTenant(t), site_url: `${baseUrl(req)}/s/${t.slug}`, intake_url: `${baseUrl(req)}/api/public/t/${t.slug}/requests` });
  }, { auth: 'tenant' });
  route('PUT', '/api/business', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    const v = (k, max) => (b[k] !== undefined ? clean(b[k], max) : t[k]);
    let domain = b.custom_domain !== undefined ? clean(b.custom_domain, 200).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : t.custom_domain;
    if (domain && db.prepare('SELECT 1 FROM tenants WHERE custom_domain = ? AND id != ?').get(domain, t.id)) throw new HttpError(409, 'That domain is already used by another business.');
    db.prepare(`UPDATE tenants SET name = ?, phone = ?, email = ?, notify_phone = ?, tagline = ?, hero_headline = ?, about = ?, service_area = ?, primary_color = ?, accent_color = ?, website_url = ?, custom_domain = ? WHERE id = ?`).run(
      v('name', 120) || t.name, v('phone', 40), v('email', 200), v('notify_phone', 40), v('tagline', 300), v('hero_headline', 200), v('about', 6000), v('service_area', 400),
      hexColor(b.primary_color, t.primary_color), hexColor(b.accent_color, t.accent_color), v('website_url', 300), domain || null, t.id);
    send(res, 200, publicTenant(getTenant(t.id)));
  }, { auth: 'owner' });
  route('POST', '/api/business/image', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req, 12_000_000);
    if (!['logo', 'owner_photo'].includes(b.kind)) throw new HttpError(400, 'Unknown image.');
    const name = b.image ? saveImage(b.image, `t${t.id}-brand`, 8_000_000) : null;
    if (b.image && !name) throw new HttpError(400, 'Use a JPG, PNG or WebP image.');
    db.prepare(`UPDATE tenants SET ${b.kind} = ? WHERE id = ?`).run(name, t.id);
    send(res, 200, publicTenant(getTenant(t.id)));
  }, { auth: 'owner' });

  // Team
  route('GET', '/api/team', async (req, res, p, url, { tenant: t }) => {
    send(res, 200, db.prepare('SELECT id, name, email, role, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY id').all(t.id));
  }, { auth: 'tenant' });
  route('POST', '/api/team', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    const email = clean(b.email, 200).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email.');
    if (String(b.password || '').length < 10) throw new HttpError(400, 'Use a temporary password of at least 10 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email already has an account.');
    db.prepare(`INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES (?,?,?,?, 'staff')`).run(t.id, email, clean(b.name, 120), hashPassword(b.password));
    send(res, 201, { ok: true });
  }, { auth: 'owner' });
  route('DELETE', '/api/team/:id', async (req, res, p, url, { tenant: t }) => {
    const u = db.prepare(`SELECT * FROM users WHERE id = ? AND tenant_id = ? AND role = 'staff'`).get(p.id, t.id);
    if (!u) throw new HttpError(404, 'Not found');
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    send(res, 200, { ok: true });
  }, { auth: 'owner' });

  // Stripe Connect onboarding for the business
  route('POST', '/api/stripe/connect', async (req, res, p, url, { tenant: t, user }) => {
    if (!stripe.enabled) throw new HttpError(503, 'Online payments aren’t switched on for the platform yet. Contact support.');
    let acct = t.stripe_account_id;
    if (!acct) {
      acct = (await stripe.createAccount({ email: t.email || user.email, businessName: t.name, tenantId: t.id })).id;
      db.prepare('UPDATE tenants SET stripe_account_id = ? WHERE id = ?').run(acct, t.id);
    }
    const link = await stripe.accountLink({ account: acct, refreshUrl: `${baseUrl(req)}/admin/#/settings/stripe-refresh`, returnUrl: `${baseUrl(req)}/admin/#/settings/stripe-return` });
    send(res, 200, { url: link.url });
  }, { auth: 'owner' });
  route('POST', '/api/stripe/refresh', async (req, res, p, url, { tenant: t }) => {
    const fresh = await refreshStripeStatus(t);
    send(res, 200, { charges_enabled: Boolean(fresh.stripe_charges_enabled), details_submitted: Boolean(fresh.stripe_details_submitted) });
  }, { auth: 'tenant' });

  // ===== Agilities super admin =====
  route('GET', '/api/super/overview', async (req, res) => {
    const month = new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT t.id, t.slug, t.name, t.status, t.created_at, t.stripe_account_id, t.stripe_charges_enabled, t.fee_bp, t.fee_mode, t.custom_domain,
        (SELECT email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner_email,
        (SELECT MAX(last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_login_at,
        (SELECT COUNT(*) FROM requests r WHERE r.tenant_id = t.id) AS requests,
        (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid') AS paid_cents,
        (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid' AND p.method = 'card') AS online_cents,
        (SELECT COALESCE(SUM(fee_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid') AS fee_cents,
        (SELECT COALESCE(SUM(fee_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid' AND substr(p.paid_at,1,7) = ?) AS fee_month_cents
      FROM tenants t ORDER BY t.id DESC`).all(month);
    const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    send(res, 200, {
      platform: { ...platformSettings(db), stripe_ready: stripe.enabled, test_mode: stripe.testMode, sms: notify.smsEnabled, email: notify.emailEnabled },
      totals: { businesses: rows.length, active: rows.filter((r) => r.status === 'active').length, paid_cents: sum('paid_cents'), online_cents: sum('online_cents'), fee_cents: sum('fee_cents'), fee_month_cents: sum('fee_month_cents') },
      tenants: rows,
    });
  }, { auth: 'super' });

  route('GET', '/api/super/tenants/:id', async (req, res, p) => {
    const t = getTenant(p.id); if (!t) throw new HttpError(404, 'Not found');
    send(res, 200, {
      tenant: publicTenant(t), fee_bp: t.fee_bp, fee_mode: t.fee_mode, site_url: `${baseUrl(req)}/s/${t.slug}`,
      users: db.prepare('SELECT id, name, email, role, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY id').all(t.id),
      agreements: db.prepare('SELECT a.doc, a.version, a.accepted_at, a.ip, u.email FROM agreements a LEFT JOIN users u ON u.id = a.user_id WHERE a.tenant_id = ? ORDER BY a.id DESC').all(t.id),
      payments: db.prepare(`SELECT id, kind, description, amount_cents, fee_cents, fee_mode, method, status, paid_at, created_at FROM payments WHERE tenant_id = ? ORDER BY id DESC LIMIT 100`).all(t.id),
    });
  }, { auth: 'super' });

  route('POST', '/api/super/tenants', async (req, res) => {
    const b = await json(req);
    const business = clean(b.business_name, 120), email = clean(b.owner_email, 200).toLowerCase();
    if (!business || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Business name and owner email are required.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email already has an account.');
    const t = db.prepare(`INSERT INTO tenants (slug, name, email, phone, notify_phone) VALUES (?,?,?,?,?)`).run(uniqueSlug(business), business, email, clean(b.phone, 40), clean(b.phone, 40));
    const tid = Number(t.lastInsertRowid);
    const u = db.prepare(`INSERT INTO users (tenant_id, email, name, password_hash, role) VALUES (?,?,?,?, 'owner')`).run(tid, email, clean(b.owner_name, 120), hashPassword(randomToken(24)));
    const tok = randomToken(24);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(tok), Number(u.lastInsertRowid), Date.now() + 7 * 864e5);
    send(res, 201, { tenant: publicTenant(getTenant(tid)), setup_link: `${baseUrl(req)}/admin/#/reset/${tok}` });
  }, { auth: 'super' });

  route('PATCH', '/api/super/tenants/:id', async (req, res, p) => {
    const t = getTenant(p.id); if (!t) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const status = ['active', 'suspended'].includes(b.status) ? b.status : t.status;
    const feeBp = b.fee_bp === null || b.fee_bp === '' ? null : b.fee_bp !== undefined ? Math.min(1000, cents(b.fee_bp)) : t.fee_bp;
    const feeMode = b.fee_mode === null || b.fee_mode === '' ? null : ['customer', 'absorbed', 'off'].includes(b.fee_mode) ? b.fee_mode : t.fee_mode;
    const acct = b.stripe_account_id !== undefined ? (clean(b.stripe_account_id, 80) || null) : t.stripe_account_id;
    if (acct && !/^acct_[A-Za-z0-9]+$/.test(acct)) throw new HttpError(400, 'Stripe account IDs look like acct_123…');
    db.prepare('UPDATE tenants SET status = ?, fee_bp = ?, fee_mode = ?, stripe_account_id = ? WHERE id = ?').run(status, feeBp, feeMode, acct, t.id);
    let fresh = getTenant(t.id);
    if (acct && acct !== t.stripe_account_id) fresh = await refreshStripeStatus(fresh).catch(() => fresh);
    send(res, 200, publicTenant(fresh));
  }, { auth: 'super' });

  route('POST', '/api/super/view-as', async (req, res, p, url, ctx) => {
    const b = await json(req);
    const tid = Number(b.tenant_id) || 0;
    if (tid && !getTenant(tid)) throw new HttpError(404, 'Not found');
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, sess.create(ctx.user.id, tid), sess.maxAge) });
  }, { auth: 'super' });

  route('POST', '/api/super/users/:id/reset-link', async (req, res, p) => {
    const u = getUser(p.id); if (!u || u.role === 'super') throw new HttpError(404, 'Not found');
    const tok = randomToken(24);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha256(tok), u.id, Date.now() + 7 * 864e5);
    send(res, 200, { link: `${baseUrl(req)}/admin/#/reset/${tok}`, email: u.email });
  }, { auth: 'super' });

  route('PUT', '/api/super/settings', async (req, res) => {
    const b = await json(req);
    const set = db.prepare(`INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?, ?)`);
    if (b.fee_bp !== undefined) set.run('fee_bp', String(Math.min(1000, cents(b.fee_bp))));
    if (['customer', 'absorbed', 'off'].includes(b.fee_mode)) set.run('fee_mode', b.fee_mode);
    send(res, 200, platformSettings(db));
  }, { auth: 'super' });

  route('GET', '/api/super/fees.csv', async (req, res) => {
    const rows = db.prepare(`SELECT p.paid_at, t.name AS business, p.description, p.amount_cents, p.fee_cents, p.fee_mode, p.stripe_session_id FROM payments p JOIN tenants t ON t.id = p.tenant_id WHERE p.status = 'paid' AND p.fee_cents > 0 ORDER BY p.paid_at DESC`).all();
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['Paid at,Business,Description,Amount,Processing Fee,Fee mode,Stripe checkout'].concat(rows.map((r) => [r.paid_at, r.business, r.description, (r.amount_cents / 100).toFixed(2), (r.fee_cents / 100).toFixed(2), r.fee_mode, r.stripe_session_id].map(q).join(','))).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="processing-fees.csv"', 'Cache-Control': 'no-store' });
    res.end(csv);
  }, { auth: 'super' });

  // ---------- static pages ----------
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
  };
  function serveFile(res, file) {
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...securityHeaders });
    fs.createReadStream(full).pipe(res);
    return true;
  }
  function serveSite(res, t) {
    if (!t || t.status !== 'active') throw new HttpError(404, 'Not found');
    const products = db.prepare('SELECT * FROM products WHERE tenant_id = ? AND active = 1 ORDER BY bookable DESC, price_cents DESC, name').all(t.id);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...securityHeaders });
    res.end(renderSite(t, products));
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Access-Control-Max-Age', '86400');
          return send(res, 204, '');
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(pathname); if (!m) continue;
          // Public intake is called from businesses' own websites; it never uses cookies.
          if (r.cors) res.setHeader('Access-Control-Allow-Origin', '*');
          const ctx = context(req);
          if (r.auth) {
            if (!ctx) throw new HttpError(401, 'Please log in.');
            if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Forbidden');
            if (r.auth === 'super' && !ctx.isSuper) throw new HttpError(403, 'Forbidden');
            if (r.auth === 'tenant' || r.auth === 'owner') {
              if (!ctx.tenant) throw new HttpError(ctx.isSuper ? 409 : 403, ctx.isSuper ? 'Choose a business to view first.' : 'Forbidden');
              if (!ctx.isSuper && ctx.tenant.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact support.');
              if (!ctx.isSuper && needsAgreements(ctx.user)) throw new HttpError(428, 'Please accept the updated agreements.');
              if (r.auth === 'owner' && !ctx.isSuper && ctx.user.role !== 'owner') throw new HttpError(403, 'Only the business owner can change this.');
            }
          }
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          return await r.handler(req, res, params, url, ctx);
        }
        throw new HttpError(404, 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

      const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      const domainTenant = host ? db.prepare('SELECT * FROM tenants WHERE custom_domain = ?').get(host) : null;
      if (pathname === '/') {
        if (domainTenant) return serveSite(res, domainTenant);
        res.writeHead(302, { Location: '/admin/' }); return res.end();
      }
      if (pathname === '/healthz') return send(res, 200, 'ok');
      if (pathname === '/admin' || pathname === '/admin/') return serveFile(res, 'admin.html');
      if (pathname === '/signup') { res.writeHead(302, { Location: '/admin/#/signup' }); return res.end(); }
      let m;
      if ((m = /^\/s\/([\w-]+)\/?$/.exec(pathname))) return serveSite(res, getTenantBySlug(m[1]));
      if ((m = /^\/media\/([\w-]+)\/([\w.-]+)$/.exec(pathname))) {
        const t = getTenantBySlug(m[1]);
        if (!t || !m[2].startsWith(`t${t.id}-brand-`) || ![t.logo, t.owner_photo].includes(m[2])) throw new HttpError(404, 'Not found');
        return sendUpload(res, m[2]);
      }
      if ((m = /^\/legal\/(terms|privacy|payment-terms|customer-terms)$/.exec(pathname)) && serveFile(res, `legal/${m[1]}.html`)) return;
      if (/^\/p\/[\w-]+$/.test(pathname)) return serveFile(res, 'proposal.html');
      if (/^\/pay\/[\w-]+$/.test(pathname)) return serveFile(res, 'pay.html');
      if (pathname.startsWith('/static/') && serveFile(res, pathname.slice(8))) return;
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong. Try again.' : e.message });
      else res.end();
    }
  }

  return { handler, db };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { handler } = createApp();
  const port = Number(process.env.PORT || 3000);
  http.createServer(handler).listen(port, () => console.log(`Listening on http://localhost:${port}`));
}
