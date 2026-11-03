import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, platformSettings, platformFee, quoteTotals, slugify, AGREEMENT_VERSION, BUSINESS_AGREEMENTS } from './src/db.js';
import { hashPassword, verifyPassword, sessions, randomToken, sha256 } from './src/auth.js';
import { stripeClient, verifyStripeSignature } from './src/stripe.js';
import * as customerTerms from './src/customer-terms.js';
import { notifier } from './src/notify.js';
import { renderSite, renderCityPage, renderServicePage, serviceSlug, hasPage, sitePages, tenantSitemap, tenantRobots, siteUrls } from './src/site.js';
import * as siteProfile from './src/site-profile.js';
import { draftProposal, normalizeDraft } from './src/ai-proposal.js';
import { renderReceipt, renderUnsubscribe, consentText, money as receiptMoney } from './src/receipt.js';
import { renderLanding, robotsTxt, sitemapXml, llmsTxt, BRAND } from './src/landing.js';
import * as owner from './src/owner-features.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

export function createApp(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const db = openDb(dataDir);
  const uploads = path.join(dataDir, 'uploads');
  const stripe = stripeClient(env);
  const notify = notifier(env);
  const platformEmail = env.PLATFORM_CONTACT_EMAIL || 'aaron@agilitiestech.com';
  const platformName = env.PLATFORM_NAME || BRAND.name;

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

  // Public marketing origin (the brand domain if set).
  const siteOrigin = (req) => (env.PLATFORM_URL || baseUrl(req)).replace(/\/$/, '');
  // The platform's own hosts can never be a business's custom domain.
  const platformHosts = new Set([env.PLATFORM_URL, env.BASE_URL].filter(Boolean).flatMap((u) => { try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); return [h, 'www.' + h]; } catch { return []; } }));
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
    const { id, slug, name, status, phone, email, notify_phone, tagline, hero_headline, about, service_area, primary_color, accent_color, logo, owner_photo, website_url, custom_domain, tax_rate_bp, deposit_cents, deposit_label, terms, stripe_account_id, stripe_account_type, stripe_payouts_enabled, stripe_details_submitted, statement_name, created_at } = t;
    return { id, slug, name, status, phone, email, notify_phone, tagline, hero_headline, about, service_area, primary_color, accent_color, logo, owner_photo, website_url, custom_domain, tax_rate_bp, deposit_cents, deposit_label, terms, stripe_account_id, stripe_account_type, stripe_payouts_enabled, stripe_details_submitted, statement_name, created_at };
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
  // The business's own Stripe account (Accounts v2, merchant configuration): customers pay it
  // directly, so the business is the merchant of record. Anything else is a legacy Express payout
  // account from when the platform was the merchant of record.
  const isMerchant = (t) => Boolean(t && t.stripe_account_id && t.stripe_account_type === 'v2_merchant');
  // Owners must connect their own Stripe account before using the dashboard. Businesses still on a
  // legacy Express payout account are sent through this again so they become the seller of record.
  function needsPayoutSetup(user, tenant) {
    return Boolean(stripe.enabled && user && user.role === 'owner' && tenant && !(isMerchant(tenant) && tenant.stripe_details_submitted));
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
  const jparse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  function quoteFull(q) {
    const items = getItems(q.id);
    const payments = db.prepare('SELECT * FROM payments WHERE quote_id = ? ORDER BY id').all(q.id);
    return { ...q, photos: jparse(q.photos, []), ai_draft: jparse(q.ai_draft, null), items, totals: quoteTotals(q, items), payments };
  }

  // ---------- customers, consent and receipts ----------
  const publicBase = () => (env.BASE_URL || env.PLATFORM_URL || 'http://localhost:3000').replace(/\/$/, '');
  const phoneKey = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
  const toE164 = (p) => { const s = String(p || '').trim(); const d = s.replace(/\D/g, ''); if (s.startsWith('+') && d.length >= 10) return '+' + d; if (d.length === 10) return '+1' + d; if (d.length === 11 && d[0] === '1') return '+' + d; return ''; };
  const normEmail = (e) => String(e || '').trim().toLowerCase();
  const noCtl = (v, max) => clean(String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' '), max);
  function findCustomer(tid, phone, email) {
    const k = phoneKey(phone), e = normEmail(email);
    return (e && db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND email = ? ORDER BY id LIMIT 1').get(tid, e))
      || (k && db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND phone_key = ? ORDER BY id LIMIT 1').get(tid, k)) || null;
  }
  function logConsent(tid, customerId, channel, action, address, { text, source, ip, ua } = {}) {
    db.prepare('INSERT INTO consent_log (tenant_id, customer_id, channel, action, address, text, source, ip, ua) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(tid, customerId ?? null, channel, action, address, text || null, source || null, ip || null, ua || null);
  }
  // Records a customer and what they agreed to. Email updates follow the checkbox (it starts unchecked
  // for anyone who unsubscribed before); unchecking opts the address out everywhere for this business.
  // A text opt-in belongs to the number that agreed: it's only ever added here, it doesn't follow the
  // customer to a new number, and STOP replies remove it.
  function upsertCustomer(t, { name, phone, email, emailOptIn, smsOptIn, source, ip, ua }) {
    const ts = now(), e = normEmail(email), k = phoneKey(phone);
    const meta = { source, ip, ua };
    // Match on email first; a phone match only counts if it doesn't already belong to a different email.
    let c = e ? db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND email = ? ORDER BY id LIMIT 1').get(t.id, e) : null;
    if (!c && k) {
      const byPhone = db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND phone_key = ? ORDER BY id LIMIT 1').get(t.id, k);
      if (byPhone && (!e || !byPhone.email || byPhone.email === e)) c = byPhone;
    }
    if (!c && !e && !k) return null;
    if (!c) {
      const ins = db.prepare('INSERT INTO customers (tenant_id, name, phone, phone_key, email, unsub_token, source) VALUES (?,?,?,?,?,?,?)').run(t.id, name || '', k ? phone : '', k, e || null, randomToken(), source);
      c = db.prepare('SELECT * FROM customers WHERE id = ?').get(ins.lastInsertRowid);
    } else {
      if (k && c.phone_key && k !== c.phone_key && c.sms_opt_in && !smsOptIn) {
        db.prepare('UPDATE customers SET sms_opt_in = 0 WHERE id = ?').run(c.id);
        logConsent(t.id, c.id, 'sms', 'opt_out', c.phone, { ...meta, text: 'Phone number changed; texts not re-confirmed' });
      }
      db.prepare(`UPDATE customers SET name = COALESCE(NULLIF(?, ''), name), phone = CASE WHEN ? != '' THEN ? ELSE phone END, phone_key = COALESCE(NULLIF(?, ''), phone_key), email = COALESCE(email, NULLIF(?, '')), updated_at = ? WHERE id = ?`)
        .run(name || '', k, phone || '', k, e, ts, c.id);
      c = db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
    }
    const addr = e || c.email;
    if (addr) {
      if (emailOptIn && e) {
        db.prepare('UPDATE customers SET email_opt_in = 1, email_consent_at = ?, email_consent_text = ?, email_unsubscribed_at = NULL, consent_ip = ?, consent_ua = ?, source = ? WHERE id = ?').run(ts, consentText.email(t.name), ip, ua, source, c.id);
        logConsent(t.id, c.id, 'email', 'opt_in', e, { ...meta, text: consentText.email(t.name) });
      } else if (!emailOptIn) {
        const r = db.prepare('UPDATE customers SET email_opt_in = 0, email_unsubscribed_at = COALESCE(email_unsubscribed_at, ?) WHERE tenant_id = ? AND email = ? AND email_opt_in = 1').run(ts, t.id, addr);
        if (r.changes) logConsent(t.id, c.id, 'email', 'opt_out', addr, { ...meta, text: 'Unchecked email updates when signing' });
      }
    }
    if (smsOptIn && k) {
      db.prepare('UPDATE customers SET sms_opt_in = 1, sms_consent_at = ?, sms_consent_text = ? WHERE id = ?').run(ts, consentText.sms(t.name), c.id);
      logConsent(t.id, c.id, 'sms', 'opt_in', phone, { ...meta, text: consentText.sms(t.name) });
    }
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
  }

  // Texts and emails the customer a link to their receipt, once per payment.
  async function sendReceipt(paymentId) {
    const claim = db.prepare(`UPDATE payments SET receipt_sent_at = ? WHERE id = ? AND status = 'paid' AND receipt_sent_at IS NULL`).run(now(), paymentId);
    if (!claim.changes) return;
    const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    const t = getTenant(pay.tenant_id);
    const q = pay.quote_id ? db.prepare('SELECT * FROM quotes WHERE id = ?').get(pay.quote_id) : null;
    const r = pay.request_id ? db.prepare('SELECT * FROM requests WHERE id = ?').get(pay.request_id) : null;
    const name = String(q?.signer_name || q?.customer_name || r?.name || '').trim();
    const first = name.split(/\s+/)[0] || '';
    const phone = q?.customer_phone || r?.phone || '';
    const email = normEmail(q?.customer_email || r?.email || '');
    const url = `${publicBase()}/r/${pay.token}`;
    const amount = receiptMoney(pay.amount_cents);
    const sms = toE164(phone);
    if (sms) await notify.sms(sms, `${t.name}: Thanks${first ? ', ' + first : ''}! We received your payment of ${amount}. Your receipt: ${url}`);
    if (/^\S+@\S+\.\S+$/.test(email)) {
      const c = findCustomer(t.id, phone, email);
      const unsub = c && c.email_opt_in && normEmail(c.email) === email ? `${publicBase()}/u/${c.unsub_token}` : '';
      const lines = [`Hi${first ? ' ' + first : ''},`, '', `Thanks for choosing ${t.name}. We received your payment of ${amount}${q ? ` for ${q.title}` : ''}.`, '', `Your receipt: ${url}`, '',
        `Questions? ${t.phone ? `Call or text ${t.phone}` : 'Reply to this email'}${t.email ? ` or email ${t.email}` : ''}.`, '', t.name];
      if (unsub) lines.push('', `You're subscribed to updates and offers from ${t.name}. Unsubscribe: ${unsub}`);
      await notify.email(email, `Your receipt from ${t.name}: ${amount}`, lines.join('\n'), {
        fromName: t.name, replyTo: t.email || undefined,
        headers: unsub ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
      });
    }
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
    sendReceipt(payment.id).catch((e) => console.error('Receipt failed', e));
    try { scheduleReviewRequest(payment.id); } catch (e) { console.error('Review request failed', e); } // owner features
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

  // ---------- customer Terms & Conditions (each business is the seller of record) ----------
  const latestTerms = (tid) => db.prepare('SELECT * FROM customer_terms WHERE tenant_id = ? ORDER BY version DESC LIMIT 1').get(tid) || null;
  const termsPath = (t, version) => `/s/${t.slug}/terms${version ? `?v=${version}` : ''}`;
  // Profile, personalised draft, last owner-approved version, and whether it needs re-approval.
  function termsState(t) {
    const profile = customerTerms.parseProfile(t.legal_profile);
    const missing = customerTerms.missingFields(t, profile);
    const complete = missing.length === 0;
    const vars = complete ? customerTerms.templateVars(t, profile, platformName) : null;
    const draft = complete ? customerTerms.renderTemplate(vars) : null;
    const adopted = latestTerms(t.id);
    const needsReview = Boolean(adopted && complete && (adopted.template_version !== customerTerms.TEMPLATE_VERSION || adopted.profile_fingerprint !== customerTerms.fingerprint(vars)));
    return { profile, missing, complete, vars, draft, adopted, needsReview };
  }
  // What customers are shown next to a proposal or payment: the version they accept.
  function publicTerms(t, version) {
    const v = version ? db.prepare('SELECT version FROM customer_terms WHERE tenant_id = ? AND version = ?').get(t.id, version) : latestTerms(t.id);
    return v ? { version: v.version, url: termsPath(t, v.version) } : null;
  }

  // ---------- payments ----------
  // Online payments are DIRECT charges on the business's own Stripe account: the business is the
  // merchant of record and Stripe bills its processing fee to the business; the platform's share
  // is an application fee. The customer pays only the amount due. Requires the business's
  // owner-approved customer terms, because the business is the seller.
  const onlineReady = (t) => stripe.enabled && isMerchant(t) && Boolean(t.stripe_payouts_enabled) && Boolean(latestTerms(t.id));
  function onlineQuote(t, amount) {
    return { fee: 0, charge: amount, bp: platformFee(db, t, amount).bp, card_payments: onlineReady(t) };
  }

  // `termsVersion`: the customer terms version the customer accepted (signed on the proposal, or
  // shown on the payment page). Recorded on the payment and in Stripe metadata.
  async function startCheckout(req, t, payment, { successPath, cancelPath, email, termsVersion }) {
    if (!onlineReady(t)) throw new HttpError(503, 'Online payments aren’t set up yet for this business. Please pay directly.');
    const base = baseUrl(req);
    const sep = successPath.includes('?') ? '&' : '?';
    const terms = (termsVersion && db.prepare('SELECT * FROM customer_terms WHERE tenant_id = ? AND version = ?').get(t.id, termsVersion)) || latestTerms(t.id);
    const session = await stripe.createCheckout({
      account: t.stripe_account_id, // direct charge: the business is the merchant of record
      name: payment.description,
      amountCents: payment.amount_cents,
      applicationFeeCents: platformFee(db, t, payment.amount_cents).fee, // the platform's 3%
      successUrl: `${base}${successPath}${sep}paid=${payment.token}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}${cancelPath}`,
      ref: payment.token,
      email,
      statementName: t.statement_name || t.name,
      // Which customer terms applied to this payment (also visible in the business's Stripe Dashboard).
      metadata: { customer_terms_version: String(terms.version), customer_terms_sha256: terms.sha256 },
    });
    db.prepare(`UPDATE payments SET stripe_session_id = ?, charge_type = 'direct', stripe_account = ?, customer_terms_version = ? WHERE id = ?`)
      .run(session.id, t.stripe_account_id, terms.version, payment.id);
    return session.url;
  }

  // After an online payment succeeds, record the Processing Fee (Stripe's fee + platform share).
  // Direct charges: the money is already in the business's Stripe balance; we only read the fees.
  // Legacy platform charges: keep the fees and transfer the rest to the business's Express account.
  async function settle(token) {
    let pay = getPayment(token);
    if (!pay || pay.status !== 'paid' || pay.method !== 'card' || ['sent', 'direct'].includes(pay.transfer_status)) return pay;
    if (pay.charge_type === 'direct') return settleDirect(pay);
    const t = getTenant(pay.tenant_id);
    // Legacy payouts go to the old Express account even after the business moved to its own account.
    const legacyDest = isMerchant(t) ? t.legacy_stripe_account_id : t.stripe_account_id;
    const fail = (msg) => db.prepare(`UPDATE payments SET transfer_status = 'failed', transfer_error = ? WHERE id = ?`).run(String(msg).slice(0, 300), pay.id);
    try {
      if (!pay.charge_id) {
        const s = await stripe.retrieveCheckout(pay.stripe_session_id);
        const ch = s.payment_intent && s.payment_intent.latest_charge;
        const bt = ch && ch.balance_transaction;
        if (!ch || !bt || typeof bt !== 'object') {
          db.prepare(`UPDATE payments SET transfer_status = 'pending', transfer_error = 'Waiting for Stripe to settle the payment' WHERE id = ?`).run(pay.id);
          return getPayment(token);
        }
        const { fee } = platformFee(db, t, pay.amount_cents);
        const payout = Math.max(0, pay.amount_cents - bt.fee - fee);
        db.prepare(`UPDATE payments SET charge_id = ?, stripe_fee_cents = ?, fee_cents = ?, payout_cents = ?, transfer_status = 'pending' WHERE id = ?`).run(ch.id, bt.fee, fee, payout, pay.id);
        pay = getPayment(token);
      }
      if (!legacyDest) { fail('The business hasn’t connected a payout account yet.'); return getPayment(token); }
      if (pay.payout_cents <= 0) { db.prepare(`UPDATE payments SET transfer_status = 'sent', transfer_error = NULL WHERE id = ?`).run(pay.id); return getPayment(token); }
      const tr = await stripe.createTransfer({ amountCents: pay.payout_cents, destination: legacyDest, sourceTransaction: pay.charge_id, group: pay.token, ref: pay.token });
      db.prepare(`UPDATE payments SET transfer_id = ?, transfer_status = 'sent', transfer_error = NULL WHERE id = ?`).run(tr.id, pay.id);
      notify.sms(t.notify_phone, `${money(pay.payout_cents)} is on its way to your bank (${money(pay.amount_cents)} paid, ${money(pay.stripe_fee_cents + pay.fee_cents)} Processing Fee).`);
    } catch (e) {
      fail(e.message);
    }
    return getPayment(token);
  }
  // Direct charge on the business's account. The charge's balance transaction lists Stripe's fee
  // and the platform's application fee separately; `net` is what the business keeps.
  async function settleDirect(pay) {
    const t = getTenant(pay.tenant_id);
    try {
      const s = await stripe.retrieveCheckout(pay.stripe_session_id, pay.stripe_account);
      const ch = s.payment_intent && s.payment_intent.latest_charge;
      const bt = ch && ch.balance_transaction;
      if (!ch || !bt || typeof bt !== 'object') {
        db.prepare(`UPDATE payments SET transfer_status = 'pending', transfer_error = 'Waiting for Stripe to settle the payment' WHERE id = ?`).run(pay.id);
        return getPayment(pay.token);
      }
      const details = Array.isArray(bt.fee_details) ? bt.fee_details : [];
      const share = details.some((d) => d.type === 'application_fee')
        ? details.filter((d) => d.type === 'application_fee').reduce((a, d) => a + d.amount, 0)
        : platformFee(db, t, pay.amount_cents).fee;
      const stripeFee = Math.max(0, bt.fee - share);
      const net = typeof bt.net === 'number' ? bt.net : pay.amount_cents - bt.fee;
      const r = db.prepare(`UPDATE payments SET charge_id = ?, stripe_fee_cents = ?, fee_cents = ?, payout_cents = ?, transfer_status = 'direct', transfer_error = NULL WHERE id = ? AND COALESCE(transfer_status, '') != 'direct'`)
        .run(ch.id, stripeFee, share, net, pay.id);
      // A webhook and the return-page confirm can arrive together: only the first one notifies.
      if (r.changes) notify.sms(t?.notify_phone, `${money(net)} added to your Stripe balance (${money(pay.amount_cents)} paid, ${money(stripeFee + share)} Processing Fee).`);
    } catch (e) {
      db.prepare(`UPDATE payments SET transfer_status = 'pending', transfer_error = ? WHERE id = ?`).run(String(e.message).slice(0, 300), pay.id);
    }
    return getPayment(pay.token);
  }

  // When a business refunds a customer from its Stripe Dashboard, return the platform's 3%
  // in proportion to the amount refunded (Payment Terms § 6). Safe to repeat: it refunds only the
  // difference from what has already been returned, with an idempotency key per target amount.
  async function returnPlatformFee(account, charge) {
    const pay = db.prepare(`SELECT * FROM payments WHERE charge_id = ? AND stripe_account = ? AND charge_type = 'direct'`).get(charge.id, account);
    const feeId = typeof charge.application_fee === 'string' ? charge.application_fee : charge.application_fee?.id;
    if (!pay || !feeId || !charge.amount) return;
    const fee = await stripe.getApplicationFee(feeId);
    const target = Math.min(fee.amount, Math.round((fee.amount * (charge.amount_refunded || 0)) / charge.amount));
    const due = target - (fee.amount_refunded || 0);
    if (due > 0) await stripe.refundApplicationFee(feeId, due, `appfee-refund-${feeId}-${target}`);
    db.prepare('UPDATE payments SET fee_refunded_cents = ? WHERE id = ?').run(Math.max(target, fee.amount_refunded || 0), pay.id);
  }

  async function retryPayouts(tenantId) {
    const rows = db.prepare(`SELECT token FROM payments WHERE tenant_id = ? AND status = 'paid' AND method = 'card' AND transfer_status IN ('pending','failed')`).all(tenantId);
    for (const r of rows) await settle(r.token);
  }

  async function confirmCheckout(payment, sessionId) {
    if (payment.status === 'paid') return true;
    if (!sessionId || !stripe.enabled || sessionId !== payment.stripe_session_id) return false;
    const s = await stripe.retrieveCheckout(sessionId, payment.charge_type === 'direct' ? payment.stripe_account : undefined);
    if (s.client_reference_id !== payment.token) return false;
    if (s.payment_status === 'paid') { markPaid(getPayment(payment.token), 'card', s.id); await settle(payment.token); return true; }
    return false;
  }

  async function refreshStripeStatus(t) {
    if (!stripe.enabled || !t.stripe_account_id) return t;
    if (isMerchant(t)) {
      // stripe_payouts_enabled = the account can take card payments (and is paid out by Stripe).
      const st = await stripe.merchantStatus(t.stripe_account_id);
      db.prepare(`UPDATE tenants SET stripe_payouts_enabled = ?, stripe_details_submitted = ? WHERE id = ?`).run(st.chargesEnabled ? 1 : 0, st.detailsSubmitted || st.chargesEnabled ? 1 : 0, t.id);
      await retryPayouts(t.id); // re-read fees for any payment that was still settling
      return getTenant(t.id);
    }
    const a = await stripe.getAccount(t.stripe_account_id);
    const ready = a.payouts_enabled && (!a.capabilities || a.capabilities.transfers === 'active');
    db.prepare(`UPDATE tenants SET stripe_payouts_enabled = ?, stripe_details_submitted = ? WHERE id = ?`).run(ready ? 1 : 0, a.details_submitted ? 1 : 0, t.id);
    if (ready) await retryPayouts(t.id);
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
    notify.email(platformEmail, `New ${platformName} sign-up: ${business}`, `${name} <${email}> ${phone}\nBusiness: ${business}\n${baseUrl(req)}/admin/#/super/${tid}`);
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
      needs_payout_setup: !ctx.isSuper && needsPayoutSetup(ctx.user, ctx.tenant),
      platform: { name: platformName },
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
      // The business's customer Terms & Conditions: the version signed, or the current one to accept.
      customer_terms: publicTerms(t, full.customer_terms_version),
      photos: full.photos.filter((ph) => ph.show).map((ph) => ({ url: `/api/public/proposals/${encodeURIComponent(q.token)}/photos/${encodeURIComponent(ph.file)}` })),
      customer_phone: full.signed_at || !phoneKey(full.customer_phone) ? undefined : full.customer_phone, customer_email: full.signed_at ? undefined : full.customer_email,
      // Unchecked for anyone who unsubscribed before, so re-subscribing takes a deliberate check.
      subscribe_email_default: (() => { const c = findCustomer(t.id, full.customer_phone, full.customer_email); return !(c && c.email_unsubscribed_at && !c.email_opt_in); })(),
      consent: { email: consentText.email(t.name), sms: consentText.sms(t.name) },
      receipts: full.payments.filter((pp) => pp.status === 'paid').map((pp) => ({ url: `/r/${pp.token}`, amount_cents: pp.amount_cents, paid_at: pp.paid_at })),
    });
  });
  route('GET', '/api/public/proposals/:token/photos/:file', async (req, res, p) => {
    const q = getQuoteByToken(p.token);
    if (!q || q.status === 'void' || !jparse(q.photos, []).some((ph) => ph.show && ph.file === p.file)) throw new HttpError(404, 'Not found');
    sendUpload(res, p.file);
  });

  route('POST', '/api/public/proposals/:token/sign', async (req, res, p) => {
    const q = getQuoteByToken(p.token);
    if (!q || q.status === 'void') throw new HttpError(404, 'This proposal isn’t available.');
    if (q.signed_at) throw new HttpError(409, 'This proposal is already signed.');
    const b = await json(req, 1_000_000);
    const name = noCtl(b.name, 120);
    if (!name || !b.agree) throw new HttpError(400, 'Type your name and check the box to accept.');
    // The customer accepts the business's current Terms & Conditions with the proposal. If the
    // business approved a new version since the page loaded, ask them to review it first.
    const terms = latestTerms(q.tenant_id);
    if (terms && Number(b.terms_version) !== terms.version) throw new HttpError(409, 'The business updated its Terms & Conditions. Reload the page to review them, then sign.');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/.test(b.signature || '')) throw new HttpError(400, 'Please sign in the box.');
    if (b.signature.length > 700_000) throw new HttpError(413, 'Signature is too large.');
    // Where the receipt goes, and what the customer agreed to receive.
    const phone = b.phone !== undefined ? noCtl(b.phone, 40) : (phoneKey(q.customer_phone) ? q.customer_phone : '');
    const email = b.email !== undefined ? noCtl(b.email, 200).toLowerCase() : normEmail(q.customer_email);
    if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Check your email address.');
    if (b.phone !== undefined && phone && !phoneKey(phone)) throw new HttpError(400, 'Check your phone number.');
    if (b.subscribe_sms && !phoneKey(phone)) throw new HttpError(400, 'Add your mobile number to get texts, or uncheck that box.');
    const ts = now();
    db.prepare(`UPDATE quotes SET status = 'signed', signer_name = ?, signature_png = ?, signer_ip = ?, signer_ua = ?, signed_at = ?, updated_at = ?, customer_terms_version = ?, customer_terms_sha256 = ?, customer_phone = ?, customer_email = ? WHERE id = ?`)
      .run(name, b.signature, clientIp(req), clean(req.headers['user-agent'], 400), ts, ts, terms?.version ?? null, terms?.sha256 ?? null, phone || '', email || '', q.id);
    upsertCustomer(getTenant(q.tenant_id), { name, phone, email, emailOptIn: Boolean(b.subscribe_email), smsOptIn: Boolean(b.subscribe_sms), source: `Proposal #${q.id}`, ip: clientIp(req), ua: clean(req.headers['user-agent'], 400) });
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
    const url = await startCheckout(req, t, pay, { successPath: `/p/${q.token}`, cancelPath: `/p/${q.token}`, email: q.customer_email, termsVersion: q.customer_terms_version });
    send(res, 200, { url });
  });

  route('GET', '/api/public/payments/:token', async (req, res, p) => {
    const pay = getPayment(p.token);
    const t = pay && getTenant(pay.tenant_id);
    if (!pay || !t) throw new HttpError(404, 'This payment link isn’t valid.');
    send(res, 200, { description: pay.description, amount_cents: pay.amount_cents, status: pay.status, kind: pay.kind, paid_at: pay.paid_at, fee_cents: 0, online: onlineQuote(t, pay.amount_cents), business: brand(t), customer_terms: publicTerms(t, pay.customer_terms_version) });
  });

  route('POST', '/api/public/payments/:token/checkout', async (req, res, p) => {
    const pay = getPayment(p.token);
    const t = pay && getTenant(pay.tenant_id);
    if (!pay || !t) throw new HttpError(404, 'This payment link isn’t valid.');
    if (pay.status === 'paid') throw new HttpError(409, 'This is already paid.');
    const b = await json(req);
    const latest = latestTerms(t.id);
    if (latest && b.terms_version !== undefined && Number(b.terms_version) !== latest.version) throw new HttpError(409, 'The business updated its Terms & Conditions. Reload the page to review them, then pay.');
    const r = pay.request_id ? db.prepare('SELECT email FROM requests WHERE id = ?').get(pay.request_id) : null;
    const url = await startCheckout(req, t, pay, { successPath: `/pay/${pay.token}`, cancelPath: `/pay/${pay.token}`, email: r?.email, termsVersion: latest?.version });
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
      // Direct charges arrive from the business's account (Connect endpoint, evt.account set);
      // legacy platform charges arrive on the platform endpoint (no evt.account).
      const rightAccount = pay && (pay.charge_type === 'direct' ? evt.account === pay.stripe_account : !evt.account);
      if (pay && rightAccount && o.id === pay.stripe_session_id) { markPaid(pay, 'card', o.id); await settle(pay.token); }
    } else if (evt.type === 'charge.refunded' && evt.account && o?.id) {
      await returnPlatformFee(evt.account, o);
    } else if (evt.type === 'account.updated' && o?.id) {
      const t = db.prepare('SELECT * FROM tenants WHERE stripe_account_id = ? OR legacy_stripe_account_id = ?').get(o.id, o.id);
      if (t && isMerchant(t) && t.stripe_account_id === o.id) {
        // v2 accounts also emit v1 account.updated (Connected accounts scope): ready = card payments active.
        const ready = Boolean(o.charges_enabled) && (!o.capabilities || o.capabilities.card_payments === 'active');
        db.prepare(`UPDATE tenants SET stripe_payouts_enabled = ?, stripe_details_submitted = ? WHERE id = ?`).run(ready ? 1 : 0, o.details_submitted || ready ? 1 : 0, t.id);
        await retryPayouts(t.id);
      } else if (t) {
        // Legacy Express payout account: release held payouts once transfers are active.
        const ready = o.payouts_enabled && (!o.capabilities || o.capabilities.transfers === 'active');
        if (!isMerchant(t)) db.prepare(`UPDATE tenants SET stripe_payouts_enabled = ?, stripe_details_submitted = ? WHERE id = ?`).run(ready ? 1 : 0, o.details_submitted ? 1 : 0, t.id);
        if (ready) await retryPayouts(t.id);
      }
    }
    send(res, 200, { received: true });
  });

  // ===== business dashboard =====
  route('GET', '/api/config', async (req, res, p, url, { tenant: t }) => {
    send(res, 200, {
      stripe: { platform_ready: stripe.enabled, test_mode: stripe.testMode, account: t.stripe_account_id, account_type: isMerchant(t) ? 'merchant' : t.stripe_account_id ? 'legacy_express' : null, online_ready: onlineReady(t), payouts_enabled: Boolean(t.stripe_payouts_enabled), details_submitted: Boolean(t.stripe_details_submitted) },
      customer_terms: (() => { const st = termsState(t); return { profile_complete: st.complete, approved_version: st.adopted?.version || null, needs_review: st.needsReview }; })(),
      processing_fee: { bp: platformFee(db, t, 0).bp },
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
    const r = db.prepare(`INSERT INTO products (tenant_id, name, description, price_cents, taxable, on_site, bookable, details, sort) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(t.id, clean(b.name, 200), clean(b.description, 1000), cents(b.price_cents), b.taxable ? 1 : 0, b.on_site ? 1 : 0, b.bookable ? 1 : 0, clean(b.details, 8000), Math.max(-999, Math.min(999, Math.trunc(Number(b.sort) || 0))));
    send(res, 201, scoped('products', Number(r.lastInsertRowid), t.id));
  }, { auth: 'tenant' });
  route('PATCH', '/api/products/:id', async (req, res, p, url, { tenant: t }) => {
    const cur = scoped('products', p.id, t.id); if (!cur) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : cur[k]);
    const flag = (v) => (v ? 1 : 0);
    db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, taxable = ?, active = ?, on_site = ?, bookable = ?, details = ?, sort = ? WHERE id = ?`).run(
      pick('name', (v) => clean(v, 200) || cur.name), pick('description', (v) => clean(v, 1000)), pick('price_cents', cents),
      pick('taxable', flag), pick('active', flag), pick('on_site', flag), pick('bookable', flag),
      pick('details', (v) => clean(v, 8000)), pick('sort', (v) => Math.max(-999, Math.min(999, Math.trunc(Number(v) || 0)))), cur.id);
    send(res, 200, scoped('products', cur.id, t.id));
  }, { auth: 'tenant' });
  // Picture for the service's tile on the website (bold look). Send image: null to remove it.
  route('POST', '/api/products/:id/image', async (req, res, p, url, { tenant: t }) => {
    const cur = scoped('products', p.id, t.id); if (!cur) throw new HttpError(404, 'Not found');
    const b = await json(req, 6_000_000);
    const name = b.image ? saveImage(b.image, `t${t.id}-prod`, 4_000_000) : null;
    if (b.image && !name) throw new HttpError(400, 'Use a JPG, PNG or WebP image.');
    db.prepare('UPDATE products SET image = ? WHERE id = ?').run(name, cur.id);
    if (cur.image) try { fs.unlinkSync(path.join(uploads, path.basename(cur.image))); } catch { /* gone */ }
    send(res, 200, scoped('products', cur.id, t.id));
  }, { auth: 'owner' });

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

  // A draft proposal from photos the technician takes. With ANTHROPIC_API_KEY set, Claude drafts the
  // title, customer summary and lines from the business's price list; otherwise the photos are kept
  // and the technician fills the quote in. Either way it's a draft the technician edits before sending.
  route('POST', '/api/quotes/from-photos', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req, 14_000_000);
    const list = (Array.isArray(b.photos) ? b.photos : []).slice(0, 4);
    if (!list.length) throw new HttpError(400, 'Add at least one photo.');
    const r = b.request_id ? scoped('requests', b.request_id, t.id) : null;
    if (b.request_id && !r) throw new HttpError(404, 'Request not found.');
    const files = [];
    try {
      for (const d of list) { const f = saveImage(d, `t${t.id}-qp`, 4_000_000); if (!f) throw new HttpError(400, 'Use JPG, PNG or WebP photos.'); files.push(f); }
    } catch (e) { for (const f of files) try { fs.unlinkSync(path.join(uploads, f)); } catch { /* gone */ } throw e; }
    const note = clean(b.note, 1000), rig = clean(b.rig, 200) || r?.rig || '';
    const products = db.prepare('SELECT * FROM products WHERE tenant_id = ? AND active = 1 ORDER BY name').all(t.id);
    const hourly = customerTerms.parseProfile(t.legal_profile).hourlyRateCents || 0;
    let ai = null, error = '';
    if (!env.ANTHROPIC_API_KEY) error = 'not_configured';
    else {
      try {
        const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
        const images = files.map((f) => ({ mediaType: MIME[f.split('.').pop()], data: fs.readFileSync(path.join(uploads, f)).toString('base64') }));
        const out = await draftProposal({
          apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', apiBase: env.ANTHROPIC_API_BASE || 'https://api.anthropic.com',
          images, note, rig, products, hourlyRateCents: hourly,
          business: { name: t.name, servicePhrase: siteProfile.servicePhrase(siteProfile.parseProfile(t.site_profile)) },
        });
        ai = { ...normalizeDraft(out.draft, products, hourly), model: out.model };
      } catch (e) { error = e.message; console.error('AI draft failed', e.message); }
    }
    const ins = db.prepare(`INSERT INTO quotes (tenant_id, token, request_id, title, customer_name, customer_phone, customer_email, location, rig, notes, terms, tax_rate_bp, deposit_credit_cents, photos, ai_draft) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.id, randomToken(), r?.id ?? null, ai?.title || 'Repair proposal', r?.name || '', r?.phone || '', r?.email || '', r?.location || '', rig, ai?.summary || '', t.terms || '', t.tax_rate_bp, paidDeposits(r?.id),
        JSON.stringify(files.map((file) => ({ file, show: true }))),
        JSON.stringify({ note, error, model: ai?.model || null, findings: ai?.findings || [], safety: ai?.safety || [], questions: ai?.questions || [], needs_price: (ai?.items || []).filter((i) => i.needs_price).map((i) => i.name), estimates: (ai?.items || []).filter((i) => i.estimate).map((i) => i.name), at: now() }));
    const qid = Number(ins.lastInsertRowid);
    const li = db.prepare('INSERT INTO quote_items (quote_id, product_id, name, description, qty, unit_cents, taxable, sort) VALUES (?,?,?,?,?,?,?,?)');
    (ai?.items || []).forEach((it, i) => li.run(qid, it.product_id, it.name, it.description || '', it.qty, it.unit_cents, it.taxable, i));
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
    if (Array.isArray(b.photos)) {
      const show = new Map(b.photos.map((ph) => [ph && ph.file, Boolean(ph && ph.show)]));
      db.prepare('UPDATE quotes SET photos = ? WHERE id = ?').run(JSON.stringify(jparse(q.photos, []).map((ph) => ({ file: ph.file, show: show.has(ph.file) ? show.get(ph.file) : ph.show }))), q.id);
    }
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
    if (domain && (platformHosts.has(domain) || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain))) throw new HttpError(400, 'Enter your own domain, like www.yourbusiness.com.');
    if (domain && db.prepare('SELECT 1 FROM tenants WHERE custom_domain = ? AND id != ?').get(domain, t.id)) throw new HttpError(409, 'That domain is already used by another business.');
    if ((domain || null) !== (t.custom_domain || null)) db.prepare('UPDATE tenants SET domain_live_at = NULL WHERE id = ?').run(t.id);
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

  // Replies to the platform's text number. STOP-type words remove text consent for that number at every
  // business (Twilio itself blocks further texts and sends the confirmation). Point the Twilio number's
  // "A message comes in" webhook here.
  route('POST', '/api/twilio/inbound', async (req, res) => {
    const raw = await readBody(req, 100_000);
    const params = Object.fromEntries(new URLSearchParams(raw));
    if (env.TWILIO_AUTH_TOKEN && !env.NOTIFY_CAPTURE) {
      const url = `${publicBase()}/api/twilio/inbound`;
      const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
      const expected = crypto.createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(data).digest('base64');
      const got = String(req.headers['x-twilio-signature'] || '');
      if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) throw new HttpError(403, 'Forbidden');
    }
    const word = String(params.Body || '').trim().toUpperCase();
    const k = phoneKey(params.From);
    recordSmsReply(k, word); // owner features: STOP blocks appointment texts too
    if (k && ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT'].includes(word)) {
      for (const c of db.prepare('SELECT id, tenant_id, phone FROM customers WHERE phone_key = ? AND sms_opt_in = 1').all(k)) {
        db.prepare('UPDATE customers SET sms_opt_in = 0, updated_at = ? WHERE id = ?').run(now(), c.id);
        logConsent(c.tenant_id, c.id, 'sms', 'opt_out', c.phone, { text: `Replied ${word}` });
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  // ---------- owner features: time zone and settings ----------
  // Time zone, review requests and "pay over time" settings. GET is for the whole team; changes are owner-only.
  function ownerSettings(t) {
    const rs = owner.reviewSettings(t);
    return {
      timezone: owner.tzOf(t), timezones: owner.US_TIMEZONES,
      review: { link: rs.link, enabled: rs.enabled, active: rs.active, delay_hours: rs.delayHours, delays: owner.REVIEW_DELAYS, message: rs.message, default_message: owner.DEFAULT_REVIEW_MESSAGE, repeat_days: owner.REVIEW_REPEAT_DAYS },
      pay_over_time: Boolean(t.pay_over_time),
      email_enabled: notify.emailEnabled, sms_enabled: notify.smsEnabled,
    };
  }
  route('GET', '/api/owner-settings', async (req, res, p, url, { tenant: t }) => send(res, 200, ownerSettings(t)), { auth: 'tenant' });
  route('PUT', '/api/owner-settings', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    if (b.timezone !== undefined && !owner.validTimezone(b.timezone)) throw new HttpError(400, 'Choose your time zone from the list.');
    if (b.review_delay_hours !== undefined && !owner.REVIEW_DELAYS.includes(Number(b.review_delay_hours))) throw new HttpError(400, 'Choose when to send the review request from the list.');
    const msg = b.review_message !== undefined ? clean(b.review_message, 500) : undefined;
    if (b.review_message !== undefined && msg.length < 10) throw new HttpError(400, 'Write a short message for the review request, or press “Use the suggested message”.');
    db.prepare('UPDATE tenants SET timezone = ?, review_requests = ?, review_delay_hours = ?, review_message = ?, pay_over_time = ? WHERE id = ?').run(
      b.timezone !== undefined ? b.timezone : owner.tzOf(t),
      b.review_requests !== undefined ? (b.review_requests ? 1 : 0) : t.review_requests,
      b.review_delay_hours !== undefined ? Number(b.review_delay_hours) : t.review_delay_hours,
      msg !== undefined ? (msg === owner.DEFAULT_REVIEW_MESSAGE ? null : msg) : t.review_message,
      b.pay_over_time !== undefined ? (b.pay_over_time ? 1 : 0) : t.pay_over_time, t.id);
    send(res, 200, ownerSettings(getTenant(t.id)));
  }, { auth: 'owner' });

  // ---------- owner features: background sender ----------
  // Customer texts and emails that go out later (confirmations, reminders, review requests, update
  // emails). Each message is claimed with a single UPDATE … WHERE status = 'pending', so it goes out
  // once even with several workers. Texts only go out 8am to 8pm in the business's time zone; outside
  // that they wait for 8am. The wording is built at send time, so consent and changes are respected.
  const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT'];
  const START_WORDS = ['START', 'UNSTOP', 'YES'];
  // Called from the Twilio reply webhook. A STOP blocks every text to that number from the platform's
  // number (Twilio enforces it too), including appointment texts.
  function recordSmsReply(k, word) {
    if (!k) return;
    if (STOP_WORDS.includes(word)) db.prepare('INSERT OR REPLACE INTO sms_stops (phone_key, word, at) VALUES (?,?,?)').run(k, word, now());
    else if (START_WORDS.includes(word)) db.prepare('DELETE FROM sms_stops WHERE phone_key = ?').run(k);
  }
  const smsStopped = (phone) => Boolean(phoneKey(phone) && db.prepare('SELECT 1 FROM sms_stops WHERE phone_key = ?').get(phoneKey(phone)));

  function queueMessage({ t, kind, channel, to, refId = null, customerId = null, sendAfter = new Date(), meta = null }) {
    db.prepare('INSERT INTO scheduled_messages (tenant_id, kind, channel, to_addr, ref_id, customer_id, meta, send_after, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(t.id, kind, channel, to, refId, customerId, meta ? JSON.stringify(meta) : null, owner.utcString(sendAfter), now());
  }
  const cancelMessages = (tid, kinds, refId) => db.prepare(`UPDATE scheduled_messages SET status = 'canceled' WHERE tenant_id = ? AND ref_id = ? AND status = 'pending' AND kind IN (${kinds.map(() => '?').join(',')})`).run(tid, refId, ...kinds);
  const unsubHeaders = (u) => ({ 'List-Unsubscribe': `<${u}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });

  // What to send for one queued message right now, or { skip: reason }.
  function buildMessage(m, t, at = new Date()) {
    const tz = owner.tzOf(t);
    const meta = jparse(m.meta, {});
    const emailOpts = { fromName: t.name, replyTo: t.email || undefined };
    if (m.kind === 'job_confirm' || m.kind === 'job_reminder') {
      const job = scoped('jobs', m.ref_id, t.id);
      if (!job || job.status === 'canceled' || job.status === 'done') return { skip: 'The appointment was canceled or finished.' };
      if (owner.parseUtc(job.start_at) < at) return { skip: 'The appointment already started.' };
      const to = m.channel === 'sms' ? toE164(job.customer_phone) : normEmail(job.customer_email);
      if (!to || (m.channel === 'email' && !/^\S+@\S+\.\S+$/.test(to))) return { skip: 'No contact for this customer.' };
      if (m.channel === 'sms' && smsStopped(to)) return { skip: 'This number replied STOP.' };
      const w = owner.jobMessage(m.kind, m.channel, { t, job, tz, updated: Boolean(meta.updated) });
      return { to, ...w, opts: emailOpts };
    }
    if (m.kind === 'review') {
      const rs = owner.reviewSettings(t);
      if (!rs.active) return { skip: 'Review requests are turned off.' };
      const c = m.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ?').get(m.customer_id, t.id) : null;
      if (!c) return { skip: 'Customer not found.' };
      const pay = db.prepare('SELECT * FROM payments WHERE id = ? AND tenant_id = ?').get(m.ref_id, t.id);
      const q = pay?.quote_id ? db.prepare('SELECT signer_name, customer_name FROM quotes WHERE id = ?').get(pay.quote_id) : null;
      const name = q?.signer_name || q?.customer_name || c.name;
      if (m.channel === 'email') {
        if (!c.email_opt_in || normEmail(c.email) !== m.to_addr) return { skip: 'The customer unsubscribed from emails.' };
        const unsub = `${publicBase()}/u/${c.unsub_token}`;
        return { to: m.to_addr, ...owner.reviewMessage('email', { t, name, link: rs.link, message: rs.message, unsubUrl: unsub }), opts: { ...emailOpts, headers: unsubHeaders(unsub) } };
      }
      if (!c.sms_opt_in || phoneKey(c.phone) !== phoneKey(m.to_addr)) return { skip: 'The customer didn’t agree to texts.' };
      if (smsStopped(m.to_addr)) return { skip: 'This number replied STOP.' };
      return { to: toE164(m.to_addr), ...owner.reviewMessage('sms', { t, name, link: rs.link, message: rs.message }) };
    }
    if (m.kind === 'campaign') {
      const cp = db.prepare('SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?').get(m.ref_id, t.id);
      const c = m.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ?').get(m.customer_id, t.id) : null;
      if (!cp || !c) return { skip: 'Not found.' };
      if (!c.email_opt_in || normEmail(c.email) !== m.to_addr) return { skip: 'The customer unsubscribed.' };
      const address = owner.postalAddress(t);
      if (!address.ok) return { skip: 'The business mailing address is missing.' };
      const unsub = `${publicBase()}/u/${c.unsub_token}`;
      return { to: m.to_addr, ...owner.campaignEmail({ t, subject: cp.subject, body: cp.body, address, unsubUrl: unsub }), opts: { ...emailOpts, headers: unsubHeaders(unsub) } };
    }
    return { skip: 'Unknown message.' };
  }

  function finishMessage(m, status, error, at) {
    db.prepare('UPDATE scheduled_messages SET status = ?, error = ?, sent_at = ? WHERE id = ?').run(status, error || null, status === 'sent' ? owner.utcString(at) : null, m.id);
    if (m.kind === 'campaign') {
      const col = status === 'sent' ? 'sent' : status === 'skipped' ? 'skipped' : 'failed';
      db.prepare(`UPDATE campaigns SET ${col} = ${col} + 1 WHERE id = ?`).run(m.ref_id);
      const left = db.prepare(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE kind = 'campaign' AND ref_id = ? AND status IN ('pending','sending')`).get(m.ref_id).n;
      if (!left) db.prepare(`UPDATE campaigns SET status = 'done', finished_at = COALESCE(finished_at, ?) WHERE id = ?`).run(now(), m.ref_id);
    }
  }

  // Sends what's due at `nowOverride` (default: now), up to `limit` messages per run (update emails
  // go out in batches this way). Returns counts. Tests call this directly instead of waiting for the timer.
  async function runDueMessages(nowOverride, { limit = 50 } = {}) {
    const at = nowOverride ? new Date(nowOverride) : new Date();
    const out = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
    const due = db.prepare(`SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_after <= ? ORDER BY send_after, id LIMIT ?`).all(owner.utcString(at), limit);
    for (const m of due) {
      const t = getTenant(m.tenant_id);
      if (!t) continue;
      const tz = owner.tzOf(t);
      if (m.channel === 'sms' && !owner.inTextHours(at, tz)) {
        if (db.prepare(`UPDATE scheduled_messages SET send_after = ? WHERE id = ? AND status = 'pending'`).run(owner.utcString(owner.nextTextWindow(at, tz)), m.id).changes) out.deferred++;
        continue;
      }
      // Claim it. Only the worker whose UPDATE changes the row sends it.
      if (!db.prepare(`UPDATE scheduled_messages SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'`).run(m.id).changes) continue;
      try {
        if (m.channel === 'sms' ? !notify.smsEnabled : !notify.emailEnabled) { finishMessage(m, 'skipped', m.channel === 'sms' ? 'Texting isn’t set up.' : 'Email isn’t set up.', at); out.skipped++; continue; }
        const msg = buildMessage(m, t, at);
        if (msg.skip) { finishMessage(m, 'skipped', msg.skip, at); out.skipped++; continue; }
        let ok = true;
        if (m.channel === 'sms') await notify.sms(msg.to, msg.text);
        else ok = await notify.email(msg.to, msg.subject, msg.text, msg.opts);
        if (ok) { finishMessage(m, 'sent', null, at); out.sent++; }
        else if (m.attempts + 1 < 3) { db.prepare(`UPDATE scheduled_messages SET status = 'pending', send_after = ?, error = 'Email failed; trying again' WHERE id = ?`).run(owner.utcString(at.getTime() + 10 * 60_000), m.id); out.failed++; }
        else { finishMessage(m, 'failed', 'Email failed', at); out.failed++; }
      } catch (e) {
        console.error('Scheduled message failed', m.id, e);
        finishMessage(m, 'failed', String(e.message).slice(0, 300), at); out.failed++;
      }
    }
    return out;
  }
  if (!env.DISABLE_WORKER) {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await runDueMessages(); } catch (e) { console.error('Background sender failed', e); } finally { busy = false; }
    }, Number(env.WORKER_INTERVAL_MS) || 30_000).unref();
  }

  // ---------- owner features: review requests ----------
  // After a job is paid, ask for a Google review: by email to customers who agreed to emails, and by
  // text only to customers who agreed to texts. At most once per customer every 90 days.
  function scheduleReviewRequest(paymentId) {
    const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!pay || pay.kind !== 'quote' || pay.status !== 'paid' || !pay.quote_id) return;
    const t = getTenant(pay.tenant_id);
    const rs = owner.reviewSettings(t);
    if (!rs.active) return;
    if (db.prepare(`SELECT 1 FROM scheduled_messages WHERE tenant_id = ? AND kind = 'review' AND ref_id = ?`).get(t.id, pay.id)) return;
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(pay.quote_id);
    const c = findCustomer(t.id, q.customer_phone, q.customer_email);
    if (!c) return; // never signed up for anything: receipt only
    const since = owner.utcString(Date.now() - owner.REVIEW_REPEAT_DAYS * 864e5);
    if (db.prepare(`SELECT 1 FROM scheduled_messages WHERE tenant_id = ? AND kind = 'review' AND customer_id = ? AND status IN ('pending','sending','sent') AND created_at >= ?`).get(t.id, c.id, since)) return;
    const at = new Date(owner.parseUtc(pay.paid_at).getTime() + rs.delayHours * 3600_000);
    if (c.email && c.email_opt_in) queueMessage({ t, kind: 'review', channel: 'email', to: normEmail(c.email), refId: pay.id, customerId: c.id, sendAfter: at });
    if (c.sms_opt_in && phoneKey(c.phone) && !smsStopped(c.phone)) queueMessage({ t, kind: 'review', channel: 'sms', to: c.phone, refId: pay.id, customerId: c.id, sendAfter: at });
  }

  // Customers and who's subscribed
  route('GET', '/api/customers', async (req, res, p, url, { tenant: t }) => {
    send(res, 200, db.prepare('SELECT id, name, phone, email, email_opt_in, sms_opt_in, email_consent_at, sms_consent_at, email_unsubscribed_at, source, created_at FROM customers WHERE tenant_id = ? ORDER BY id DESC LIMIT 2000').all(t.id));
  }, { auth: 'tenant' });
  route('GET', '/api/customers.csv', async (req, res, p, url, { tenant: t }) => {
    const rows = db.prepare('SELECT name, phone, email, email_opt_in, email_consent_at, email_unsubscribed_at, sms_opt_in, sms_consent_at, source, created_at FROM customers WHERE tenant_id = ? ORDER BY id').all(t.id);
    const cell = (v) => { const x = String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' '); return /[",\r\n]/.test(x) || /^[=+\-@\t]/.test(x) ? `"${(/^[=+\-@\t]/.test(x) ? "'" : '') + x.replace(/"/g, '""')}"` : x; };
    const head = ['name', 'phone', 'email', 'email_updates', 'email_consent_at', 'email_unsubscribed_at', 'texts', 'text_consent_at', 'source', 'added'];
    const body = rows.map((r) => [r.name, r.phone, r.email, r.email_opt_in ? 'yes' : 'no', r.email_consent_at, r.email_unsubscribed_at, r.sms_opt_in ? 'yes' : 'no', r.sms_consent_at, r.source, r.created_at].map(cell).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="customers.csv"', 'Cache-Control': 'no-store' });
    res.end([head.join(','), ...body].join('\n') + '\n');
  }, { auth: 'tenant' });

  // Website content and local search (each business edits its own)
  function websiteState(req, t) {
    const profile = siteProfile.parseProfile(t.site_profile);
    const productsCount = db.prepare('SELECT COUNT(*) AS n FROM products WHERE tenant_id = ? AND active = 1 AND on_site = 1').get(t.id).n;
    const u = siteUrls(t, baseUrl(req));
    return {
      profile,
      checklist: siteProfile.checklist(t, profile, productsCount),
      site_url: u.abs('/'),
      city_urls: profile.cities.map((c) => u.abs('/areas/' + siteProfile.citySlug(c))),
      file_urls: Object.fromEntries(profile.resources.map((r) => [r.file, u.abs('/files/' + r.file)])),
      limits: siteProfile.LIMITS, states: siteProfile.STATES, city_intro_min: siteProfile.CITY_INTRO_MIN, icons: siteProfile.HIGHLIGHT_ICONS,
      banner_urls: { desktop: profile.banner.desktop ? `/media/${t.slug}/${profile.banner.desktop}` : '', mobile: profile.banner.mobile ? `/media/${t.slug}/${profile.banner.mobile}` : '' },
      business: { name: t.name, phone: t.phone, service_area: t.service_area },
    };
  }
  route('GET', '/api/website', async (req, res, p, url, { tenant: t }) => {
    send(res, 200, websiteState(req, t));
  }, { auth: 'tenant' });
  route('PUT', '/api/website', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req, 400_000);
    let profile;
    try { profile = siteProfile.cleanProfile(b, siteProfile.parseProfile(t.site_profile)); }
    catch (e) { if (e instanceof siteProfile.ProfileError) return send(res, 422, { error: e.message, field_errors: e.errors }); throw e; }
    // Re-read inside the write so a file uploaded meanwhile isn't lost.
    const fresh = siteProfile.parseProfile(getTenant(t.id).site_profile);
    const known = new Set(profile.resources.map((r) => r.file));
    for (const r of fresh.resources) if (!known.has(r.file)) profile.resources.push(r);
    profile.resources = profile.resources.filter((r) => fresh.resources.some((x) => x.file === r.file));
    db.prepare('UPDATE tenants SET site_profile = ? WHERE id = ?').run(JSON.stringify(profile), t.id);
    send(res, 200, websiteState(req, getTenant(t.id)));
  }, { auth: 'owner' });
  route('POST', '/api/website/resources', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req, Math.ceil(siteProfile.LIMITS.resourceBytes * 1.4) + 10_000);
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) throw new HttpError(400, 'Give the file a title customers will recognize.');
    const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(b.file || '');
    const buf = m ? Buffer.from(m[1], 'base64') : null;
    if (!buf || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'Upload a PDF file.');
    if (buf.length > siteProfile.LIMITS.resourceBytes) throw new HttpError(413, 'That PDF is larger than 10 MB. Save a smaller copy and try again.');
    const profile = siteProfile.parseProfile(getTenant(t.id).site_profile);
    if (profile.resources.length >= siteProfile.LIMITS.resources) throw new HttpError(409, `You can share up to ${siteProfile.LIMITS.resources} files. Remove one first.`);
    const file = `t${t.id}-doc-${randomToken(12)}.pdf`;
    fs.writeFileSync(path.join(uploads, file), buf);
    profile.resources.push({ file, title, description: String(b.description || '').trim().slice(0, 300), size: buf.length, added_at: now() });
    db.prepare('UPDATE tenants SET site_profile = ? WHERE id = ?').run(JSON.stringify(profile), t.id);
    send(res, 201, websiteState(req, getTenant(t.id)));
  }, { auth: 'owner' });
  route('DELETE', '/api/website/resources/:file', async (req, res, p, url, { tenant: t }) => {
    const profile = siteProfile.parseProfile(getTenant(t.id).site_profile);
    const r = profile.resources.find((x) => x.file === p.file);
    if (!r) throw new HttpError(404, 'Not found');
    profile.resources = profile.resources.filter((x) => x.file !== r.file);
    db.prepare('UPDATE tenants SET site_profile = ? WHERE id = ?').run(JSON.stringify(profile), t.id);
    try { fs.unlinkSync(path.join(uploads, path.basename(r.file))); } catch { /* already gone */ }
    send(res, 200, websiteState(req, getTenant(t.id)));
  }, { auth: 'owner' });

  // Banner picture for the bold site look: a wide one, and optionally a tighter crop for phones.
  route('POST', '/api/website/banner', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req, 12_000_000);
    if (!['desktop', 'mobile'].includes(b.kind)) throw new HttpError(400, 'Unknown banner.');
    const name = saveImage(b.image, `t${t.id}-site`, 6_000_000);
    if (!name) throw new HttpError(400, 'Use a JPG, PNG or WebP image.');
    const profile = siteProfile.parseProfile(getTenant(t.id).site_profile);
    const old = profile.banner[b.kind];
    profile.banner[b.kind] = name;
    db.prepare('UPDATE tenants SET site_profile = ? WHERE id = ?').run(JSON.stringify(profile), t.id);
    if (old) try { fs.unlinkSync(path.join(uploads, path.basename(old))); } catch { /* gone */ }
    send(res, 200, websiteState(req, getTenant(t.id)));
  }, { auth: 'owner' });
  route('DELETE', '/api/website/banner/:kind', async (req, res, p, url, { tenant: t }) => {
    if (!['desktop', 'mobile'].includes(p.kind)) throw new HttpError(404, 'Not found');
    const profile = siteProfile.parseProfile(getTenant(t.id).site_profile);
    const old = profile.banner[p.kind];
    profile.banner[p.kind] = '';
    db.prepare('UPDATE tenants SET site_profile = ? WHERE id = ?').run(JSON.stringify(profile), t.id);
    if (old) try { fs.unlinkSync(path.join(uploads, path.basename(old))); } catch { /* gone */ }
    send(res, 200, websiteState(req, getTenant(t.id)));
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

  // The business's own Stripe account (Accounts v2, merchant configuration, full Stripe Dashboard).
  // Businesses on a legacy Express payout account get a new account here; the old one is kept so
  // payments taken before the switch can still pay out.
  const creatingAccount = new Map(); // tenant id -> in-flight account creation (double-click safety)
  route('POST', '/api/stripe/connect', async (req, res, p, url, { tenant: t, user }) => {
    if (!stripe.enabled) throw new HttpError(503, 'Payments aren’t switched on for the platform yet. Contact support.');
    let acct = isMerchant(t) ? t.stripe_account_id : null;
    if (!acct) {
      if (!creatingAccount.has(t.id)) {
        creatingAccount.set(t.id, (async () => {
          const fresh = getTenant(t.id);
          if (isMerchant(fresh)) return fresh.stripe_account_id;
          const id = (await stripe.createMerchantAccount({ email: fresh.email || user.email, businessName: fresh.name, tenantId: fresh.id })).id;
          db.prepare(`UPDATE tenants SET legacy_stripe_account_id = COALESCE(legacy_stripe_account_id, stripe_account_id), stripe_account_id = ?, stripe_account_type = 'v2_merchant', stripe_payouts_enabled = 0, stripe_details_submitted = 0 WHERE id = ? AND COALESCE(stripe_account_type, '') != 'v2_merchant'`).run(id, fresh.id);
          return getTenant(fresh.id).stripe_account_id;
        })().finally(() => creatingAccount.delete(t.id)));
      }
      acct = await creatingAccount.get(t.id);
    }
    const link = await stripe.merchantAccountLink({ account: acct, refreshUrl: `${baseUrl(req)}/admin/#/onboarding/refresh`, returnUrl: `${baseUrl(req)}/admin/#/onboarding/return` });
    send(res, 200, { url: link.url });
  }, { auth: 'owner', onboarding: true });
  route('POST', '/api/stripe/refresh', async (req, res, p, url, { tenant: t }) => {
    const fresh = await refreshStripeStatus(t);
    send(res, 200, { payouts_enabled: Boolean(fresh.stripe_payouts_enabled), details_submitted: Boolean(fresh.stripe_details_submitted) });
  }, { auth: 'tenant', onboarding: true });
  route('POST', '/api/stripe/dashboard', async (req, res, p, url, { tenant: t }) => {
    if (!t.stripe_account_id) throw new HttpError(409, 'Connect your Stripe account first.');
    // Full-Dashboard accounts sign in to Stripe directly; login links are only for legacy Express accounts.
    if (isMerchant(t)) return send(res, 200, { url: 'https://dashboard.stripe.com/' });
    send(res, 200, { url: (await stripe.loginLink(t.stripe_account_id)).url });
  }, { auth: 'owner' });

  // ===== one-time business setup + customer Terms & Conditions =====
  route('GET', '/api/legal-profile', async (req, res, p, url, { tenant: t }) => {
    const st = termsState(t);
    send(res, 200, {
      profile: st.profile || customerTerms.defaultProfile(), saved: Boolean(st.profile), complete: st.complete, missing: st.missing,
      tax_rate_bp: t.tax_rate_bp, phone: t.phone || '', email: t.email || '',
      options: { states: customerTerms.STATE_NAMES, balance_due: Object.fromEntries(Object.entries(customerTerms.BALANCE_DUE).map(([k, v]) => [k, v.label])) },
    });
  }, { auth: 'tenant' });

  route('PUT', '/api/legal-profile', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    const { profile, errors } = customerTerms.validateProfile(b.profile || {});
    let taxBp = t.tax_rate_bp;
    if (b.tax_rate_bp !== undefined) {
      const n = Number(b.tax_rate_bp);
      if (!Number.isInteger(n) || n < 0 || n > 3000) errors.tax_rate_bp = 'Sales tax must be between 0% and 30%.'; else taxBp = n;
    }
    if (Object.keys(errors).length) return send(res, 422, { error: 'Please fix the highlighted fields.', field_errors: errors });
    // The sales tax rate here is the same default used on new quotes (Settings).
    db.prepare('UPDATE tenants SET legal_profile = ?, tax_rate_bp = ? WHERE id = ?').run(JSON.stringify(profile), taxBp, t.id);
    const st = termsState(getTenant(t.id));
    send(res, 200, { profile, saved: true, complete: st.complete, missing: st.missing, needs_review: st.needsReview, tax_rate_bp: taxBp });
  }, { auth: 'owner' });

  route('GET', '/api/customer-terms', async (req, res, p, url, { tenant: t, user, isSuper }) => {
    const st = termsState(t);
    const a = st.adopted;
    send(res, 200, {
      profile_complete: st.complete, missing: st.missing, template_version: customerTerms.TEMPLATE_VERSION,
      draft: st.draft, legal_name: st.profile?.legalName || '', platform_name: platformName,
      approved: a ? { version: a.version, approved_at: a.approved_at, approver_name: a.approver_name, approver_title: a.approver_title, source: a.source, sha256: a.sha256, markdown: a.markdown } : null,
      needs_review: st.needsReview,
      public_url: `${baseUrl(req)}${termsPath(t)}`,
      // Final approval belongs to the business owner, never to platform staff viewing the account.
      can_approve: !isSuper && user.role === 'owner',
    });
  }, { auth: 'tenant' });

  // Final approval by the business owner. Each approval is a new immutable version with the exact
  // wording, a SHA-256 fingerprint, the owner's typed name and title, the attestation they
  // confirmed, and their IP and device.
  route('POST', '/api/customer-terms/approve', async (req, res, p, url, { tenant: t, user, isSuper }) => {
    if (isSuper) throw new HttpError(403, 'Only the business owner can give final approval of their customer terms.');
    const b = await json(req, 200_000);
    const st = termsState(getTenant(t.id)); // computed after reading the body, from fresh data
    if (!st.complete) throw new HttpError(409, 'Complete your business details first.');
    const name = clean(b.name, 120), title = clean(b.title, 80);
    if (!name || !title) throw new HttpError(400, 'Type your full name and your title (for example, Owner).');
    if (!b.authorized || !b.reviewed || !b.seller_of_record) throw new HttpError(400, 'Please confirm all three statements to give final approval.');
    const markdown = String(b.markdown || '').replace(/\r\n/g, '\n').trim() + '\n';
    if (markdown.length < 500 || markdown.length > 60000) throw new HttpError(400, 'The terms must be between 500 and 60,000 characters.');
    if (/\[\[MISSING:|\{\{[#/]?\w+\}\}/.test(markdown)) throw new HttpError(400, 'The terms still contain unfilled placeholders. Replace or remove them first.');
    const attestation = customerTerms.attestationText({ name, title, legalName: st.profile.legalName, platformName });
    const version = (st.adopted?.version || 0) + 1;
    const sha = customerTerms.sha256(markdown);
    try {
      db.prepare(`INSERT INTO customer_terms (tenant_id, version, markdown, sha256, source, template_version, profile_fingerprint, approver_user_id, approver_name, approver_title, attestation, ip, ua) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(t.id, version, markdown, sha, markdown === st.draft ? 'template' : 'customized', customerTerms.TEMPLATE_VERSION, customerTerms.fingerprint(st.vars), user.id, name, title, attestation, clientIp(req), clean(req.headers['user-agent'], 400));
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Another approval was just saved. Reload the page to see it.');
      throw e;
    }
    send(res, 201, { version, sha256: sha, public_url: `${baseUrl(req)}${termsPath(t, version)}` });
  }, { auth: 'owner' });

  // Payments and payouts for the business.
  route('GET', '/api/payments', async (req, res, p, url, { tenant: t }) => {
    send(res, 200, db.prepare(`SELECT id, kind, description, amount_cents, method, status, stripe_fee_cents, fee_cents, payout_cents, transfer_status, paid_at, created_at FROM payments WHERE tenant_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 200`).all(t.id));
  }, { auth: 'tenant' });

  // ===== Agilities super admin =====
  route('GET', '/api/super/overview', async (req, res) => {
    const month = new Date().toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT t.id, t.slug, t.name, t.status, t.created_at, t.stripe_account_id, t.stripe_account_type, t.stripe_payouts_enabled, t.stripe_details_submitted, t.fee_bp, t.custom_domain,
        (SELECT MAX(version) FROM customer_terms ct WHERE ct.tenant_id = t.id) AS terms_version,
        (SELECT email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner_email,
        (SELECT MAX(last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_login_at,
        (SELECT COUNT(*) FROM requests r WHERE r.tenant_id = t.id) AS requests,
        (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid') AS paid_cents,
        (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid' AND p.method = 'card') AS online_cents,
        (SELECT COALESCE(SUM(fee_cents - fee_refunded_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid') AS fee_cents,
        (SELECT COALESCE(SUM(fee_cents - fee_refunded_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid' AND substr(p.paid_at,1,7) = ?) AS fee_month_cents,
        (SELECT COALESCE(SUM(stripe_fee_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.status = 'paid') AS stripe_fee_cents,
        (SELECT COALESCE(SUM(payout_cents),0) FROM payments p WHERE p.tenant_id = t.id AND p.transfer_status IN ('sent','direct')) AS payout_cents,
        (SELECT COUNT(*) FROM payments p WHERE p.tenant_id = t.id AND p.transfer_status IN ('pending','failed')) AS payouts_waiting
      FROM tenants t ORDER BY t.id DESC`).all(month);
    const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    send(res, 200, {
      platform: { ...platformSettings(db), stripe_ready: stripe.enabled, test_mode: stripe.testMode, sms: notify.smsEnabled, email: notify.emailEnabled },
      totals: { businesses: rows.length, active: rows.filter((r) => r.status === 'active').length, paid_cents: sum('paid_cents'), online_cents: sum('online_cents'), fee_cents: sum('fee_cents'), fee_month_cents: sum('fee_month_cents'), stripe_fee_cents: sum('stripe_fee_cents'), payout_cents: sum('payout_cents'), payouts_waiting: sum('payouts_waiting') },
      leads_new: db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status = 'new'`).get().n,
      tenants: rows,
    });
  }, { auth: 'super' });

  route('POST', '/api/super/stripe-check', async (req, res) => {
    if (!stripe.enabled) return send(res, 200, { ok: false, error: 'No STRIPE_SECRET_KEY is set on the server.' });
    const key = String(env.STRIPE_SECRET_KEY);
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{20,}$/.test(key)) return send(res, 200, { ok: false, error: 'STRIPE_SECRET_KEY doesn’t look like a Stripe key. It should start with sk_test_ (or rk_test_) followed by a long string of letters and numbers, with no spaces.' });
    try {
      const a = await stripe.platformAccount();
      send(res, 200, { ok: true, test_mode: stripe.testMode, account_id: a.id, name: a.settings?.dashboard?.display_name || a.business_profile?.name || '', charges_enabled: Boolean(a.charges_enabled), details_submitted: Boolean(a.details_submitted) });
    } catch (e) {
      send(res, 200, { ok: false, error: `Stripe rejected the key: ${e.message}` });
    }
  }, { auth: 'super' });

  route('GET', '/api/super/tenants/:id', async (req, res, p) => {
    const t = getTenant(p.id); if (!t) throw new HttpError(404, 'Not found');
    send(res, 200, {
      tenant: publicTenant(t), fee_bp: t.fee_bp, site_url: `${baseUrl(req)}/s/${t.slug}`,
      users: db.prepare('SELECT id, name, email, role, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY id').all(t.id),
      agreements: db.prepare('SELECT a.doc, a.version, a.accepted_at, a.ip, u.email FROM agreements a LEFT JOIN users u ON u.id = a.user_id WHERE a.tenant_id = ? ORDER BY a.id DESC').all(t.id),
      // Owner approvals of the business's customer Terms & Conditions (audit trail).
      customer_terms: db.prepare('SELECT version, source, sha256, approver_name, approver_title, approved_at, ip FROM customer_terms WHERE tenant_id = ? ORDER BY version DESC').all(t.id),
      terms_url: `${baseUrl(req)}${termsPath(t)}`,
      payments: db.prepare(`SELECT id, kind, description, amount_cents, stripe_fee_cents, fee_cents, payout_cents, transfer_status, transfer_error, method, status, paid_at, created_at FROM payments WHERE tenant_id = ? ORDER BY id DESC LIMIT 100`).all(t.id),
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
    const acct = b.stripe_account_id !== undefined ? (clean(b.stripe_account_id, 80) || null) : t.stripe_account_id;
    if (acct && !/^acct_[A-Za-z0-9]+$/.test(acct)) throw new HttpError(400, 'Stripe account IDs look like acct_123…');
    // A manually linked account is treated as the business's own (v2 merchant) Stripe account.
    db.prepare('UPDATE tenants SET status = ?, fee_bp = ? WHERE id = ?').run(status, feeBp, t.id);
    if (acct !== t.stripe_account_id) {
      // Keep a legacy Express payout account so earlier payments still pay out; start the new
      // account unverified until Stripe says otherwise.
      db.prepare(`UPDATE tenants SET legacy_stripe_account_id = COALESCE(legacy_stripe_account_id, CASE WHEN stripe_account_type IS NULL THEN stripe_account_id END),
        stripe_account_id = ?, stripe_account_type = CASE WHEN ? IS NULL THEN NULL ELSE 'v2_merchant' END, stripe_payouts_enabled = 0, stripe_details_submitted = 0 WHERE id = ?`).run(acct, acct, t.id);
    }
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
    send(res, 200, platformSettings(db));
  }, { auth: 'super' });

  route('GET', '/api/super/fees.csv', async (req, res) => {
    const rows = db.prepare(`SELECT p.paid_at, t.name AS business, p.description, p.amount_cents, p.stripe_fee_cents, p.fee_cents, p.payout_cents, p.transfer_status, p.transfer_id, p.charge_id FROM payments p JOIN tenants t ON t.id = p.tenant_id WHERE p.status = 'paid' AND p.method = 'card' ORDER BY p.paid_at DESC`).all();
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const d = (c) => (c / 100).toFixed(2);
    const csv = ['Paid at,Business,Description,Customer paid,Stripe fee,Platform share,Processing Fee total,Payout to business,Payout status,Transfer,Charge']
      .concat(rows.map((r) => [r.paid_at, r.business, r.description, d(r.amount_cents), d(r.stripe_fee_cents), d(r.fee_cents), d(r.stripe_fee_cents + r.fee_cents), d(r.payout_cents), r.transfer_status, r.transfer_id, r.charge_id].map(q).join(','))).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="processing-fees.csv"', 'Cache-Control': 'no-store' });
    res.end(csv);
  }, { auth: 'super' });

  route('POST', '/api/super/payments/:id/settle', async (req, res, p) => {
    const pay = db.prepare('SELECT token FROM payments WHERE id = ?').get(p.id);
    if (!pay) throw new HttpError(404, 'Not found');
    const fresh = await settle(pay.token);
    send(res, 200, { transfer_status: fresh.transfer_status, transfer_error: fresh.transfer_error });
  }, { auth: 'super' });

  // ===== platform marketing: owner leads =====
  route('POST', '/api/public/leads', async (req, res) => {
    if (limited('lead:' + clientIp(req), 8, 3600_000)) throw new HttpError(429, 'Too many requests. Email us instead.');
    const b = await json(req);
    if (b.website) return send(res, 201, { ok: true });
    const email = clean(b.email, 200), phone = clean(b.phone, 40);
    if (!clean(b.name) || (!/^\S+@\S+\.\S+$/.test(email) && !phone)) throw new HttpError(400, 'Add your name and an email or phone number.');
    const r = db.prepare(`INSERT INTO leads (name, email, phone, business_name, location, certifications, message, source) VALUES (?,?,?,?,?,?,?,?)`)
      .run(clean(b.name, 120), email, phone, clean(b.business_name, 160), clean(b.location, 160), clean(b.certifications, 300), clean(b.message, 3000), clean(b.source, 200));
    notify.email(platformEmail, `New ${platformName} lead: ${clean(b.name, 80)}`, `${clean(b.name, 120)} | ${email} | ${phone}\nBusiness: ${clean(b.business_name, 160)}\nLocation: ${clean(b.location, 160)}\nCertifications: ${clean(b.certifications, 300)}\n\n${clean(b.message, 3000)}\n\n${baseUrl(req)}/admin/#/leads`);
    notify.sms(env.PLATFORM_NOTIFY_PHONE, `New ${platformName} lead: ${clean(b.name, 60)} ${phone || email} ${clean(b.location, 60)}`);
    send(res, 201, { ok: true, id: Number(r.lastInsertRowid) });
  });
  route('GET', '/api/super/leads', async (req, res) => send(res, 200, db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 500').all()), { auth: 'super' });
  route('PATCH', '/api/super/leads/:id', async (req, res, p) => {
    const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(p.id); if (!l) throw new HttpError(404, 'Not found');
    const b = await json(req);
    db.prepare('UPDATE leads SET status = ?, notes = ? WHERE id = ?').run(['new', 'contacted', 'signed_up', 'closed'].includes(b.status) ? b.status : l.status, b.notes !== undefined ? clean(b.notes, 4000) : l.notes, l.id);
    send(res, 200, db.prepare('SELECT * FROM leads WHERE id = ?').get(l.id));
  }, { auth: 'super' });

  // ---------- static pages ----------
  const types = { '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
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
  // Business websites embed YouTube videos (thumbnail from i.ytimg.com, player from youtube-nocookie.com
  // only after a visitor clicks play), so their policy allows exactly those two hosts.
  const siteHeaders = {
    ...securityHeaders,
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https://i.ytimg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; form-action 'self'; frame-ancestors 'none'",
  };
  const activeProducts = (t) => db.prepare('SELECT * FROM products WHERE tenant_id = ? AND active = 1 ORDER BY sort, bookable DESC, price_cents DESC, name').all(t.id);
  const liveTenant = (t) => { if (!t || t.status !== 'active') throw new HttpError(404, 'Not found'); return t; };
  function serveSite(req, res, t, onDomain = false) {
    liveTenant(t);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...siteHeaders });
    res.end(renderSite(t, activeProducts(t), siteProfile.parseProfile(t.site_profile), { platformBase: baseUrl(req), onDomain }));
  }
  function serveCity(req, res, t, slug, onDomain = false) {
    liveTenant(t);
    const profile = siteProfile.parseProfile(t.site_profile);
    const city = siteProfile.cityBySlug(profile, slug);
    if (!city) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...siteHeaders });
    res.end(renderCityPage(t, activeProducts(t), profile, city, { platformBase: baseUrl(req), onDomain }));
  }
  function serveService(req, res, t, slug, onDomain = false) {
    liveTenant(t);
    const products = activeProducts(t);
    const product = products.find((x) => hasPage(x) && serviceSlug(x, products) === slug);
    if (!product) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...siteHeaders });
    res.end(renderServicePage(t, products, siteProfile.parseProfile(t.site_profile), product, { platformBase: baseUrl(req), onDomain }));
  }
  // A PDF the business shares with customers (checklists, guides). Only files listed on its site.
  function serveResource(res, t, file) {
    liveTenant(t);
    const r = siteProfile.parseProfile(t.site_profile).resources.find((x) => x.file === file);
    const full = r && path.join(uploads, path.basename(r.file));
    if (!r || !fs.existsSync(full)) throw new HttpError(404, 'Not found');
    const name = (siteProfile.slugify(r.title) || 'document') + '.pdf';
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(full).pipe(res);
  }

  // A business's customer Terms & Conditions, as approved by its owner. ?v=N shows an earlier version
  // (the exact wording a customer accepted then).
  function serveTerms(res, t, url) {
    if (!t || t.status !== 'active') throw new HttpError(404, 'Not found');
    const all = db.prepare('SELECT version, markdown, sha256, approved_at FROM customer_terms WHERE tenant_id = ? ORDER BY version').all(t.id);
    const current = all[all.length - 1];
    const want = Number(url.searchParams.get('v')) || 0;
    const shown = want ? all.find((x) => x.version === want) : current;
    if (!shown) throw new HttpError(404, 'This business hasn’t published its terms yet.');
    const e = customerTerms.escapeHtml;
    const color = hexColor(t.primary_color, '#10243A');
    const date = new Date(shown.approved_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { dateStyle: 'long' });
    const others = all.filter((x) => x !== shown).map((x) => `<a href="?v=${x.version}">v${x.version}</a>`).join(' · ');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...securityHeaders });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms and Conditions — ${e(t.name)}</title><link rel="icon" href="/favicon.svg">
<style>body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1f2b;background:#f6f7f9}main{max-width:820px;margin:0 auto;padding:24px 16px 48px}
header{border-top:6px solid ${color};background:#fff;padding:14px 16px}header strong{display:block;max-width:820px;margin:0 auto}article{background:#fff;border:1px solid #e3e6ec;border-radius:10px;padding:8px 24px}
h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:24px}.muted{color:#5b6475;font-size:.9rem}.mono{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;overflow-wrap:anywhere}a{color:${color}}</style></head>
<body><header><strong>${e(t.name)}</strong></header><main>
<p class="muted">Version ${shown.version} · Approved ${e(date)}${shown === current ? '' : ` · <strong>Superseded</strong> — <a href="?">current version</a>`}</p>
<article>${customerTerms.markdownToHtml(shown.markdown)}</article>
<p class="muted mono">Document fingerprint (SHA-256): ${shown.sha256}</p>${others ? `<p class="muted">Other versions: ${others}</p>` : ''}
</main></body></html>`);
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
              if (!ctx.isSuper && !r.onboarding && needsPayoutSetup(ctx.user, ctx.tenant)) throw new HttpError(428, 'Please connect your Stripe account first.');
              if (r.auth === 'owner' && !ctx.isSuper && ctx.user.role !== 'owner') throw new HttpError(403, 'Only the business owner can change this.');
            }
          }
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          return await r.handler(req, res, params, url, ctx);
        }
        throw new HttpError(404, 'Not found');
      }
      let um;
      if ((um = /^\/u\/([\w-]+)$/.exec(pathname))) {
        // Email unsubscribe. GET shows a button (link scanners don't unsubscribe anyone); POST, from the
        // button or a mail app's one-click unsubscribe, takes effect.
        const c = db.prepare('SELECT * FROM customers WHERE unsub_token = ?').get(um[1]);
        const t = c ? getTenant(c.tenant_id) : { name: platformName };
        let done = false;
        if (c && req.method === 'POST') {
          db.prepare('UPDATE customers SET email_opt_in = 0, email_unsubscribed_at = COALESCE(email_unsubscribed_at, ?), updated_at = ? WHERE tenant_id = ? AND email = ?').run(now(), now(), c.tenant_id, c.email);
          if (c.email_opt_in) logConsent(c.tenant_id, c.id, 'email', 'opt_out', c.email || '', { text: 'Unsubscribe link', ip: clientIp(req), ua: clean(req.headers['user-agent'], 400) });
          done = true;
        }
        else if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        res.writeHead(c ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders });
        return res.end(renderUnsubscribe({ t, customer: c ? db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id) : null, done, actionPath: `/u/${um[1]}` }));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if ((um = /^\/r\/([\w-]+)$/.exec(pathname))) {
        const pay = getPayment(um[1]);
        if (!pay || pay.status !== 'paid') throw new HttpError(404, 'This receipt isn’t available.');
        const t = getTenant(pay.tenant_id);
        const q = pay.quote_id ? db.prepare('SELECT * FROM quotes WHERE id = ?').get(pay.quote_id) : null;
        const items = q ? getItems(q.id) : [];
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders });
        return res.end(renderReceipt({ t, pay, quote: q, items, totals: q ? quoteTotals(q, items) : null, proposalUrl: q ? `/p/${q.token}` : '' }));
      }

      const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      // Send www.<platform domain> to the bare domain so search engines see one site.
      const platformHost = env.PLATFORM_URL ? new URL(env.PLATFORM_URL).host : '';
      if (platformHost && host === 'www.' + platformHost) { res.writeHead(301, { Location: env.PLATFORM_URL.replace(/\/$/, '') + req.url }); return res.end(); }
      let domainTenant = host && !platformHosts.has(host) ? db.prepare('SELECT * FROM tenants WHERE custom_domain = ?').get(host) : null;
      if (domainTenant && !domainTenant.domain_live_at) {
        db.prepare('UPDATE tenants SET domain_live_at = ? WHERE id = ? AND domain_live_at IS NULL').run(now(), domainTenant.id);
        domainTenant = getTenant(domainTenant.id);
      }
      if (pathname === '/') {
        if (domainTenant) return serveSite(req, res, domainTenant, true);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...securityHeaders });
        return res.end(renderLanding({ origin: siteOrigin(req), name: platformName, email: platformEmail }));
      }
      if (domainTenant && pathname === '/robots.txt') return send(res, 200, tenantRobots(`https://${domainTenant.custom_domain}`), { 'Cache-Control': 'public, max-age=3600' });
      if (domainTenant && pathname === '/sitemap.xml') {
        liveTenant(domainTenant);
        return send(res, 200, tenantSitemap(sitePages(domainTenant, siteProfile.parseProfile(domainTenant.site_profile), baseUrl(req), activeProducts(domainTenant))), { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      }
      if (!domainTenant && pathname === '/robots.txt') return send(res, 200, robotsTxt(siteOrigin(req)), { 'Cache-Control': 'public, max-age=3600' });
      if (!domainTenant && pathname === '/sitemap.xml') {
        // Business sites hosted here (no domain of their own) are listed in the platform sitemap.
        const hosted = db.prepare(`SELECT * FROM tenants WHERE status = 'active' AND (custom_domain IS NULL OR custom_domain = '' OR domain_live_at IS NULL) ORDER BY id`).all()
          .flatMap((t) => sitePages(t, siteProfile.parseProfile(t.site_profile), baseUrl(req), activeProducts(t)));
        return send(res, 200, sitemapXml(siteOrigin(req), hosted), { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      }
      if (!domainTenant && pathname === '/llms.txt') return send(res, 200, llmsTxt(siteOrigin(req), platformEmail), { 'Cache-Control': 'public, max-age=3600' });
      if (pathname === '/favicon.ico' || pathname === '/favicon.svg') return serveFile(res, 'brand/favicon.svg');
      if (pathname === '/healthz') return send(res, 200, 'ok');
      if (pathname === '/admin' || pathname === '/admin/') return serveFile(res, 'admin.html');
      if (pathname === '/signup') { res.writeHead(302, { Location: '/admin/#/signup' }); return res.end(); }
      let m;
      if ((m = /^\/s\/([\w-]+)\/?$/.exec(pathname))) return serveSite(req, res, getTenantBySlug(m[1]));
      if ((m = /^\/s\/([\w-]+)\/areas\/([a-z0-9-]+)\/?$/.exec(pathname))) return serveCity(req, res, getTenantBySlug(m[1]), m[2]);
      if (domainTenant && (m = /^\/areas\/([a-z0-9-]+)\/?$/.exec(pathname))) return serveCity(req, res, domainTenant, m[1], true);
      if ((m = /^\/s\/([\w-]+)\/services\/([a-z0-9-]+)\/?$/.exec(pathname))) return serveService(req, res, getTenantBySlug(m[1]), m[2]);
      if (domainTenant && (m = /^\/services\/([a-z0-9-]+)\/?$/.exec(pathname))) return serveService(req, res, domainTenant, m[1], true);
      if ((m = /^\/s\/([\w-]+)\/files\/([\w-]+\.pdf)$/.exec(pathname))) return serveResource(res, getTenantBySlug(m[1]), m[2]);
      if (domainTenant && (m = /^\/files\/([\w-]+\.pdf)$/.exec(pathname))) return serveResource(res, domainTenant, m[1]);
      if ((m = /^\/s\/([\w-]+)\/terms\/?$/.exec(pathname))) return serveTerms(res, getTenantBySlug(m[1]), url);
      if (domainTenant && pathname === '/terms') return serveTerms(res, domainTenant, url);
      if ((m = /^\/media\/([\w-]+)\/([\w.-]+)$/.exec(pathname))) {
        const t = getTenantBySlug(m[1]);
        const B = t ? siteProfile.parseProfile(t.site_profile).banner : {};
        const shown = t ? [t.logo, t.owner_photo, B.desktop, B.mobile, ...db.prepare('SELECT image FROM products WHERE tenant_id = ? AND image IS NOT NULL').all(t.id).map((r) => r.image)] : [];
        if (!t || !m[2].startsWith(`t${t.id}-`) || !shown.includes(m[2])) throw new HttpError(404, 'Not found');
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

  return { handler, db, outbox: notify.outbox, runDueMessages };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { handler } = createApp();
  const port = Number(process.env.PORT || 3000);
  http.createServer(handler).listen(port, () => console.log(`Listening on http://localhost:${port}`));
}
