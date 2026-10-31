import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, getSettings, quoteTotals } from './src/db.js';
import { stripeClient, verifyStripeSignature } from './src/stripe.js';
import { notifier } from './src/notify.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

export function createApp(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const db = openDb(dataDir);
  const uploads = path.join(dataDir, 'uploads');
  const stripe = stripeClient(env);
  const notify = notifier(env);
  const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  // Session secret: from env, else generated once and kept in the database.
  let secret = env.SESSION_SECRET;
  if (!secret) {
    secret = db.prepare(`SELECT value FROM settings WHERE key = 'session_secret'`).get()?.value;
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      db.prepare(`INSERT INTO settings (key, value) VALUES ('session_secret', ?)`).run(secret);
    }
  }

  // ---------- helpers ----------
  const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const token = (n = 18) => crypto.randomBytes(n).toString('base64url');
  const clean = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
  const cents = (v) => Math.max(0, Math.round(Number(v) || 0));

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
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

  function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  }

  // Simple fixed-window rate limiter.
  const buckets = new Map();
  function limited(key, max, windowMs) {
    const t = Date.now(); const b = buckets.get(key);
    if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowMs }); return false; }
    b.n += 1; return b.n > max;
  }

  // ---------- auth ----------
  const SESSION_DAYS = 30;
  function sign(v) { return crypto.createHmac('sha256', secret).update(v).digest('base64url'); }
  function sessionCookie(req) {
    const exp = Date.now() + SESSION_DAYS * 864e5;
    const val = `${exp}.${sign(String(exp))}`;
    const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
    return `sid=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`;
  }
  function isAuthed(req) {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return false;
    const [exp, sig] = m[1].split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const good = sign(exp);
    return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
  }
  function passwordOk(pw) {
    if (!env.ADMIN_PASSWORD) return false;
    const a = crypto.createHash('sha256').update(String(pw)).digest();
    const b = crypto.createHash('sha256').update(env.ADMIN_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // ---------- data access ----------
  const getRequest = (id) => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  const getQuote = (id) => db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  const getQuoteByToken = (t) => db.prepare('SELECT * FROM quotes WHERE token = ?').get(t);
  const getItems = (qid) => db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort, id').all(qid);
  const getPayment = (t) => db.prepare('SELECT * FROM payments WHERE token = ?').get(t);

  function setRequestStatus(id, status, onlyFrom) {
    if (!id) return;
    const r = getRequest(id); if (!r) return;
    if (onlyFrom && !onlyFrom.includes(r.status)) return;
    db.prepare(`UPDATE requests SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
  }

  function paidDeposits(requestId) {
    if (!requestId) return 0;
    return db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE request_id = ? AND kind = 'deposit' AND status = 'paid'`).get(requestId).s;
  }

  // Open (unpaid) quotes pick up any paid diagnosis deposit as a credit.
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
    db.prepare(`UPDATE payments SET status = 'paid', paid_at = ?, method = ?, stripe_session_id = COALESCE(?, stripe_session_id) WHERE id = ?`)
      .run(now(), method, sessionId || null, payment.id);
    if (payment.kind === 'deposit') {
      refreshCredits(payment.request_id);
      notify.sms(`$${(payment.amount_cents / 100).toFixed(2)} diagnosis deposit paid (request #${payment.request_id}).`);
    } else if (payment.quote_id) {
      db.prepare(`UPDATE quotes SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), payment.quote_id);
      const q = getQuote(payment.quote_id);
      setRequestStatus(q?.request_id, 'paid');
      notify.sms(`Payment received: $${(payment.amount_cents / 100).toFixed(2)} for quote #${payment.quote_id} (${q?.customer_name || 'customer'}).`);
    }
  }

  function saveImage(dataUrl, prefix, maxBytes) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > maxBytes) throw new HttpError(413, 'That photo is too large.');
    const name = `${prefix}-${token(12)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(uploads, name), buf);
    return name;
  }

  // ---------- Stripe checkout ----------
  async function startCheckout(req, payment, { successPath, cancelPath, email }) {
    if (!stripe.enabled) throw new HttpError(503, 'Card payments aren’t set up yet. Please pay Mike directly.');
    const base = baseUrl(req);
    const sep = successPath.includes('?') ? '&' : '?';
    const session = await stripe.createCheckout({
      amountCents: payment.amount_cents,
      name: payment.description,
      successUrl: `${base}${successPath}${sep}paid=${payment.token}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}${cancelPath}`,
      ref: payment.token,
      email,
    });
    db.prepare(`UPDATE payments SET stripe_session_id = ? WHERE id = ?`).run(session.id, payment.id);
    return session.url;
  }

  async function confirmCheckout(payment, sessionId) {
    if (payment.status === 'paid') return true;
    if (!sessionId || !stripe.enabled) return false;
    const s = await stripe.retrieveCheckout(sessionId);
    if (s.client_reference_id !== payment.token) return false;
    if (s.payment_status === 'paid') { markPaid(payment, 'card', s.id); return true; }
    return false;
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };

  // Public: intake from the website forms.
  route('POST', '/api/public/requests', async (req, res) => {
    if (limited('intake:' + clientIp(req), 20, 3600_000)) throw new HttpError(429, 'Too many requests. Please call or text Mike.');
    const b = await json(req, 12_000_000);
    if (b.website) return send(res, 201, { ok: true }); // honeypot
    const type = b.type === 'winterize' ? 'winterize' : 'repair';
    const phone = clean(b.phone, 40), location = clean(b.location, 1000);
    if (!phone || !location) throw new HttpError(400, 'Location and phone are required.');
    const rig = clean(b.rig, 200) || [b.year, b.make, b.model].map((v) => clean(v, 80)).filter(Boolean).join(' ');
    const photo = b.photo ? saveImage(b.photo, 'req', 8_000_000) : null;
    const r = db.prepare(`INSERT INTO requests (type, name, phone, email, location, rig, issue, preferred_date, photo) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(type, clean(b.name, 120), phone, clean(b.email, 200), location, rig, clean(b.issue, 4000), clean(b.preferred_date, 40), photo);
    const id = Number(r.lastInsertRowid);
    notify.sms(`New ${type === 'winterize' ? 'WINTERIZING booking' : 'REPAIR request'} from ${clean(b.name, 60) || 'customer'} ${phone}\n${location.slice(0, 200)}\n${rig}\n${baseUrl(req)}/admin#/requests/${id}`);
    send(res, 201, { ok: true, id });
  }, { cors: true });

  // Public: proposal view / sign / pay.
  route('GET', '/api/public/proposals/:token', async (req, res, p) => {
    const q = getQuoteByToken(p.token);
    if (!q || q.status === 'void') throw new HttpError(404, 'This proposal isn’t available.');
    if (q.status === 'draft') db.prepare(`UPDATE quotes SET status = 'sent', updated_at = ? WHERE id = ?`).run(now(), q.id);
    const full = quoteFull(getQuote(q.id));
    send(res, 200, {
      id: full.id, title: full.title, status: full.status, customer_name: full.customer_name, location: full.location, rig: full.rig,
      notes: full.notes, terms: full.terms, tax_rate_bp: full.tax_rate_bp, created_at: full.created_at,
      items: full.items.map(({ name, description, qty, unit_cents, taxable }) => ({ name, description, qty, unit_cents, taxable })),
      totals: full.totals, signer_name: full.signer_name, signature_png: full.signature_png, signed_at: full.signed_at, paid_at: full.paid_at,
      card_payments: stripe.enabled,
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
    const t = now();
    db.prepare(`UPDATE quotes SET status = 'signed', signer_name = ?, signature_png = ?, signer_ip = ?, signer_ua = ?, signed_at = ?, updated_at = ? WHERE id = ?`)
      .run(name, b.signature, clientIp(req), clean(req.headers['user-agent'], 400), t, t, q.id);
    setRequestStatus(q.request_id, 'accepted');
    notify.sms(`Proposal #${q.id} signed by ${name}.`);
    send(res, 200, { ok: true });
  });

  route('POST', '/api/public/proposals/:token/checkout', async (req, res, p) => {
    const q = getQuoteByToken(p.token);
    if (!q || q.status === 'void') throw new HttpError(404, 'This proposal isn’t available.');
    if (!q.signed_at) throw new HttpError(409, 'Please sign the proposal first.');
    if (q.status === 'paid') throw new HttpError(409, 'This proposal is already paid.');
    const { balance } = quoteTotals(q, getItems(q.id));
    if (balance < 50) throw new HttpError(409, 'Nothing is due on this proposal.');
    // Reuse a pending card payment for the same amount, else create one.
    let pay = db.prepare(`SELECT * FROM payments WHERE quote_id = ? AND status = 'pending' AND amount_cents = ? ORDER BY id DESC`).get(q.id, balance);
    if (!pay) {
      const t = token();
      db.prepare(`INSERT INTO payments (token, kind, quote_id, request_id, description, amount_cents, method) VALUES (?, 'quote', ?, ?, ?, ?, 'card')`)
        .run(t, q.id, q.request_id, `${q.title} (#${q.id})`, balance);
      pay = getPayment(t);
    }
    const url = await startCheckout(req, pay, { successPath: `/p/${q.token}`, cancelPath: `/p/${q.token}`, email: q.customer_email });
    send(res, 200, { url });
  });

  // Public: standalone payment page (diagnosis deposit).
  route('GET', '/api/public/payments/:token', async (req, res, p) => {
    const pay = getPayment(p.token);
    if (!pay) throw new HttpError(404, 'This payment link isn’t valid.');
    send(res, 200, { description: pay.description, amount_cents: pay.amount_cents, status: pay.status, kind: pay.kind, paid_at: pay.paid_at, card_payments: stripe.enabled });
  });

  route('POST', '/api/public/payments/:token/checkout', async (req, res, p) => {
    const pay = getPayment(p.token);
    if (!pay) throw new HttpError(404, 'This payment link isn’t valid.');
    if (pay.status === 'paid') throw new HttpError(409, 'This is already paid.');
    const r = pay.request_id ? getRequest(pay.request_id) : null;
    const url = await startCheckout(req, pay, { successPath: `/pay/${pay.token}`, cancelPath: `/pay/${pay.token}`, email: r?.email });
    send(res, 200, { url });
  });

  route('POST', '/api/public/payments/:token/confirm', async (req, res, p) => {
    const pay = getPayment(p.token);
    if (!pay) throw new HttpError(404, 'Payment not found.');
    const b = await json(req);
    const paid = await confirmCheckout(pay, clean(b.session_id, 200));
    send(res, 200, { paid });
  });

  // Stripe webhook (backup to the return-page confirmation, and needed for bank payments).
  route('POST', '/api/stripe/webhook', async (req, res) => {
    const raw = await readBody(req, 1_000_000);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET)) throw new HttpError(400, 'Bad signature');
    const evt = JSON.parse(raw);
    const s = evt.data?.object;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(evt.type) && s?.payment_status === 'paid') {
      const pay = getPayment(s.client_reference_id || s.metadata?.payment_token || '');
      if (pay) markPaid(pay, 'card', s.id);
    }
    send(res, 200, { received: true });
  });

  // ----- admin -----
  route('POST', '/api/login', async (req, res) => {
    if (limited('login:' + clientIp(req), 10, 900_000)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
    const b = await json(req);
    if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'ADMIN_PASSWORD is not set on the server.');
    if (!passwordOk(b.password || '')) throw new HttpError(401, 'Wrong password.');
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req) });
  });
  route('POST', '/api/logout', async (req, res) => send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }));
  route('GET', '/api/me', async (req, res) => send(res, 200, { authed: isAuthed(req) }));

  route('GET', '/api/config', async (req, res) => send(res, 200, {
    stripe: { enabled: stripe.enabled, test_mode: stripe.testMode, connected_account: stripe.connected, webhook: Boolean(env.STRIPE_WEBHOOK_SECRET) },
    sms_alerts: notify.enabled,
    settings: getSettings(db),
  }), { auth: true });

  route('GET', '/api/requests', async (req, res, p, url) => {
    const f = url.searchParams.get('filter') || 'open';
    const where = f === 'new' ? `WHERE status = 'new'` : f === 'open' ? `WHERE status NOT IN ('paid','closed')` : '';
    const rows = db.prepare(`SELECT id, type, status, name, phone, location, rig, issue, preferred_date, photo IS NOT NULL AS has_photo, created_at FROM requests ${where} ORDER BY id DESC LIMIT 300`).all();
    const counts = db.prepare(`SELECT SUM(status = 'new') AS new, SUM(status NOT IN ('paid','closed')) AS open, COUNT(*) AS all_ FROM requests`).get();
    send(res, 200, { rows, counts: { new: counts.new || 0, open: counts.open || 0, all: counts.all_ || 0 } });
  }, { auth: true });

  route('GET', '/api/requests/:id', async (req, res, p) => {
    const r = getRequest(p.id); if (!r) throw new HttpError(404, 'Not found');
    const quotes = db.prepare('SELECT id, token, title, status, created_at FROM quotes WHERE request_id = ? ORDER BY id DESC').all(r.id)
      .map((q) => ({ ...q, totals: quoteTotals(getQuote(q.id), getItems(q.id)) }));
    const payments = db.prepare('SELECT * FROM payments WHERE request_id = ? ORDER BY id DESC').all(r.id);
    send(res, 200, { ...r, quotes, payments, deposit_paid_cents: paidDeposits(r.id) });
  }, { auth: true });

  route('PATCH', '/api/requests/:id', async (req, res, p) => {
    const r = getRequest(p.id); if (!r) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const statuses = ['new', 'contacted', 'quoted', 'accepted', 'paid', 'closed'];
    const status = statuses.includes(b.status) ? b.status : r.status;
    const notes = b.notes !== undefined ? clean(b.notes, 8000) : r.notes;
    db.prepare(`UPDATE requests SET status = ?, notes = ?, updated_at = ? WHERE id = ?`).run(status, notes, now(), r.id);
    send(res, 200, getRequest(r.id));
  }, { auth: true });

  // New request entered by Mike (phone call, walk-up).
  route('POST', '/api/requests', async (req, res) => {
    const b = await json(req);
    const r = db.prepare(`INSERT INTO requests (type, status, name, phone, location, rig, issue) VALUES (?, 'contacted', ?, ?, ?, ?, ?)`)
      .run(b.type === 'winterize' ? 'winterize' : 'repair', clean(b.name, 120), clean(b.phone, 40) || '-', clean(b.location, 1000) || '-', clean(b.rig, 200), clean(b.issue, 4000));
    send(res, 201, getRequest(Number(r.lastInsertRowid)));
  }, { auth: true });

  route('POST', '/api/requests/:id/deposit', async (req, res, p) => {
    const r = getRequest(p.id); if (!r) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const method = ['card', 'cash', 'check', 'other'].includes(b.method) ? b.method : 'card';
    const amount = getSettings(db).deposit_cents;
    const t = token();
    db.prepare(`INSERT INTO payments (token, kind, request_id, description, amount_cents, method) VALUES (?, 'deposit', ?, ?, ?, ?)`)
      .run(t, r.id, 'Repair diagnosis and onsite review (credited toward the job)', amount, method);
    const pay = getPayment(t);
    if (method !== 'card') markPaid(pay, method);
    setRequestStatus(r.id, 'contacted', ['new']);
    send(res, 201, { ...getPayment(t), pay_url: `${baseUrl(req)}/pay/${t}` });
  }, { auth: true });

  route('GET', '/api/uploads/:file', async (req, res, p) => {
    const name = path.basename(p.file);
    const file = path.join(uploads, name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Not found');
    const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[name.split('.').pop()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  }, { auth: true });

  // Products
  route('GET', '/api/products', async (req, res) => send(res, 200, db.prepare('SELECT * FROM products ORDER BY active DESC, name').all()), { auth: true });
  route('POST', '/api/products', async (req, res) => {
    const b = await json(req);
    if (!clean(b.name)) throw new HttpError(400, 'Name is required.');
    const r = db.prepare(`INSERT INTO products (name, description, price_cents, taxable) VALUES (?,?,?,?)`).run(clean(b.name, 200), clean(b.description, 1000), cents(b.price_cents), b.taxable ? 1 : 0);
    send(res, 201, db.prepare('SELECT * FROM products WHERE id = ?').get(Number(r.lastInsertRowid)));
  }, { auth: true });
  route('PATCH', '/api/products/:id', async (req, res, p) => {
    const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(p.id); if (!cur) throw new HttpError(404, 'Not found');
    const b = await json(req);
    db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, taxable = ?, active = ? WHERE id = ?`).run(
      b.name !== undefined ? clean(b.name, 200) || cur.name : cur.name,
      b.description !== undefined ? clean(b.description, 1000) : cur.description,
      b.price_cents !== undefined ? cents(b.price_cents) : cur.price_cents,
      b.taxable !== undefined ? (b.taxable ? 1 : 0) : cur.taxable,
      b.active !== undefined ? (b.active ? 1 : 0) : cur.active, cur.id);
    send(res, 200, db.prepare('SELECT * FROM products WHERE id = ?').get(cur.id));
  }, { auth: true });

  // Quotes
  route('GET', '/api/quotes', async (req, res) => {
    const rows = db.prepare('SELECT * FROM quotes ORDER BY id DESC LIMIT 300').all().map((q) => ({
      id: q.id, title: q.title, status: q.status, customer_name: q.customer_name, created_at: q.created_at, request_id: q.request_id,
      totals: quoteTotals(q, getItems(q.id)),
    }));
    send(res, 200, rows);
  }, { auth: true });

  route('POST', '/api/quotes', async (req, res) => {
    const b = await json(req);
    const r = b.request_id ? getRequest(b.request_id) : null;
    const s = getSettings(db);
    const ins = db.prepare(`INSERT INTO quotes (token, request_id, title, customer_name, customer_phone, customer_email, location, rig, terms, tax_rate_bp, deposit_credit_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(token(), r?.id ?? null, r?.type === 'winterize' ? 'Onsite RV winterizing' : 'Repair proposal',
        r?.name || '', r?.phone || '', r?.email || '', r?.location || '', r?.rig || '', s.terms, s.tax_rate_bp, paidDeposits(r?.id));
    const qid = Number(ins.lastInsertRowid);
    if (r?.type === 'winterize') {
      const pkg = db.prepare(`SELECT * FROM products WHERE active = 1 AND name LIKE '%winteriz%' ORDER BY id LIMIT 1`).get();
      if (pkg) db.prepare(`INSERT INTO quote_items (quote_id, product_id, name, description, qty, unit_cents, taxable) VALUES (?,?,?,?,1,?,?)`).run(qid, pkg.id, pkg.name, pkg.description, pkg.price_cents, pkg.taxable);
    }
    setRequestStatus(r?.id, 'quoted', ['new', 'contacted']);
    send(res, 201, quoteFull(getQuote(qid)));
  }, { auth: true });

  route('GET', '/api/quotes/:id', async (req, res, p) => {
    const q = getQuote(p.id); if (!q) throw new HttpError(404, 'Not found');
    send(res, 200, { ...quoteFull(q), proposal_url: `${baseUrl(req)}/p/${q.token}` });
  }, { auth: true });

  route('PUT', '/api/quotes/:id', async (req, res, p) => {
    const q = getQuote(p.id); if (!q) throw new HttpError(404, 'Not found');
    if (q.signed_at || q.status === 'paid') throw new HttpError(409, 'This quote is signed, so it can’t be changed. Make a new quote instead.');
    const b = await json(req);
    db.prepare(`UPDATE quotes SET title = ?, customer_name = ?, customer_phone = ?, customer_email = ?, location = ?, rig = ?, notes = ?, terms = ?, tax_rate_bp = ?, updated_at = ? WHERE id = ?`).run(
      clean(b.title, 200) || 'Repair proposal', clean(b.customer_name, 120), clean(b.customer_phone, 40), clean(b.customer_email, 200),
      clean(b.location, 1000), clean(b.rig, 200), clean(b.notes, 4000), clean(b.terms, 4000), Math.min(3000, cents(b.tax_rate_bp)), now(), q.id);
    db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(q.id);
    const ins = db.prepare(`INSERT INTO quote_items (quote_id, product_id, name, description, qty, unit_cents, taxable, sort) VALUES (?,?,?,?,?,?,?,?)`);
    (Array.isArray(b.items) ? b.items : []).slice(0, 100).forEach((it, i) => {
      if (!clean(it.name)) return;
      const qty = Math.max(0, Math.min(10000, Number(it.qty) || 0));
      ins.run(q.id, it.product_id || null, clean(it.name, 200), clean(it.description, 1000), qty, cents(it.unit_cents), it.taxable ? 1 : 0, i);
    });
    refreshCredits(q.request_id);
    send(res, 200, { ...quoteFull(getQuote(q.id)), proposal_url: `${baseUrl(req)}/p/${q.token}` });
  }, { auth: true });

  route('POST', '/api/quotes/:id/status', async (req, res, p) => {
    const q = getQuote(p.id); if (!q) throw new HttpError(404, 'Not found');
    const b = await json(req);
    if (b.status === 'void') db.prepare(`UPDATE quotes SET status = 'void', updated_at = ? WHERE id = ?`).run(now(), q.id);
    else if (b.status === 'draft' && q.status === 'void' && !q.signed_at) db.prepare(`UPDATE quotes SET status = 'draft', updated_at = ? WHERE id = ?`).run(now(), q.id);
    send(res, 200, quoteFull(getQuote(q.id)));
  }, { auth: true });

  // Record a cash / check / other payment for the balance.
  route('POST', '/api/quotes/:id/payments', async (req, res, p) => {
    const q = getQuote(p.id); if (!q) throw new HttpError(404, 'Not found');
    if (q.status === 'paid') throw new HttpError(409, 'Already paid.');
    const b = await json(req);
    const method = ['cash', 'check', 'other'].includes(b.method) ? b.method : 'cash';
    const { balance } = quoteTotals(q, getItems(q.id));
    const t = token();
    db.prepare(`INSERT INTO payments (token, kind, quote_id, request_id, description, amount_cents, method) VALUES (?, 'quote', ?, ?, ?, ?, ?)`)
      .run(t, q.id, q.request_id, `${q.title} (#${q.id})`, balance, method);
    markPaid(getPayment(t), method);
    send(res, 200, quoteFull(getQuote(q.id)));
  }, { auth: true });

  route('GET', '/api/settings', async (req, res) => send(res, 200, getSettings(db)), { auth: true });
  route('PUT', '/api/settings', async (req, res) => {
    const b = await json(req);
    const set = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
    if (b.tax_rate_bp !== undefined) set.run('tax_rate_bp', String(Math.min(3000, cents(b.tax_rate_bp))));
    if (b.deposit_cents !== undefined) set.run('deposit_cents', String(cents(b.deposit_cents)));
    if (b.terms !== undefined) set.run('terms', clean(b.terms, 4000));
    send(res, 200, getSettings(db));
  }, { auth: true });

  // ---------- static pages ----------
  const pages = { '/admin': 'admin.html', '/admin/': 'admin.html' };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'",
  };
  function serveFile(res, file) {
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return false;
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...securityHeaders });
    fs.createReadStream(full).pipe(res);
    return true;
  }

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') { cors(req, res); return send(res, 204, ''); }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(pathname); if (!m) continue;
          if (r.cors) cors(req, res);
          if (r.auth && !isAuthed(req)) throw new HttpError(401, 'Please log in.');
          // Same-origin check for state-changing admin calls.
          if (r.auth && req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Forbidden');
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          return await r.handler(req, res, params, url);
        }
        throw new HttpError(404, 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (pathname === '/') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
      if (pathname === '/healthz') return send(res, 200, 'ok');
      if (pages[pathname]) return serveFile(res, pages[pathname]);
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
  http.createServer(handler).listen(port, () => console.log(`RSQU admin listening on http://localhost:${port}`));
}
