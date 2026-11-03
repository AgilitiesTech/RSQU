import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, platformSettings, platformFee, quoteTotals, slugify, AGREEMENT_VERSION, BUSINESS_AGREEMENTS } from './src/db.js';
import { hashPassword, verifyPassword, sessions, randomToken, sha256 } from './src/auth.js';
import { stripeClient, verifyStripeSignature, cleanSecret, stripeSettingProblem } from './src/stripe.js';
import * as customerTerms from './src/customer-terms.js';
import { notifier } from './src/notify.js';
import { renderSite, renderCityPage, renderServicePage, serviceSlug, hasPage, sitePages, tenantSitemap, tenantRobots, siteUrls } from './src/site.js';
import * as siteProfile from './src/site-profile.js';
import { draftProposal, normalizeDraft } from './src/ai-proposal.js';
import { renderReceipt, renderUnsubscribe, consentText, money as receiptMoney } from './src/receipt.js';
import { renderLanding, robotsTxt, sitemapXml, llmsTxt, BRAND } from './src/landing.js';
import * as AFF from './src/affiliates.js';
import * as owner from './src/owner-features.js';
import { sealer } from './src/sealed.js';
import * as W9 from './src/w9.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

export function createApp(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const db = openDb(dataDir);
  const uploads = path.join(dataDir, 'uploads');
  const stripe = stripeClient(env);
  const notify = notifier(env);
  // Encrypts affiliates' tax ID and bank numbers (src/sealed.js). Without DATA_ENCRYPTION_KEY, the
  // app won't take W-9s or bank details at all.
  const sealed = sealer(env.DATA_ENCRYPTION_KEY);
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

  // field: the form field the message is about, so the page can point at it.
  class HttpError extends Error { constructor(status, msg, field) { super(msg); this.status = status; if (field) this.field = field; } }

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
    const { totals, paid, due } = quoteDue(q, items);
    return { ...q, photos: jparse(q.photos, []), ai_draft: jparse(q.ai_draft, null), items, totals, payments, paid_cents: paid, due_cents: due };
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
    if (sms && !smsStopped(sms)) await notify.sms(sms, `${t.name}: Thanks${first ? ', ' + first : ''}! We received your payment of ${amount}. Your receipt: ${url}`);
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

  // What's still owed on a quote: the balance less quote payments already made (one can cover only
  // part of it, for example a payment for an older amount).
  function quoteDue(q, items = getItems(q.id)) {
    const totals = quoteTotals(q, items);
    const paid = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE quote_id = ? AND kind = 'quote' AND status = 'paid'`).get(q.id).s;
    return { totals, paid, due: Math.max(0, totals.balance - paid) };
  }
  const ownerEmail = (t) => db.prepare(`SELECT email FROM users WHERE tenant_id = ? AND role = 'owner' ORDER BY id LIMIT 1`).get(t.id)?.email || t.email || '';

  // Records a payment as paid. A quote is marked paid only once what's owed is covered. A payment on a
  // voided quote, a second payment, or one for more or less than was due is kept with a note, and the
  // owner gets a text and an email (they may need to refund it).
  function markPaid(payment, method, sessionId) {
    const offline = method !== 'card';
    const claimed = db.prepare(`UPDATE payments SET status = 'paid', paid_at = ?, method = ?, stripe_session_id = COALESCE(?, stripe_session_id), fee_cents = CASE WHEN ? THEN 0 ELSE fee_cents END WHERE id = ? AND status != 'paid'`)
      .run(now(), method, sessionId || null, offline ? 1 : 0, payment.id);
    if (!claimed.changes) return;
    const t = getTenant(payment.tenant_id);
    let note = '';
    if (payment.kind === 'deposit') {
      refreshCredits(payment.request_id);
      notify.sms(t?.notify_phone, `${money(payment.amount_cents)} deposit paid (request #${payment.request_id}).`);
    } else if (payment.quote_id) {
      const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(payment.quote_id);
      const { totals, paid } = quoteDue(q);
      const before = paid - payment.amount_cents, what = q.kind === 'invoice' ? 'invoice' : 'proposal';
      if (q.status === 'void') note = `This payment came in after you voided the ${what}. You may need to refund it.`;
      else if (q.status === 'paid' || (before > 0 && before >= totals.balance)) note = `The ${what} was already paid, so the customer paid twice. You may need to refund ${money(payment.amount_cents)}.`;
      else if (paid > totals.balance) note = `The customer paid ${money(paid - totals.balance)} more than was due. You may need to refund the difference.`;
      else if (paid < totals.balance) note = `The customer paid less than the balance. ${money(totals.balance - paid)} is still due.`;
      if (q.status !== 'void' && q.status !== 'paid' && paid >= totals.balance) {
        db.prepare(`UPDATE quotes SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), q.id);
        setRequestStatus(q.request_id, 'paid');
      }
      if (note) {
        db.prepare('UPDATE payments SET note = ? WHERE id = ?').run(note, payment.id);
        paymentNeedsAttention(t, q, { ...payment, method }, note);
      } else notify.sms(t?.notify_phone, `Payment received: ${money(payment.amount_cents)} for quote #${payment.quote_id} (${q?.customer_name || 'customer'}).`);
    }
    sendReceipt(payment.id).catch((e) => console.error('Receipt failed', e));
    if (!note) try { scheduleReviewRequest(payment.id); } catch (e) { console.error('Review request failed', e); } // owner features
  }
  function paymentNeedsAttention(t, q, pay, note) {
    const what = q.kind === 'invoice' ? 'invoice' : 'proposal';
    const link = `${publicBase()}/admin/#/quotes/${q.id}`;
    const who = q.signer_name || q.customer_name || 'customer';
    notify.sms(t.notify_phone, `A payment needs your attention: ${money(pay.amount_cents)} for ${what} #${q.id} (${who}). ${note} ${link}`);
    const to = ownerEmail(t);
    if (!to) return;
    notify.email(to, `A payment needs your attention: ${what} #${q.id}`, [
      'Hi,', '', `A payment of ${money(pay.amount_cents)} ${pay.method === 'card' ? 'was made online' : `was recorded (${pay.method})`} for ${what} #${q.id}, ${q.title} (${who}).`, '', note, '',
      ...(pay.method === 'card' ? ['You refund card payments from your Stripe Dashboard.', ''] : []),
      `Open the ${what}: ${link}`, '', platformName,
    ].join('\n')).catch(() => {});
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
  // One Checkout per payment: a reload or a second tab gets the customer's open Checkout back.
  async function startCheckout(req, t, payment, { successPath, cancelPath, email, termsVersion }) {
    if (!onlineReady(t)) throw new HttpError(503, 'Online payments aren’t set up yet for this business. Please pay directly.');
    if (payment.stripe_session_id) {
      const st = await checkoutState(payment);
      if (st.state === 'paying') throw new HttpError(409, PAYING_NOW);
      if (st.state === 'open') {
        if (st.session.amount_total === payment.amount_cents && payment.charge_type === 'direct' && payment.stripe_account === t.stripe_account_id && st.session.url) return st.session.url;
        await expireCheckout(payment, PAYING_NOW);
      }
    }
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

  const PAYING_NOW = 'Your payment is going through. Refresh this page in a minute.';
  const OWNER_PAYING_NOW = 'The customer is paying right now. Refresh in a minute.';
  const checkoutAccount = (pay) => (pay.charge_type === 'direct' ? pay.stripe_account : undefined);
  // Where a payment's Checkout stands at Stripe: 'open', 'paying' (finished, or a bank payment still
  // clearing) or 'gone' (expired, failed or not found), with the session when there is one.
  async function checkoutState(pay) {
    if (!pay.stripe_session_id || !stripe.enabled) return { state: 'gone' };
    let s;
    try { s = await stripe.retrieveCheckout(pay.stripe_session_id, checkoutAccount(pay)); }
    catch (e) {
      if (e.status === 404 || /^No such/i.test(e.message)) return { state: 'gone' };
      throw new HttpError(502, 'We couldn’t reach Stripe. Try again in a minute.');
    }
    if (s.status === 'open') return { state: 'open', session: s };
    if (s.status === 'complete') {
      const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
      const failed = s.payment_status !== 'paid' && pi && ['requires_payment_method', 'canceled'].includes(pi.status);
      return { state: failed ? 'gone' : 'paying', session: s };
    }
    return { state: 'gone', session: s };
  }
  // Closes a payment's open Checkout so it can't be paid. If Stripe won't close it because the customer
  // already paid, refuses with `busy`.
  async function expireCheckout(pay, busy) {
    if (!pay.stripe_session_id || !stripe.enabled) return;
    try { await stripe.expireCheckout(pay.stripe_session_id, checkoutAccount(pay)); return; } catch { /* not open: find out why */ }
    const st = await checkoutState(pay);
    if (st.state === 'paying') throw new HttpError(409, busy);
    if (st.state === 'open') throw new HttpError(502, 'We couldn’t reach Stripe. Try again in a minute.');
  }
  // Expires and cancels every unpaid card payment on a quote (all of them, or all but `keepAmount`).
  async function closeQuoteCheckouts(quoteId, busy, keepAmount = null) {
    const open = db.prepare(`SELECT * FROM payments WHERE quote_id = ? AND status = 'pending' AND method = 'card'`).all(quoteId).filter((p) => p.amount_cents !== keepAmount);
    for (const pay of open) {
      await expireCheckout(pay, busy);
      db.prepare(`UPDATE payments SET status = 'canceled' WHERE id = ? AND status = 'pending'`).run(pay.id);
    }
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
      syncAffiliateLedger(pay.id);
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
    syncAffiliateLedger(pay.id);
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
    const ref = signupReferral(req, b, { email, phone });
    const t = db.prepare(`INSERT INTO tenants (slug, name, phone, email, notify_phone, terms) VALUES (?,?,?,?,?,?)`)
      .run(uniqueSlug(business), business, phone, email, phone, 'Work is done as described above. Anything not listed is quoted separately and only done with your approval. Payment is due when the work is complete.');
    const tid = Number(t.lastInsertRowid);
    if (ref) setReferral(tid, ref.affiliate.id, ref.how);
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
    // Until it's paid, the balance shown is what's still owed (after any part already paid).
    if (full.status !== 'paid') full.totals = { ...full.totals, paid: full.paid_cents, balance: full.due_cents };
    send(res, 200, {
      id: full.id, kind: full.kind || 'proposal', title: full.title, status: full.status, customer_name: full.customer_name, location: full.location, rig: full.rig,
      notes: full.notes, terms: full.terms, tax_rate_bp: full.tax_rate_bp, created_at: full.created_at,
      items: full.items.map(({ name, description, qty, unit_cents, taxable }) => ({ name, description, qty, unit_cents, taxable })),
      totals: full.totals, signer_name: full.signer_name, signature_png: full.signature_png, signed_at: full.signed_at, paid_at: full.paid_at,
      online: onlineQuote(t, full.totals.balance),
      // The owner turned on Affirm/Klarna in Stripe (Settings > Payments): shown for $50 or more.
      pay_over_time: Boolean(t.pay_over_time) && onlineReady(t) && full.totals.balance >= 5000 && full.status !== 'paid',
      business: brand(t),
      // The business's customer Terms & Conditions: the version signed, or the current one to accept.
      customer_terms: publicTerms(t, full.customer_terms_version),
      photos: full.photos.filter((ph) => ph.show).map((ph) => ({ url: `/api/public/proposals/${encodeURIComponent(q.token)}/photos/${encodeURIComponent(ph.file)}` })),
      customer_phone: full.signed_at || full.status === 'paid' || !phoneKey(full.customer_phone) ? undefined : full.customer_phone, customer_email: full.signed_at || full.status === 'paid' ? undefined : full.customer_email,
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
    const { due } = quoteDue(q);
    if (due < 50) throw new HttpError(409, 'Nothing is due on this proposal.');
    await closeQuoteCheckouts(q.id, PAYING_NOW, due); // an open Checkout for another amount can't be paid
    let pay = db.prepare(`SELECT * FROM payments WHERE quote_id = ? AND status = 'pending' AND amount_cents = ? AND method = 'card' ORDER BY id DESC`).get(q.id, due);
    if (!pay) {
      const tok = randomToken();
      db.prepare(`INSERT INTO payments (tenant_id, token, kind, quote_id, request_id, description, amount_cents, method) VALUES (?, ?, 'quote', ?, ?, ?, ?, 'card')`)
        .run(t.id, tok, q.id, q.request_id, `${q.title} (#${q.id})`, due);
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
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], [cleanSecret(env.STRIPE_WEBHOOK_SECRET), cleanSecret(env.STRIPE_CONNECT_WEBHOOK_SECRET)].filter(Boolean))) throw new HttpError(400, 'Bad signature');
    const evt = JSON.parse(raw);
    const o = evt.data?.object;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(evt.type) && o?.payment_status === 'paid') {
      const pay = getPayment(o.client_reference_id || o.metadata?.payment_token || '');
      // Direct charges arrive from the business's account (Connect endpoint, evt.account set);
      // legacy platform charges arrive on the platform endpoint (no evt.account).
      const rightAccount = pay && (pay.charge_type === 'direct' ? evt.account === pay.stripe_account : !evt.account);
      if (pay && rightAccount && o.id === pay.stripe_session_id) { markPaid(pay, 'card', o.id); await settle(pay.token); syncAffiliateLedger(pay.id); }
    } else if (evt.type === 'charge.refunded' && evt.account && o?.id) {
      // How much the business has refunded so far (for the QuickBooks download).
      const refunded = Math.round(Number(o.amount_refunded) || 0);
      const at = evt.created ? owner.utcString(new Date(evt.created * 1000)) : now();
      db.prepare(`UPDATE payments SET refunded_cents = ?, refunded_at = ? WHERE charge_id = ? AND stripe_account = ? AND charge_type = 'direct' AND refunded_cents < ?`).run(refunded, at, o.id, evt.account, refunded);
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
      id: q.id, kind: q.kind, title: q.title, status: q.status, customer_name: q.customer_name, created_at: q.created_at, request_id: q.request_id, totals: quoteTotals(q, getItems(q.id)),
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
    const full = quoteFull(q);
    send(res, 200, { ...full, proposal_url: `${baseUrl(req)}/p/${q.token}`, online: onlineQuote(t, full.due_cents) });
  }, { auth: 'tenant' });

  route('PUT', '/api/quotes/:id', async (req, res, p, url, { tenant: t }) => {
    let q = scoped('quotes', p.id, t.id); if (!q) throw new HttpError(404, 'Not found');
    const locked = (x) => { if (x.signed_at || x.status === 'paid') throw new HttpError(409, 'This quote is signed, so it can’t be changed. Make a new quote instead.'); };
    locked(q);
    const b = await json(req);
    // A Checkout the customer still has open would charge the old amount: close it first.
    await closeQuoteCheckouts(q.id, OWNER_PAYING_NOW);
    q = scoped('quotes', q.id, t.id); locked(q);
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
    const fresh = quoteFull(scoped('quotes', q.id, t.id));
    send(res, 200, { ...fresh, proposal_url: `${baseUrl(req)}/p/${q.token}`, online: onlineQuote(t, fresh.due_cents) });
  }, { auth: 'tenant' });

  route('POST', '/api/quotes/:id/status', async (req, res, p, url, { tenant: t }) => {
    const q = scoped('quotes', p.id, t.id); if (!q) throw new HttpError(404, 'Not found');
    const b = await json(req);
    if (b.status === 'void' && q.status !== 'paid') {
      await closeQuoteCheckouts(q.id, OWNER_PAYING_NOW); // so a voided quote can't be paid
      db.prepare(`UPDATE quotes SET status = 'void', updated_at = ? WHERE id = ? AND status != 'paid'`).run(now(), q.id);
    } else if (b.status === 'draft' && q.status === 'void' && !q.signed_at) db.prepare(`UPDATE quotes SET status = 'draft', updated_at = ? WHERE id = ?`).run(now(), q.id);
    send(res, 200, quoteFull(scoped('quotes', q.id, t.id)));
  }, { auth: 'tenant' });

  route('POST', '/api/quotes/:id/payments', async (req, res, p, url, { tenant: t }) => {
    let q = scoped('quotes', p.id, t.id); if (!q) throw new HttpError(404, 'Not found');
    if (q.status === 'paid') throw new HttpError(409, 'Already paid.');
    if (q.status === 'void') throw new HttpError(409, `This ${q.kind === 'invoice' ? 'invoice' : 'quote'} is void. Restore it first.`);
    const b = await json(req);
    const method = ['cash', 'check', 'other'].includes(b.method) ? b.method : 'cash';
    await closeQuoteCheckouts(q.id, OWNER_PAYING_NOW); // so the customer can't pay online as well
    q = scoped('quotes', q.id, t.id);
    if (q.status === 'paid') throw new HttpError(409, 'Already paid.');
    const { due } = quoteDue(q);
    const tok = randomToken();
    db.prepare(`INSERT INTO payments (tenant_id, token, kind, quote_id, request_id, description, amount_cents, method) VALUES (?, ?, 'quote', ?, ?, ?, ?, ?)`)
      .run(t.id, tok, q.id, q.request_id, `${q.title} (#${q.id})`, due, method);
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
      review: { link: rs.link, enabled: rs.enabled, active: rs.active, delay_hours: rs.delayHours, delays: owner.REVIEW_DELAYS, message: rs.message, default_message: owner.DEFAULT_REVIEW_MESSAGE, repeat_days: owner.REVIEW_REPEAT_DAYS, address_ok: owner.postalAddress(t).ok },
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
        const address = owner.postalAddress(t);
        if (!address.ok) return { skip: 'The business mailing address is missing.' };
        const unsub = `${publicBase()}/u/${c.unsub_token}`;
        return { to: m.to_addr, ...owner.reviewMessage('email', { t, name, link: rs.link, message: rs.message, unsubUrl: unsub, address }), opts: { ...emailOpts, headers: unsubHeaders(unsub) } };
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
    if (m.kind === 'campaign') campaignTally(m.ref_id, status);
  }
  function campaignTally(campaignId, status) {
    const col = status === 'sent' ? 'sent' : status === 'skipped' || status === 'canceled' ? 'skipped' : 'failed';
    db.prepare(`UPDATE campaigns SET ${col} = ${col} + 1 WHERE id = ?`).run(campaignId);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE kind = 'campaign' AND ref_id = ? AND status IN ('pending','sending')`).get(campaignId).n;
    if (!left) db.prepare(`UPDATE campaigns SET status = 'done', finished_at = COALESCE(finished_at, ?) WHERE id = ?`).run(now(), campaignId);
  }
  // A business that isn't active sends nothing: its queued messages are canceled.
  function cancelMessagesOfInactive() {
    const rows = db.prepare(`SELECT m.id, m.kind, m.ref_id FROM scheduled_messages m JOIN tenants t ON t.id = m.tenant_id WHERE m.status = 'pending' AND t.status != 'active'`).all();
    for (const m of rows) {
      if (db.prepare(`UPDATE scheduled_messages SET status = 'canceled', error = 'business suspended' WHERE id = ? AND status = 'pending'`).run(m.id).changes && m.kind === 'campaign') campaignTally(m.ref_id, 'canceled');
    }
    return rows.length;
  }

  // Sends what's due at `nowOverride` (default: now), up to `limit` messages per run (update emails
  // go out in batches this way). Returns counts. Tests call this directly instead of waiting for the timer;
  // they can pass a function as `nowOverride` to make the clock move during a run.
  async function runDueMessages(nowOverride, { limit = 50 } = {}) {
    // The time is read again for every message, so texting hours are checked right before each text.
    const clock = typeof nowOverride === 'function' ? () => new Date(nowOverride()) : () => (nowOverride ? new Date(nowOverride) : new Date());
    const out = { sent: 0, skipped: 0, deferred: 0, failed: 0, canceled: cancelMessagesOfInactive() };
    const due = db.prepare(`SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_after <= ? ORDER BY send_after, id LIMIT ?`).all(owner.utcString(clock()), limit);
    for (const m of due) {
      const t = getTenant(m.tenant_id);
      if (!t) continue;
      if (t.status !== 'active') { out.canceled += cancelMessagesOfInactive(); continue; }
      const at = clock();
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

  // ---------- owner features: scheduling ----------
  const JOB_STATUSES = ['scheduled', 'en_route', 'done', 'canceled'];
  function jobOut(j, tz) {
    const start = owner.parseUtc(j.start_at), end = new Date(start.getTime() + j.duration_min * 60_000);
    const lp = owner.localParts(start, tz);
    return { ...j, date: lp.date, time: lp.time, start_label: owner.formatTime(start, tz), end_label: owner.formatTime(end, tz), when_label: owner.formatWhen(start, tz), end_at: owner.utcString(end) };
  }
  const jobRow = (id, tid) => db.prepare('SELECT j.*, u.name AS assignee_name, u.email AS assignee_email FROM jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.id = ? AND j.tenant_id = ?').get(id, tid);
  // Confirmation now, and a reminder the day before at 9am local (if that's still ahead).
  function queueJobMessages(t, job, { updated = false } = {}) {
    const tz = owner.tzOf(t);
    const start = owner.parseUtc(job.start_at);
    const reminder = owner.zonedTimeToUtc(owner.addDays(owner.localParts(start, tz).date, -1), '09:00', tz);
    const email = normEmail(job.customer_email), sms = toE164(job.customer_phone);
    const meta = updated ? { updated: true } : null;
    if (/^\S+@\S+\.\S+$/.test(email)) queueMessage({ t, kind: 'job_confirm', channel: 'email', to: email, refId: job.id, meta });
    if (sms && !smsStopped(sms)) queueMessage({ t, kind: 'job_confirm', channel: 'sms', to: sms, refId: job.id, meta });
    if (reminder > new Date()) {
      if (/^\S+@\S+\.\S+$/.test(email)) queueMessage({ t, kind: 'job_reminder', channel: 'email', to: email, refId: job.id, sendAfter: reminder });
      if (sms && !smsStopped(sms)) queueMessage({ t, kind: 'job_reminder', channel: 'sms', to: sms, refId: job.id, sendAfter: reminder });
    }
  }
  // Validates the appointment form. Returns the columns to save.
  function jobFields(b, t, cur = {}) {
    const tz = owner.tzOf(t);
    const date = String(b.date ?? ''), time = String(b.time ?? '');
    if (!owner.validDate(date)) throw new HttpError(400, 'Choose a date.');
    if (!owner.validTime(time)) throw new HttpError(400, 'Choose a start time.');
    const duration = Math.trunc(Number(b.duration_min ?? cur.duration_min ?? 60));
    if (!(duration >= 15 && duration <= 720)) throw new HttpError(400, 'Choose how long the job takes, between 15 minutes and 12 hours.');
    const userId = b.user_id ? Number(b.user_id) : null;
    if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(userId, t.id)) throw new HttpError(400, 'Choose someone on your team.');
    const f = {
      customer_name: noCtl(b.customer_name, 120), customer_phone: noCtl(b.customer_phone, 40), customer_email: noCtl(b.customer_email, 200).toLowerCase(),
      address: clean(b.address, 1000), notes: clean(b.notes, 4000), duration_min: duration, user_id: userId,
      start_at: owner.utcString(owner.zonedTimeToUtc(date, time, tz)),
    };
    if (!f.customer_name && !f.customer_phone) throw new HttpError(400, 'Add the customer’s name or phone number.');
    if (f.customer_email && !/^\S+@\S+\.\S+$/.test(f.customer_email)) throw new HttpError(400, 'Check the customer’s email address.');
    if (f.customer_phone && !phoneKey(f.customer_phone)) throw new HttpError(400, 'Check the customer’s phone number. Use 10 digits.');
    return f;
  }

  route('GET', '/api/jobs', async (req, res, p, url, { tenant: t }) => {
    const tz = owner.tzOf(t);
    const today = owner.todayIn(tz);
    let from = owner.validDate(url.searchParams.get('from')) ? url.searchParams.get('from') : today;
    if (url.searchParams.get('snap') === 'week') from = owner.addDays(from, -((new Date(from + 'T00:00:00Z').getUTCDay() + 6) % 7)); // Monday
    const days = Math.max(1, Math.min(31, Math.trunc(Number(url.searchParams.get('days')) || 7)));
    const lo = owner.utcString(owner.zonedTimeToUtc(from, '00:00', tz)), hi = owner.utcString(owner.zonedTimeToUtc(owner.addDays(from, days), '00:00', tz));
    const rows = db.prepare(`SELECT j.*, u.name AS assignee_name, u.email AS assignee_email FROM jobs j LEFT JOIN users u ON u.id = j.user_id
      WHERE j.tenant_id = ? AND j.start_at >= ? AND j.start_at < ? AND j.status != 'canceled' ORDER BY j.start_at, j.id`).all(t.id, lo, hi);
    send(res, 200, { tz, today, from, days, jobs: rows.map((j) => jobOut(j, tz)) });
  }, { auth: 'tenant' });

  // Defaults for a new appointment, from a request or a quote.
  route('GET', '/api/jobs/new', async (req, res, p, url, { tenant: t }) => {
    const r = url.searchParams.get('request_id') ? scoped('requests', url.searchParams.get('request_id'), t.id) : null;
    const q = url.searchParams.get('quote_id') ? scoped('quotes', url.searchParams.get('quote_id'), t.id) : null;
    const src = q || r || {};
    const tz = owner.tzOf(t);
    send(res, 200, {
      tz, today: owner.todayIn(tz), request_id: q?.request_id || r?.id || null, quote_id: q?.id || null,
      customer_name: q?.customer_name || r?.name || '', customer_phone: (q?.customer_phone || r?.phone || '').replace(/^-$/, ''), customer_email: q?.customer_email || r?.email || '',
      address: src.location && src.location !== '-' ? src.location : '', notes: [q?.title, r?.rig, r?.issue].filter(Boolean).join('\n').slice(0, 1000),
      team: db.prepare('SELECT id, name, email, role FROM users WHERE tenant_id = ? ORDER BY id').all(t.id),
    });
  }, { auth: 'tenant' });

  route('GET', '/api/jobs/:id', async (req, res, p, url, { tenant: t }) => {
    const j = jobRow(p.id, t.id); if (!j) throw new HttpError(404, 'Not found');
    const tz = owner.tzOf(t);
    // When each message really goes out: pending texts wait for texting hours.
    const nowD = new Date();
    const messages = db.prepare(`SELECT kind, channel, status, send_after, sent_at, error FROM scheduled_messages WHERE tenant_id = ? AND ref_id = ? AND kind IN ('job_confirm','job_reminder','job_on_way') ORDER BY id`).all(t.id, j.id)
      .map((m) => {
        let at = owner.parseUtc(m.sent_at || m.send_after);
        if (m.status === 'pending') {
          if (at < nowD) at = nowD;
          if (m.channel === 'sms' && !owner.inTextHours(at, tz)) at = owner.nextTextWindow(at, tz);
        }
        return { ...m, soon: m.status === 'pending' && at - nowD < 120_000, when_label: owner.formatWhen(at, tz) };
      });
    send(res, 200, {
      ...jobOut(j, tz), tz, messages, sms_enabled: notify.smsEnabled, stopped: smsStopped(j.customer_phone),
      in_text_hours: owner.inTextHours(new Date(), tz),
      request: j.request_id ? db.prepare('SELECT id, name FROM requests WHERE id = ? AND tenant_id = ?').get(j.request_id, t.id) || null : null,
      quote: j.quote_id ? db.prepare('SELECT id, title, kind FROM quotes WHERE id = ? AND tenant_id = ?').get(j.quote_id, t.id) || null : null,
      team: db.prepare('SELECT id, name, email, role FROM users WHERE tenant_id = ? ORDER BY id').all(t.id),
    });
  }, { auth: 'tenant' });

  route('POST', '/api/jobs', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    const r = b.request_id ? scoped('requests', b.request_id, t.id) : null;
    const q = b.quote_id ? scoped('quotes', b.quote_id, t.id) : null;
    const f = jobFields(b, t);
    const ins = db.prepare('INSERT INTO jobs (tenant_id, request_id, quote_id, customer_name, customer_phone, customer_email, address, start_at, duration_min, user_id, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, r?.id ?? q?.request_id ?? null, q?.id ?? null, f.customer_name, f.customer_phone, f.customer_email, f.address, f.start_at, f.duration_min, f.user_id, f.notes, now(), now());
    const job = jobRow(Number(ins.lastInsertRowid), t.id);
    if (b.notify !== false) queueJobMessages(t, job);
    setRequestStatus(r?.id, 'contacted', ['new']);
    send(res, 201, jobOut(job, owner.tzOf(t)));
  }, { auth: 'tenant' });

  route('PUT', '/api/jobs/:id', async (req, res, p, url, { tenant: t }) => {
    const cur = scoped('jobs', p.id, t.id); if (!cur) throw new HttpError(404, 'Not found');
    if (cur.status === 'canceled' || cur.status === 'done') throw new HttpError(409, 'This appointment is closed. Make a new one instead.');
    const b = await json(req);
    const f = jobFields(b, t, cur);
    db.prepare('UPDATE jobs SET customer_name = ?, customer_phone = ?, customer_email = ?, address = ?, start_at = ?, duration_min = ?, user_id = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(f.customer_name, f.customer_phone, f.customer_email, f.address, f.start_at, f.duration_min, f.user_id, f.notes, now(), cur.id);
    const job = jobRow(cur.id, t.id);
    // A new time: old messages would be wrong, so they're replaced (or just dropped if the owner says not to tell the customer).
    if (cur.start_at !== f.start_at) {
      cancelMessages(t.id, ['job_confirm', 'job_reminder'], cur.id);
      if (b.notify !== false) queueJobMessages(t, job, { updated: true });
    }
    send(res, 200, jobOut(job, owner.tzOf(t)));
  }, { auth: 'tenant' });

  route('POST', '/api/jobs/:id/status', async (req, res, p, url, { tenant: t }) => {
    const cur = scoped('jobs', p.id, t.id); if (!cur) throw new HttpError(404, 'Not found');
    const b = await json(req);
    if (!JOB_STATUSES.includes(b.status)) throw new HttpError(400, 'Unknown status.');
    db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(b.status, now(), cur.id);
    if (b.status === 'canceled' || b.status === 'done') cancelMessages(t.id, ['job_confirm', 'job_reminder'], cur.id);
    send(res, 200, jobOut(jobRow(cur.id, t.id), owner.tzOf(t)));
  }, { auth: 'tenant' });

  // "On my way": a text right now, with the ETA the technician picked.
  route('POST', '/api/jobs/:id/on-my-way', async (req, res, p, url, { tenant: t }) => {
    const job = scoped('jobs', p.id, t.id); if (!job) throw new HttpError(404, 'Not found');
    if (!['scheduled', 'en_route'].includes(job.status)) throw new HttpError(409, 'This appointment is done or canceled, so we didn’t text the customer.');
    const b = await json(req);
    const minutes = Math.trunc(Number(b.minutes));
    if (!(minutes >= 1 && minutes <= 240)) throw new HttpError(400, 'Enter about how many minutes away you are, from 1 to 240.');
    const to = toE164(job.customer_phone);
    if (!to) throw new HttpError(400, 'Add the customer’s mobile number to the appointment first.');
    if (smsStopped(to)) throw new HttpError(409, 'This customer replied STOP, so we can’t text them. Give them a call instead.');
    if (!notify.smsEnabled) throw new HttpError(503, 'Texting isn’t set up yet. Give the customer a call instead.');
    const tz = owner.tzOf(t);
    if (!owner.inTextHours(new Date(), tz)) throw new HttpError(409, 'It’s outside texting hours (8am to 8pm), so we didn’t send a text. Give the customer a call instead.');
    if (limited('onway:' + job.id, 6, 3600_000)) throw new HttpError(429, 'You’ve sent a few already. Give the customer a call instead.');
    const w = owner.jobMessage('job_on_way', 'sms', { t, job, tz, minutes });
    await notify.sms(to, w.text);
    db.prepare(`INSERT INTO scheduled_messages (tenant_id, kind, channel, to_addr, ref_id, send_after, status, attempts, sent_at, created_at) VALUES (?, 'job_on_way', 'sms', ?, ?, ?, 'sent', 1, ?, ?)`).run(t.id, to, job.id, now(), now(), now());
    db.prepare(`UPDATE jobs SET status = 'en_route', on_way_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), job.id);
    send(res, 200, { ok: true, text: w.text });
  }, { auth: 'tenant' });

  // Private calendar link for the logged-in team member (Google or Apple Calendar can subscribe to it).
  function calendarUrl(user) {
    let tok = getUser(user.id).cal_token;
    if (!tok) { tok = randomToken(24); db.prepare('UPDATE users SET cal_token = ? WHERE id = ?').run(tok, user.id); }
    return `${publicBase()}/cal/${tok}.ics`;
  }
  route('GET', '/api/calendar', async (req, res, p, url, { user, isSuper }) => {
    if (isSuper) throw new HttpError(409, 'Calendar links are for the business’s own team.');
    send(res, 200, { url: calendarUrl(user), owner: user.role === 'owner' });
  }, { auth: 'tenant' });
  route('POST', '/api/calendar/reset', async (req, res, p, url, { user, isSuper }) => {
    if (isSuper) throw new HttpError(409, 'Calendar links are for the business’s own team.');
    db.prepare('UPDATE users SET cal_token = NULL WHERE id = ?').run(user.id);
    send(res, 200, { url: calendarUrl(user), owner: user.role === 'owner' });
  }, { auth: 'tenant' });
  // Pages outside /api/ for the owner features, as [pattern, handler(req, res, match)]. The request
  // handler calls ownerFeaturePage() before its own page routes.
  const ownerPages = [];
  function ownerFeaturePage(req, res, pathname) {
    for (const [re, fn] of ownerPages) { const m = re.exec(pathname); if (m) { fn(req, res, m); return true; } }
    return false;
  }
  ownerPages.push([/^\/cal\/([\w-]{16,64})\.ics$/, (req, res, m) => serveCalendar(res, m[1])]);
  // Owners see every appointment; team members see the ones assigned to them.
  function serveCalendar(res, token) {
    const u = db.prepare('SELECT * FROM users WHERE cal_token = ?').get(token);
    const t = u && u.tenant_id ? getTenant(u.tenant_id) : null;
    if (!u || !t || t.status !== 'active') throw new HttpError(404, 'Not found');
    const tz = owner.tzOf(t);
    const from = owner.utcString(Date.now() - 60 * 864e5);
    const rows = db.prepare(`SELECT j.*, u.name AS assignee_name FROM jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.tenant_id = ? AND j.start_at >= ? AND j.status != 'canceled' ${u.role === 'owner' ? '' : 'AND j.user_id = ?'} ORDER BY j.start_at LIMIT 2000`)
      .all(...(u.role === 'owner' ? [t.id, from] : [t.id, from, u.id]));
    const host = (() => { try { return new URL(publicBase()).hostname; } catch { return 'hitchpoint'; } })();
    const ics = owner.icsCalendar({
      name: `${t.name} jobs`, tz, host,
      events: rows.map((j) => {
        const start = owner.parseUtc(j.start_at);
        return {
          id: j.id, start, end: new Date(start.getTime() + j.duration_min * 60_000), updated: owner.parseUtc(j.updated_at),
          summary: `${j.customer_name || 'Customer'}${j.status === 'done' ? ' (done)' : ''}`, location: j.address,
          description: [j.customer_phone && `Phone: ${j.customer_phone}`, j.assignee_name && `Tech: ${j.assignee_name}`, j.notes].filter(Boolean).join('\n'),
        };
      }),
    });
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="schedule.ics"', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' });
    res.end(ics);
  }

  // ---------- owner features: invoices ----------
  // A quick invoice is a quote with kind 'invoice': no signature. The customer accepts the business's
  // Terms & Conditions by paying, like the deposit payment page.
  route('POST', '/api/invoices', async (req, res, p, url, { tenant: t }) => {
    const b = await json(req);
    const r = b.request_id ? scoped('requests', b.request_id, t.id) : null;
    const ins = db.prepare(`INSERT INTO quotes (tenant_id, token, request_id, kind, title, customer_name, customer_phone, customer_email, location, rig, terms, tax_rate_bp, deposit_credit_cents, created_at, updated_at) VALUES (?,?,?,'invoice',?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.id, randomToken(), r?.id ?? null, 'Invoice', r?.name || '', r?.phone || '', r?.email || '', r?.location || '', r?.rig || '', t.terms || '', t.tax_rate_bp, paidDeposits(r?.id), now(), now());
    send(res, 201, quoteFull(scoped('quotes', Number(ins.lastInsertRowid), t.id)));
  }, { auth: 'tenant' });

  route('POST', '/api/public/invoices/:token/checkout', async (req, res, p) => {
    const q = getQuoteByToken(p.token);
    const t = q && getTenant(q.tenant_id);
    if (!q || q.kind !== 'invoice' || q.status === 'void' || !t) throw new HttpError(404, 'This invoice isn’t available.');
    if (q.status === 'paid') throw new HttpError(409, 'This invoice is already paid.');
    const b = await json(req);
    const latest = latestTerms(t.id);
    if (latest && Number(b.terms_version) !== latest.version) throw new HttpError(409, 'The business updated its Terms & Conditions. Reload the page to review them, then pay.');
    const phone = b.phone !== undefined ? noCtl(b.phone, 40) : (phoneKey(q.customer_phone) ? q.customer_phone : '');
    const email = b.email !== undefined ? noCtl(b.email, 200).toLowerCase() : normEmail(q.customer_email);
    if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Check your email address.');
    if (phone && !phoneKey(phone)) throw new HttpError(400, 'Check your phone number.');
    if (b.subscribe_sms && !phoneKey(phone)) throw new HttpError(400, 'Add your mobile number to get texts, or uncheck that box.');
    const { due } = quoteDue(q);
    if (due < 50) throw new HttpError(409, 'Nothing is due on this invoice.');
    db.prepare('UPDATE quotes SET customer_phone = ?, customer_email = ?, updated_at = ? WHERE id = ?').run(phone || '', email || '', now(), q.id);
    if (b.subscribe_email !== undefined || b.subscribe_sms) {
      upsertCustomer(t, { name: q.customer_name, phone, email, emailOptIn: Boolean(b.subscribe_email), smsOptIn: Boolean(b.subscribe_sms), source: `Invoice #${q.id}`, ip: clientIp(req), ua: clean(req.headers['user-agent'], 400) });
    }
    await closeQuoteCheckouts(q.id, PAYING_NOW, due); // an open Checkout for another amount can't be paid
    let pay = db.prepare(`SELECT * FROM payments WHERE quote_id = ? AND status = 'pending' AND amount_cents = ? AND method = 'card' ORDER BY id DESC`).get(q.id, due);
    if (!pay) {
      const tok = randomToken();
      db.prepare(`INSERT INTO payments (tenant_id, token, kind, quote_id, request_id, description, amount_cents, method) VALUES (?, ?, 'quote', ?, ?, ?, ?, 'card')`)
        .run(t.id, tok, q.id, q.request_id, `${q.title} (#${q.id})`, due);
      pay = getPayment(tok);
    }
    const checkoutUrl = await startCheckout(req, t, pay, { successPath: `/p/${q.token}`, cancelPath: `/p/${q.token}`, email, termsVersion: latest?.version });
    send(res, 200, { url: checkoutUrl });
  });

  // ---------- owner features: subscriber emails ----------
  // Update and offer emails to customers who agreed to them. Every email carries the business's name
  // and mailing address and a one-click unsubscribe. One send per business per day. No texts here:
  // marketing texts need state-by-state rules and carrier registration first.
  const subscribers = (tid) => db.prepare(`SELECT MIN(id) AS id, email FROM customers WHERE tenant_id = ? AND email_opt_in = 1 AND email IS NOT NULL AND email != '' GROUP BY email ORDER BY MIN(id)`).all(tid);
  const lastCampaign = (tid) => db.prepare('SELECT created_at FROM campaigns WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1').get(tid);
  function campaignInput(b) {
    const subject = noCtl(b.subject, 150), body = String(b.body ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim().slice(0, 10000);
    if (!subject) throw new HttpError(400, 'Add a subject line.');
    if (body.length < 20) throw new HttpError(400, 'Write your message. A few sentences is plenty.');
    return { subject, body };
  }
  route('GET', '/api/campaigns', async (req, res, p, url, { tenant: t, user }) => {
    const last = lastCampaign(t.id);
    const next = last ? new Date(owner.parseUtc(last.created_at).getTime() + 864e5) : null;
    const tz = owner.tzOf(t);
    send(res, 200, {
      address: owner.postalAddress(t), subscribers: subscribers(t.id).length, email_enabled: notify.emailEnabled, your_email: user.email,
      next_allowed_at: next && next > new Date() ? owner.utcString(next) : null, next_allowed_label: next && next > new Date() ? owner.formatWhen(next, tz) : null,
      campaigns: db.prepare('SELECT id, subject, recipients, sent, skipped, failed, status, created_at, finished_at FROM campaigns WHERE tenant_id = ? ORDER BY id DESC LIMIT 50').all(t.id)
        .map((c) => ({ ...c, when_label: owner.formatWhen(owner.parseUtc(c.created_at), tz) })),
    });
  }, { auth: 'owner' });
  route('POST', '/api/campaigns/test', async (req, res, p, url, { tenant: t, user }) => {
    const { subject, body } = campaignInput(await json(req));
    const address = owner.postalAddress(t);
    if (!address.ok) throw new HttpError(409, 'Add your business mailing address first. Go to Settings, then Customer Terms & Conditions.');
    if (!notify.emailEnabled) throw new HttpError(503, 'Email isn’t set up on the platform yet. Contact support.');
    if (limited('camptest:' + t.id, 10, 3600_000)) throw new HttpError(429, 'You’ve sent 10 tests this hour. Try again later.');
    const e = owner.campaignEmail({ t, subject: `[Test] ${subject}`, body, address, unsubUrl: '(each customer gets their own unsubscribe link here)' });
    const ok = await notify.email(user.email, e.subject, e.text, { fromName: t.name, replyTo: t.email || undefined });
    if (!ok) throw new HttpError(502, 'The test email didn’t go out. Try again in a minute.');
    send(res, 200, { ok: true, to: user.email });
  }, { auth: 'owner' });
  route('POST', '/api/campaigns', async (req, res, p, url, { tenant: t, user }) => {
    const { subject, body } = campaignInput(await json(req));
    const address = owner.postalAddress(t);
    if (!address.ok) throw new HttpError(409, 'Add your business mailing address first. Go to Settings, then Customer Terms & Conditions.');
    if (!notify.emailEnabled) throw new HttpError(503, 'Email isn’t set up on the platform yet. Contact support.');
    const last = lastCampaign(t.id);
    if (last && owner.parseUtc(last.created_at).getTime() + 864e5 > Date.now()) throw new HttpError(429, `You can send one email to your subscribers each day. You can send the next one ${owner.formatWhen(new Date(owner.parseUtc(last.created_at).getTime() + 864e5), owner.tzOf(t))}.`);
    const list = subscribers(t.id);
    if (!list.length) throw new HttpError(409, 'Nobody has signed up for your emails yet.');
    const ins = db.prepare('INSERT INTO campaigns (tenant_id, user_id, subject, body, recipients, created_at) VALUES (?,?,?,?,?,?)').run(t.id, user.id, subject, body, list.length, now());
    const cid = Number(ins.lastInsertRowid);
    for (const c of list) queueMessage({ t, kind: 'campaign', channel: 'email', to: normEmail(c.email), refId: cid, customerId: c.id });
    send(res, 201, { id: cid, recipients: list.length });
  }, { auth: 'owner' });

  // ---------- owner features: accounting export ----------
  // Paid payments and refunds for a date range (in the business's time zone), ready to import into QuickBooks.
  route('GET', '/api/exports/quickbooks.csv', async (req, res, p, url, { tenant: t }) => {
    const tz = owner.tzOf(t);
    const today = owner.todayIn(tz);
    const from = owner.validDate(url.searchParams.get('from')) ? url.searchParams.get('from') : today.slice(0, 8) + '01';
    const to = owner.validDate(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
    if (to < from) throw new HttpError(400, 'The end date is before the start date.');
    const lo = owner.utcString(owner.zonedTimeToUtc(from, '00:00', tz)), hi = owner.utcString(owner.zonedTimeToUtc(owner.addDays(to, 1), '00:00', tz));
    // Payments made in the range, and refunds made in the range (their own negative rows).
    const pick = `SELECT p.*, q.signer_name, q.customer_name AS q_name, r.name AS r_name FROM payments p LEFT JOIN quotes q ON q.id = p.quote_id LEFT JOIN requests r ON r.id = p.request_id WHERE p.tenant_id = ? AND p.status = 'paid'`;
    const paidRows = db.prepare(`${pick} AND p.paid_at >= ? AND p.paid_at < ?`).all(t.id, lo, hi).map((r) => ({ r, at: r.paid_at, refund: 0 }));
    const refundRows = db.prepare(`${pick} AND p.refunded_cents > 0 AND p.refunded_at >= ? AND p.refunded_at < ?`).all(t.id, lo, hi).map((r) => ({ r, at: r.refunded_at, refund: 1 }));
    const rows = [...paidRows, ...refundRows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.r.id - b.r.id || a.refund - b.refund));
    const amt = (c) => ({ usd: c }); // money cell
    const METHOD = { card: 'Card or bank (online)', cash: 'Cash', check: 'Check', other: 'Other' };
    const lines = [['Date', 'Customer', 'Description', 'Amount', 'Method', 'Processing fees', 'Net', 'Reference']];
    for (const { r, at, refund } of rows) {
      const lp = owner.localParts(owner.parseUtc(at), tz);
      const date = `${String(lp.month).padStart(2, '0')}/${String(lp.day).padStart(2, '0')}/${lp.year}`;
      const who = r.signer_name || r.q_name || r.r_name || '', method = METHOD[r.method] || r.method;
      if (refund) {
        lines.push([date, who, `Refund: ${r.description}`, amt(-r.refunded_cents), method, amt(0), amt(-r.refunded_cents), `Refund of receipt #${r.id}${r.charge_id ? ' ' + r.charge_id : ''}`]);
        continue;
      }
      const card = r.method === 'card';
      const settled = !card || ['direct', 'sent'].includes(r.transfer_status);
      // Net = amount − Stripe's fee − (platform fee − the part of it returned on refunds).
      const fees = card ? r.stripe_fee_cents + r.fee_cents - (r.fee_refunded_cents || 0) : 0;
      lines.push([date, who, r.description, amt(r.amount_cents), method,
        settled ? amt(fees) : '', settled ? amt(r.amount_cents - fees) : '', `Receipt #${r.id}${r.charge_id ? ' ' + r.charge_id : ''}${settled ? '' : ' (fees not settled yet)'}`]);
    }
    const name = `payments-${from}-to-${to}.csv`;
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(lines.map((l) => l.map(owner.csvCell).join(',')).join('\r\n') + '\r\n');
  }, { auth: 'owner' });

  // ---------- owner features: install on phone ----------
  // The installable dashboard: web app manifest, service worker (scope /admin/) and offline page.
  const APP_FILES = { '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/admin/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/admin/offline.html': ['offline.html', 'text/html; charset=utf-8'] };
  ownerPages.push([/^\/manifest\.webmanifest$|^\/admin\/(sw\.js|offline\.html)$/, (req, res, m) => {
    const [file, type] = APP_FILES[m[0]];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...securityHeaders, ...(file === 'sw.js' ? { 'Service-Worker-Allowed': '/admin/' } : {}) });
    res.end(fs.readFileSync(path.join(PUBLIC, file)));
  }]);

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

  // ---------- affiliates ----------
  // Agilities pays affiliates (businesses on the platform) a share of HitchPoint's net platform fee on
  // online payments from businesses they referred. Each payment's share lives in an append-only ledger:
  // syncAffiliateLedger(paymentId) adds an earning or a reversal for whatever changed. Earnings wait
  // HOLD_DAYS after the payment (refunds, disputes), then become available. Payouts are recorded by hand.
  const usd = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const preciseNow = () => new Date().toISOString().replace('T', ' ').slice(0, 23);
  const sqlTime = (ts, modifier) => db.prepare('SELECT datetime(?, ?) AS d').get(ts, modifier).d;
  const getAffiliate = (id) => db.prepare('SELECT * FROM affiliates WHERE id = ?').get(id);
  const affiliateOfTenant = (tid) => db.prepare('SELECT * FROM affiliates WHERE tenant_id = ?').get(tid);
  const affiliateOfUser = (uid) => db.prepare('SELECT * FROM affiliates WHERE user_id = ?').get(uid);
  // A business affiliate goes by its business name and owner's email; a person or group by its own.
  const ownerEmailOf = (tid) => db.prepare(`SELECT email FROM users WHERE tenant_id = ? AND role = 'owner' ORDER BY id LIMIT 1`).get(tid)?.email || '';
  const affiliateName = (a) => (a.tenant_id ? getTenant(a.tenant_id)?.name : '') || a.name || '';
  const affiliateEmail = (a) => (a.tenant_id ? ownerEmailOf(a.tenant_id) : a.user_id ? getUser(a.user_id)?.email : '') || a.email || '';
  const affiliateByCode = (code) => { const c = AFF.normalizeCode(code); return AFF.CODE_RE.test(c) ? db.prepare('SELECT * FROM affiliates WHERE code = ?').get(c) : null; };
  const affiliateLink = (req, a) => `${siteOrigin(req)}/a/${a.code}`;
  // A code that credits new sign-ups: active, terms accepted, and the affiliate's own business (if it
  // is one) is active.
  function liveAffiliate(code) {
    const a = affiliateByCode(code);
    if (!a || a.status !== 'active' || !a.terms_accepted_at) return null;
    if (a.tenant_id) return getTenant(a.tenant_id)?.status === 'active' ? a : null;
    return a.user_id && getUser(a.user_id) ? a : null;
  }

  // Share history: a payment always uses the share and duration in effect when it was paid.
  const logRate = (a) => db.prepare('INSERT INTO affiliate_rates (affiliate_id, share_bp, months, effective_at) VALUES (?,?,?,?)').run(a.id, a.share_bp, a.months ?? null, preciseNow());
  function rateAt(affId, at) {
    return db.prepare('SELECT share_bp, months FROM affiliate_rates WHERE affiliate_id = ? AND effective_at <= ? ORDER BY effective_at DESC, id DESC LIMIT 1').get(affId, at)
      || db.prepare('SELECT share_bp, months FROM affiliate_rates WHERE affiliate_id = ? ORDER BY effective_at, id LIMIT 1').get(affId);
  }

  // What the referrer should have earned on a payment: a paid direct (online) payment from a referred
  // business, made on or after the referral and inside the share window, at the share in effect then.
  function affiliateTarget(pay) {
    if (!pay || pay.status !== 'paid' || pay.charge_type !== 'direct' || pay.method !== 'card' || !pay.paid_at) return null;
    const t = getTenant(pay.tenant_id);
    if (!t || !t.referred_by_affiliate_id || !t.referred_at || pay.paid_at < t.referred_at) return null;
    const a = getAffiliate(t.referred_by_affiliate_id);
    if (!a || a.tenant_id === t.id) return null;
    const rate = rateAt(a.id, pay.paid_at);
    if (!rate) return null;
    if (rate.months != null && pay.paid_at >= sqlTime(t.created_at, `+${rate.months} months`)) return null;
    const net = Math.max(0, (pay.fee_cents || 0) - (pay.fee_refunded_cents || 0));
    return { affiliateId: a.id, cents: Math.floor((net * rate.share_bp) / 10000), shareBp: rate.share_bp };
  }

  // Idempotent: brings the ledger for one payment to its target with one earning (or reversal) for the
  // difference. Runs whenever a direct payment is paid or its fee changes, and when a referral changes.
  function syncAffiliateLedger(paymentId) {
    try {
      const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
      if (!pay) return;
      const target = affiliateTarget(pay);
      const have = new Map(db.prepare(`SELECT affiliate_id, SUM(amount_cents) AS s, MAX(share_bp) AS bp FROM affiliate_ledger WHERE payment_id = ? AND type IN ('earning','reversal') GROUP BY affiliate_id`).all(pay.id).map((r) => [r.affiliate_id, r]));
      if (target && !have.has(target.affiliateId)) have.set(target.affiliateId, { s: 0, bp: target.shareBp });
      if (!have.size) return;
      const ts = now();
      const holdEnd = sqlTime(pay.paid_at || ts, `+${AFF.HOLD_DAYS} days`);
      const ins = db.prepare('INSERT INTO affiliate_ledger (affiliate_id, tenant_id, payment_id, type, amount_cents, status, available_at, share_bp, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const [affId, h] of have) {
        const mine = target && target.affiliateId === affId;
        const diff = (mine ? target.cents : 0) - (h.s || 0);
        if (!diff) continue;
        // A reversal is never available before the earning it reduces, and never later than now if that has passed.
        const availableAt = diff > 0 || holdEnd > ts ? holdEnd : ts;
        ins.run(affId, pay.tenant_id, pay.id, diff > 0 ? 'earning' : 'reversal', diff, availableAt <= ts ? 'available' : 'pending', availableAt,
          mine ? target.shareBp : h.bp ?? null, diff > 0 ? null : mine ? 'Customer refund' : 'Referral changed', ts);
      }
    } catch (e) { console.error('Affiliate ledger sync failed for payment', paymentId, e.message); }
  }
  function resyncTenantLedger(tid) {
    const ids = db.prepare(`SELECT id FROM payments WHERE tenant_id = ? AND status = 'paid' UNION SELECT payment_id FROM affiliate_ledger WHERE tenant_id = ? AND payment_id IS NOT NULL`).all(tid, tid);
    for (const r of ids) syncAffiliateLedger(r.id);
  }
  // Pending earnings become available once the hold has passed.
  const sweepAffiliateLedger = () => db.prepare(`UPDATE affiliate_ledger SET status = 'available' WHERE status = 'pending' AND available_at <= ?`).run(now());
  const affiliateTotals = (affId) => db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN type != 'payout' AND status = 'pending' THEN amount_cents END), 0) AS pending_cents,
      COALESCE(SUM(CASE WHEN type != 'payout' AND status = 'available' THEN amount_cents END), 0) AS available_cents,
      COALESCE(-SUM(CASE WHEN type = 'payout' THEN amount_cents END), 0) AS paid_cents
    FROM affiliate_ledger WHERE affiliate_id = ?`).get(affId);
  function clickStats(affId) {
    const since = sqlTime(now(), '-29 days').slice(0, 10);
    return db.prepare(`SELECT COALESCE(SUM(clicks), 0) AS all_clicks, COALESCE(SUM(uniques), 0) AS all_uniques,
      COALESCE(SUM(CASE WHEN day >= ? THEN clicks END), 0) AS clicks_30, COALESCE(SUM(CASE WHEN day >= ? THEN uniques END), 0) AS uniques_30
      FROM affiliate_clicks WHERE affiliate_id = ?`).get(since, since, affId);
  }
  const referralState = (t) => (t.status !== 'active' ? 'inactive' : isMerchant(t) && t.stripe_payouts_enabled && latestTerms(t.id) ? 'taking_payments' : 'setting_up');
  function referralsOf(a) {
    return db.prepare(`SELECT t.*, (SELECT COALESCE(SUM(l.amount_cents), 0) FROM affiliate_ledger l WHERE l.affiliate_id = ? AND l.tenant_id = t.id AND l.type IN ('earning','reversal')) AS earned_cents
      FROM tenants t WHERE t.referred_by_affiliate_id = ? ORDER BY t.created_at DESC, t.id DESC`).all(a.id, a.id)
      .map((t) => ({ id: t.id, name: t.name, joined: t.created_at, referred_at: t.referred_at, how: t.referred_how, state: referralState(t), earned_cents: t.earned_cents, share_ends: a.months == null ? null : sqlTime(t.created_at, `+${a.months} months`) }));
  }
  // shown_at: the day a row is about (an earning: when the customer paid; a payout: when it was paid).
  const ledgerOf = (affId) => db.prepare(`SELECT l.*, t.name AS business, p.method AS payout_method, p.reference AS payout_reference, p.paid_at AS payout_paid_at,
      CASE WHEN l.type = 'payout' THEN COALESCE(p.paid_at, l.created_at) WHEN l.type = 'earning' THEN COALESCE(pm.paid_at, l.created_at) ELSE l.created_at END AS shown_at
    FROM affiliate_ledger l LEFT JOIN tenants t ON t.id = l.tenant_id LEFT JOIN affiliate_payouts p ON p.id = l.payout_id AND l.type = 'payout' LEFT JOIN payments pm ON pm.id = l.payment_id
    WHERE l.affiliate_id = ? ORDER BY shown_at DESC, l.id DESC LIMIT 2000`).all(affId);
  // What the affiliate sees: earnings from each business added up by calendar month (UTC), net of
  // anything taken back that month, plus payouts and adjustments. Never a single payment or its date,
  // so a referred business's payments can't be worked out. Status: pending | available | paid |
  // partly_paid (some paid, some not) | partly_available (some available, some still pending).
  function ownerLedger(affId) {
    const months = new Map(), lines = [];
    for (const l of ledgerOf(affId)) {
      if (l.type === 'earning' || l.type === 'reversal') {
        const month = String(l.shown_at).slice(0, 7), key = `${month}|${l.tenant_id ?? ''}`;
        let g = months.get(key);
        if (!g) months.set(key, (g = { sort: l.shown_at, line: { date: null, month, business: l.business || '', type: 'earnings', note: '', method: '', reference: '', amount_cents: 0, status: '' }, statuses: new Set() }));
        g.line.amount_cents += l.amount_cents;
        g.statuses.add(l.status);
        if (l.shown_at > g.sort) g.sort = l.shown_at;
      } else {
        lines.push({ sort: l.shown_at, line: { date: String(l.shown_at).slice(0, 10), month: null, business: '', type: l.type, note: l.type === 'adjustment' ? l.note || '' : '', method: l.payout_method || '', reference: l.payout_reference || '', amount_cents: l.amount_cents, status: l.status } });
      }
    }
    for (const g of months.values()) {
      const s = g.statuses;
      g.line.status = s.size === 1 ? [...s][0] : s.has('paid') ? 'partly_paid' : 'partly_available';
      lines.push(g);
    }
    return lines.sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0)).map((x) => x.line);
  }

  // ---- tax forms and payout details ----
  const TAX_NOT_READY = 'Secure storage for tax forms isn’t set up yet, so we can’t take W-9s or bank details. An Agilities admin needs to add DATA_ENCRYPTION_KEY in Render first.';
  const latestW9 = (affId) => db.prepare('SELECT * FROM affiliate_w9 WHERE affiliate_id = ? ORDER BY id DESC LIMIT 1').get(affId);
  const tinContext = (affId) => `w9-tin:${affId}`;
  const bankContext = (affId) => `payout-bank:${affId}`;
  // W-9 and bank checks throw W9Error(field, message); turn those into a 400 that names the field.
  function formCheck(fn) {
    try { return fn(); } catch (e) { if (e instanceof W9.W9Error) throw new HttpError(400, e.message, e.field); throw e; }
  }
  function checkPayout(b = {}) {
    const method = ['ach', 'check'].includes(b.method) ? b.method : '';
    if (!method) throw new HttpError(400, 'Choose how you want to be paid: direct deposit or a mailed check.', 'payout_method');
    const bank = method === 'ach' ? formCheck(() => W9.checkBank(b.bank || {})) : null;
    // NACHA: the account holder authorizes the deposits (kept as an agreements row; see savePayout).
    if (method === 'ach' && !b.authorize) throw new HttpError(400, 'Check the box to authorize direct deposits to this account.', 'authorize');
    return { method, bank };
  }
  const logSensitive = (req, user, affId, what) => db.prepare('INSERT INTO sensitive_access_log (user_id, user_email, affiliate_id, what, ip, ua, at) VALUES (?,?,?,?,?,?,?)')
    .run(user?.id ?? null, user?.email ?? null, affId, what, clientIp(req), clean(req.headers['user-agent'], 400), now());
  // Stores a signed W-9 (the number encrypted, the last 4 readable) and marks the W-9 as on file.
  function saveW9(req, a, w, user) {
    if (!sealed) throw new HttpError(503, TAX_NOT_READY);
    const signedAt = now();
    db.prepare(`INSERT INTO affiliate_w9 (affiliate_id, form_revision, legal_name, business_name, tax_class, llc_class, other_class, foreign_owners, exempt_payee_code, fatca_code,
        address, city, state, zip, tin_type, tin_sealed, tin_last4, backup_withholding, signature, signed_at, user_id, signer_email, ip, ua, record_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.id, W9.FORM_REVISION, w.legal_name, w.business_name || null, w.tax_class, w.llc_class || null, w.other_class || null,
      w.foreign_owners, w.exempt_payee_code || null, w.fatca_code || null, w.address, w.city, w.state, w.zip, w.tin_type, sealed.seal(w.tin, tinContext(a.id)), W9.tinLast4(w.tin),
      w.backup_withholding, w.signature, signedAt, user.id, user.email, clientIp(req), clean(req.headers['user-agent'], 400), W9.recordHash(w, signedAt, sealed.fingerprint));
    db.prepare('UPDATE affiliates SET w9_on_file = 1, w9_on_file_at = ?, updated_at = ? WHERE id = ?').run(signedAt, signedAt, a.id);
    logSensitive(req, user, a.id, 'w9_submitted');
  }
  function savePayout(req, a, pay, user) {
    if (!sealed) throw new HttpError(503, TAX_NOT_READY);
    const box = pay.bank ? sealed.seal(JSON.stringify(pay.bank), bankContext(a.id)) : null;
    db.prepare('UPDATE affiliates SET payout_method = ?, payout_sealed = ?, payout_last4 = ?, payout_updated_at = ?, updated_at = ? WHERE id = ?')
      .run(pay.method, box, pay.bank ? pay.bank.account.slice(-4) : null, now(), now(), a.id);
    if (pay.bank) recordAcceptance(req, user, a, 'ach-authorization', `${AFF.ACH_AUTH_VERSION}:x${pay.bank.account.slice(-4)}`);
    logSensitive(req, user, a.id, 'payout_changed');
  }
  // Proof of what an affiliate agreed to, when, from where: the terms, the privacy policy, and
  // direct deposit authorizations (with the account's last 4 digits).
  const recordAcceptance = (req, user, a, doc, version) => db.prepare('INSERT INTO agreements (user_id, tenant_id, doc, version, ip, ua) VALUES (?,?,?,?,?,?)')
    .run(user.id, a.tenant_id ?? null, doc, version, clientIp(req), clean(req.headers['user-agent'], 400));
  // What the affiliate (and the admin list) sees: never a full tax ID or bank number.
  function taxSummary(a) {
    const w = latestW9(a.id);
    return {
      w9: w ? { legal_name: w.legal_name, business_name: w.business_name || '', classification: W9.classText(w), tin: W9.maskedTin(w.tin_type, w.tin_last4), city: w.city, state: w.state, signed_at: w.signed_at, backup_withholding: Boolean(w.backup_withholding) } : null,
      w9_on_paper: Boolean(a.w9_on_file && !w),
      payout: a.payout_method ? { method: a.payout_method, last4: a.payout_last4 || '', updated_at: a.payout_updated_at } : null,
      ready: Boolean(sealed),
    };
  }

  function ownerAffiliate(req, a) {
    sweepAffiliateLedger();
    const accepted = Boolean(a.terms_accepted_at);
    const affiliate = {
      name: affiliateName(a), kind: a.tenant_id ? 'business' : 'person', tax: taxSummary(a),
      code: a.code, status: a.status, share_bp: a.share_bp, months: a.months, w9_on_file: Boolean(a.w9_on_file), link: accepted ? affiliateLink(req, a) : null,
      terms: { url: '/legal/affiliate-terms', version: AFF.AFFILIATE_TERMS_VERSION, accepted_at: a.terms_accepted_at, accepted_version: a.terms_version, needs_accept: a.terms_version !== AFF.AFFILIATE_TERMS_VERSION },
      hold_days: AFF.HOLD_DAYS, min_payout_cents: AFF.MIN_PAYOUT_CENTS,
    };
    if (!accepted) return { affiliate };
    const c = clickStats(a.id);
    return {
      affiliate,
      clicks: { last_30_days: c.clicks_30, all_time: c.all_clicks },
      totals: affiliateTotals(a.id),
      // Names and earnings only: never a referred business's payment volume or revenue.
      referrals: referralsOf(a).map(({ name, joined, state, earned_cents, share_ends }) => ({ name, joined, state, earned_cents, share_ends })),
      ledger: ownerLedger(a.id),
    };
  }
  function superAffiliateRow(a) {
    const t = a.tenant_id ? getTenant(a.tenant_id) : null;
    const w = latestW9(a.id);
    return {
      id: a.id, tenant_id: a.tenant_id, kind: t ? 'business' : 'person', name: affiliateName(a), email: affiliateEmail(a), tenant_status: t?.status || '', code: a.code, share_bp: a.share_bp, months: a.months, status: a.status,
      w9_on_file: Boolean(a.w9_on_file), w9_on_file_at: a.w9_on_file_at, w9: w ? 'electronic' : a.w9_on_file ? 'paper' : null, backup_withholding: Boolean(w?.backup_withholding), payout_method: a.payout_method || null,
      terms_accepted_at: a.terms_accepted_at, terms_version: a.terms_version,
      terms_current: a.terms_version === AFF.AFFILIATE_TERMS_VERSION, created_at: a.created_at,
      referrals: db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE referred_by_affiliate_id = ?').get(a.id).n,
      ...affiliateTotals(a.id), clicks: clickStats(a.id),
    };
  }
  function payoutBlock(a, available) {
    if (!a.terms_accepted_at) return 'They haven’t accepted the Affiliate Program Terms yet. Ask them to accept on their referral page.';
    if (!a.w9_on_file) return 'We need their W-9 before a payout. Ask them to fill it out (button above), or tick “Paper W-9 on file” if you have a signed paper copy.';
    if (available < AFF.MIN_PAYOUT_CENTS) return `The available balance is ${usd(available)}. Payouts start at ${usd(AFF.MIN_PAYOUT_CENTS)}.`;
    return '';
  }
  function superAffiliateDetail(req, a) {
    sweepAffiliateLedger();
    const row = superAffiliateRow(a);
    return {
      affiliate: { ...row, link: affiliateLink(req, a), owner_email: row.email, phone: a.tenant_id ? getTenant(a.tenant_id)?.phone || '' : a.phone || '', audience: a.audience || '' },
      tax: taxSummary(a),
      w9_history: db.prepare('SELECT id, signed_at, legal_name, tin_type, tin_last4, signer_email FROM affiliate_w9 WHERE affiliate_id = ? ORDER BY id DESC').all(a.id)
        .map((w) => ({ id: w.id, signed_at: w.signed_at, legal_name: w.legal_name, tin: W9.maskedTin(w.tin_type, w.tin_last4), signer_email: w.signer_email })),
      access_log: db.prepare('SELECT user_email, what, at FROM sensitive_access_log WHERE affiliate_id = ? ORDER BY id DESC LIMIT 20').all(a.id),
      referrals: referralsOf(a),
      ledger: ledgerOf(a.id).map((l) => ({ id: l.id, date: l.shown_at, created_at: l.created_at, business: l.business || '', tenant_id: l.tenant_id, payment_id: l.payment_id, type: l.type, amount_cents: l.amount_cents, status: l.status, available_at: l.available_at, share_bp: l.share_bp, note: l.note || '', payout_id: l.payout_id, payout_method: l.payout_method || '', reference: l.payout_reference || '' })),
      payouts: db.prepare('SELECT p.id, p.amount_cents, p.method, p.reference, p.paid_at, p.created_at, u.email AS created_by FROM affiliate_payouts p LEFT JOIN users u ON u.id = p.created_by WHERE p.affiliate_id = ? ORDER BY p.paid_at DESC, p.id DESC').all(a.id),
      rates: db.prepare('SELECT share_bp, months, effective_at FROM affiliate_rates WHERE affiliate_id = ? ORDER BY effective_at DESC, id DESC').all(a.id),
      payout_block: payoutBlock(a, row.available_cents), min_payout_cents: AFF.MIN_PAYOUT_CENTS, methods: AFF.PAYOUT_METHODS,
    };
  }

  // Input checks for the super admin forms.
  function cleanShare(v) {
    const n = Number(v);
    if (v === '' || v == null || !Number.isInteger(n) || n < 0 || n > 10000) throw new HttpError(400, 'Enter a share between 0% and 100%, like 20.');
    return n;
  }
  function cleanMonths(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 600) throw new HttpError(400, 'Enter a whole number of months, like 12. Leave it empty for as long as they stay.');
    return n;
  }
  function cleanCode(v, selfId = 0) {
    const c = AFF.normalizeCode(v);
    if (!AFF.CODE_RE.test(c)) throw new HttpError(400, 'Use 3 to 40 lowercase letters, numbers or dashes for the code, like mike-stevens.');
    if (db.prepare('SELECT 1 FROM affiliates WHERE code = ? AND id != ?').get(c, selfId)) throw new HttpError(409, 'Another affiliate already uses that code. Try a different one.');
    return c;
  }
  function uniqueCode(base) {
    let c = base, i = 2;
    while (db.prepare('SELECT 1 FROM affiliates WHERE code = ?').get(c)) { const s = `-${i++}`; c = base.slice(0, 40 - s.length).replace(/-+$/, '') + s; }
    return c;
  }
  // A past or present date typed as YYYY-MM-DD.
  function pastDay(v, label) {
    const s = String(v ?? '').trim();
    if (!s) return '';
    const d = new Date(s + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, `Enter the ${label} as a date, like 2026-11-02.`);
    if (s > now().slice(0, 10)) throw new HttpError(400, `The ${label} can’t be in the future. Pick today or an earlier day.`);
    return s;
  }

  // Link clicks: daily counts, plus a keyed hash of the IP kept only for the current day (unique visitors).
  const pruneClickVisitors = () => db.prepare('DELETE FROM affiliate_click_visitors WHERE day < ?').run(now().slice(0, 10));
  pruneClickVisitors();
  setInterval(() => { try { pruneClickVisitors(); sweepAffiliateLedger(); } catch { /* database closed */ } }, 3600_000).unref();
  function recordClick(affId, ip) {
    const day = now().slice(0, 10);
    const hash = crypto.createHmac('sha256', secret).update(`affiliate-click|${day}|${ip}`).digest('hex').slice(0, 32);
    pruneClickVisitors();
    const fresh = db.prepare('INSERT OR IGNORE INTO affiliate_click_visitors (affiliate_id, day, ip_hash) VALUES (?,?,?)').run(affId, day, hash).changes;
    db.prepare(`INSERT INTO affiliate_clicks (affiliate_id, day, clicks, uniques) VALUES (?, ?, 1, ?)
      ON CONFLICT (affiliate_id, day) DO UPDATE SET clicks = clicks + 1, uniques = uniques + excluded.uniques`).run(affId, day, fresh ? 1 : 0);
  }
  // GET /a/<code>: count the click, remember the code for 90 days (first click wins), go to the landing page.
  function affiliateClick(req, res, raw) {
    const a = liveAffiliate(raw);
    if (!a) { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
    const headers = { Location: `/?ref=${a.code}`, 'Cache-Control': 'no-store' };
    if (!liveAffiliate(AFF.readCookie(req.headers.cookie, AFF.REF_COOKIE))) {
      const secure = baseUrl(req).startsWith('https') ? '; Secure' : '';
      headers['Set-Cookie'] = `${AFF.REF_COOKIE}=${a.code}; Max-Age=${AFF.REF_COOKIE_DAYS * 86400}; Path=/; SameSite=Lax; HttpOnly${secure}`;
    }
    const ip = clientIp(req);
    if (req.method === 'GET' && !AFF.isBot(req.headers['user-agent']) && !limited('aff-click:' + ip, AFF.CLICKS_PER_IP_HOUR, 3600_000)) recordClick(a.id, ip);
    res.writeHead(302, headers);
    res.end();
  }

  // Sign-up credit: a code typed on the form wins, then the link cookie. An affiliate can't refer itself.
  function selfReferral(a, { email, phone }) {
    const emails = new Set(), phones = [];
    if (a.tenant_id) {
      const t = getTenant(a.tenant_id);
      if (!t) return false;
      for (const u of db.prepare('SELECT email FROM users WHERE tenant_id = ?').all(t.id)) emails.add(normEmail(u.email));
      if (t.email) emails.add(normEmail(t.email));
      phones.push(t.phone, t.notify_phone);
    } else {
      const u = a.user_id ? getUser(a.user_id) : null;
      if (u) emails.add(normEmail(u.email));
      if (a.email) emails.add(normEmail(a.email));
      phones.push(a.phone);
    }
    if (email && emails.has(normEmail(email))) return true;
    const k = phoneKey(phone);
    return Boolean(k && phones.some((x) => phoneKey(x) === k));
  }
  function signupReferral(req, b, who) {
    const typed = AFF.normalizeCode(b.referral_code);
    const fromCookie = AFF.normalizeCode(AFF.readCookie(req.headers.cookie, AFF.REF_COOKIE));
    if (typed) {
      const a = liveAffiliate(typed);
      if (!a) throw new HttpError(400, 'We don’t recognize that referral code. Check it, or leave the box empty.');
      if (selfReferral(a, who)) throw new HttpError(400, 'You can’t use your own referral code. Leave the box empty to continue.');
      return { affiliate: a, how: typed === fromCookie ? 'link' : 'code' };
    }
    const a = liveAffiliate(fromCookie);
    return a && !selfReferral(a, who) ? { affiliate: a, how: 'link' } : null;
  }
  // Super admin adding a business with a referral code (for owners an affiliate signs up in person).
  function adminReferralCode(code) {
    if (!AFF.normalizeCode(code)) return null;
    const a = affiliateByCode(code);
    if (!a) throw new HttpError(400, 'No affiliate has that referral code. Check it on the Affiliates page, or leave it empty.');
    return a;
  }
  const setReferral = (tid, affId, how, at = now()) => db.prepare('UPDATE tenants SET referred_by_affiliate_id = ?, referred_at = ?, referred_how = ? WHERE id = ?')
    .run(affId || null, affId ? at : null, affId ? how : null, tid);

  // Sign-up form: who referred this visitor (the link cookie first, then ?ref / a code being checked).
  route('GET', '/api/public/referral', async (req, res, p, url) => {
    if (limited('ref-lookup:' + clientIp(req), 120, 3600_000)) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
    const a = liveAffiliate(AFF.readCookie(req.headers.cookie, AFF.REF_COOKIE)) || liveAffiliate(url.searchParams.get('code'));
    send(res, 200, a ? { code: a.code, name: affiliateName(a) } : { code: null });
  });

  // The affiliate's own referral page: a person or group signed in with its own login, or the owner
  // of a business that's an affiliate.
  const ownAffiliate = ({ tenant: t, user, isSuper }) => {
    if (user.role === 'affiliate') return affiliateOfUser(user.id);
    if (!isSuper && user.role !== 'owner') throw new HttpError(403, 'Only the business owner can see the referral program.');
    return affiliateOfTenant(t.id);
  };
  route('GET', '/api/affiliate', async (req, res, p, url, ctx) => {
    const a = ownAffiliate(ctx);
    send(res, 200, a ? ownerAffiliate(req, a) : { affiliate: null });
  }, { auth: 'affiliate' });
  route('POST', '/api/affiliate/terms', async (req, res, p, url, ctx) => {
    if (ctx.isSuper) throw new HttpError(403, 'Only the business owner can accept the Affiliate Program Terms.');
    const a = ownAffiliate(ctx);
    if (!a) throw new HttpError(404, 'Not found');
    const b = await json(req);
    if (!b.agree) throw new HttpError(400, 'Check the box to confirm you’re 18 or older and accept the Affiliate Program Terms and Privacy Policy.');
    const ts = now();
    db.prepare('UPDATE affiliates SET terms_accepted_at = ?, terms_version = ?, updated_at = ? WHERE id = ?').run(ts, AFF.AFFILIATE_TERMS_VERSION, ts, a.id);
    recordAcceptance(req, ctx.user, a, 'affiliate-terms', AFF.AFFILIATE_TERMS_VERSION);
    recordAcceptance(req, ctx.user, a, 'privacy', AGREEMENT_VERSION);
    send(res, 200, ownerAffiliate(req, getAffiliate(a.id)));
  }, { auth: 'affiliate' });
  route('GET', '/api/affiliate/ledger.csv', async (req, res, p, url, ctx) => {
    const a = ownAffiliate(ctx);
    if (!a) throw new HttpError(404, 'Not found');
    sweepAffiliateLedger();
    const method = { ach: 'ACH', check: 'check', stripe: 'Stripe', other: 'other' };
    const what = (l) => ({
      earnings: `Your share of ${platformName}’s fees`, adjustment: `Adjustment${l.note ? ': ' + l.note : ''}`,
      payout: `Paid to you by ${method[l.method] || 'payout'}${l.reference ? ` (${l.reference})` : ''}`,
    }[l.type] || l.type);
    const rows = ownerLedger(a.id).map((l) => AFF.csvLine([l.month || l.date, l.business, what(l), { usd: l.amount_cents }, l.status.replace('_', ' ')]));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="referral-earnings.csv"', 'Cache-Control': 'no-store' });
    res.end([AFF.csvLine(['Month or date', 'Business', 'What it is', 'Amount', 'Status']), ...rows].join('\n') + '\n');
  }, { auth: 'affiliate' });

  // The W-9 form's choices and wording, for the invitation page and the affiliate's details page.
  route('GET', '/api/public/w9-form', async (req, res) => send(res, 200, {
    revision: W9.FORM_REVISION, classes: W9.TAX_CLASSES, llc_classes: W9.LLC_CLASSES, states: W9.STATES,
    exempt_payee_codes: W9.EXEMPT_PAYEE_CODES, fatca_codes: W9.FATCA_CODES, certification: W9.CERTIFICATION, requester: `Agilities Tech, LLC (${platformName})`,
  }, { 'Cache-Control': 'public, max-age=3600' }));

  // The affiliate updates its own W-9 or payout details. Both need the account password again, so a
  // borrowed or stolen session can't redirect payouts or change the tax record.
  function affiliateForChange(ctx, b) {
    if (ctx.isSuper) throw new HttpError(403, 'Only the affiliate can change its own tax form and payout details.');
    const a = ownAffiliate(ctx);
    if (!a) throw new HttpError(404, 'Not found');
    if (!sealed) throw new HttpError(503, TAX_NOT_READY);
    if (limited('aff-change:' + ctx.user.id, 10, 3600_000)) throw new HttpError(429, 'Too many tries. Wait an hour and try again.');
    if (!verifyPassword(String(b.password || ''), ctx.user.password_hash)) throw new HttpError(400, 'That password isn’t right. Enter the password you log in with.', 'password');
    return a;
  }
  route('POST', '/api/affiliate/w9', async (req, res, p, url, ctx) => {
    const b = await json(req);
    const a = affiliateForChange(ctx, b);
    const w = formCheck(() => W9.checkW9(b.w9 || {}));
    saveW9(req, a, w, ctx.user);
    notify.email(affiliateEmail(a), `We got your new W-9 for ${platformName}`, `A new W-9 (tax ID ending in ${W9.tinLast4(w.tin)}) was submitted for your referral account on ${now()} UTC.\n\nIf you didn't do this, reply to this email right away.\n\n${platformName}`, { replyTo: platformEmail });
    notify.email(platformEmail, `${affiliateName(a)} sent a new W-9`, `${affiliateName(a)} (code ${a.code}) submitted a new W-9 on ${now()} UTC.${w.backup_withholding ? '\n\nThey say the IRS has them on backup withholding. Talk to your accountant before the next payout.' : ''}\n\n${siteOrigin(req)}/admin/#/affiliates/${a.id}`);
    send(res, 200, ownerAffiliate(req, getAffiliate(a.id)));
  }, { auth: 'affiliate' });
  route('POST', '/api/affiliate/payout', async (req, res, p, url, ctx) => {
    const b = await json(req);
    const a = affiliateForChange(ctx, b);
    const pay = checkPayout(b.payout || {});
    savePayout(req, a, pay, ctx.user);
    const how = pay.method === 'ach' ? `direct deposit to the account ending in ${pay.bank.account.slice(-4)}` : 'a check mailed to the address on your W-9';
    // Tell them right away, so a change they didn't make is caught before money moves.
    notify.email(affiliateEmail(a), `Your ${platformName} payout details changed`, `Your referral payouts will now go by ${how}. This change was made on ${now()} UTC.\n\nIf you didn't make this change, reply to this email right away so we can hold your payouts.\n\n${platformName}`, { replyTo: platformEmail });
    notify.email(platformEmail, `${affiliateName(a)} changed payout details`, `${affiliateName(a)} (code ${a.code}) changed payout details to ${pay.method === 'ach' ? 'ACH, account ending ' + pay.bank.account.slice(-4) : 'check'} on ${now()} UTC. Confirm with them before the next payout if this looks unexpected.\n\n${siteOrigin(req)}/admin/#/affiliates/${a.id}`);
    send(res, 200, ownerAffiliate(req, getAffiliate(a.id)));
  }, { auth: 'affiliate' });

  // ---- invitations ----
  // An Agilities admin invites someone by email. The emailed link (valid INVITE_DAYS, one use) opens
  // a page where they set up a login (or confirm their business login), sign a W-9, give payout
  // details, accept the Affiliate Program Terms, and get their referral link.
  const INVITE_DAYS = 14;
  const inviteLink = (req, token) => `${siteOrigin(req)}/admin/#/join/${token}`;
  const userByEmail = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const inviteRow = (i) => ({
    id: i.id, email: i.email, share_bp: i.share_bp, months: i.months, status: i.status === 'pending' && i.expires_at <= now() ? 'expired' : i.status,
    expires_at: i.expires_at, sent_count: i.sent_count, last_sent_at: i.last_sent_at, created_at: i.created_at, accepted_at: i.accepted_at, affiliate_id: i.affiliate_id,
  });
  const shareSpan = (months) => (months ? `for ${months} month${months === 1 ? '' : 's'} after each one signs up` : `for as long as each one uses ${platformName}`);
  // Who can't be invited: anyone already in the program, and logins that aren't a business owner's.
  function inviteBlock(email) {
    const u = userByEmail(email);
    if (u && u.role === 'super') return 'That’s an Agilities admin login. Use a different email.';
    if (u && u.role === 'staff') return 'That email is a staff login at a business. Invite the business owner, or use a different email.';
    if (u && u.role === 'affiliate' && affiliateOfUser(u.id)) return 'That person is already an affiliate. Open them from the list.';
    if (u && u.role === 'owner' && u.tenant_id && affiliateOfTenant(u.tenant_id)) return `${getTenant(u.tenant_id)?.name || 'That business'} is already an affiliate. Open it from the list, then use “Ask for W-9 and payout details”.`;
    if (db.prepare('SELECT 1 FROM affiliates WHERE email = ? COLLATE NOCASE').get(email)) return 'That email already belongs to an affiliate. Open them from the list.';
    return '';
  }
  async function sendInvite(req, inv, token) {
    const link = inviteLink(req, token);
    const emailed = await notify.email(inv.email, `You’re invited to the ${platformName} referral program`,
      `Hi,\n\n${platformName} helps mobile RV repair businesses run their jobs, quotes and payments. You’re invited to refer businesses to it and earn ${inv.share_bp / 100}% of the fee ${platformName} keeps on their online payments (card or bank), ${shareSpan(inv.months)}.\n\n`
      + `Set up your account, fill out a W-9 tax form, and get your referral link here. It takes about 10 minutes:\n${link}\n\n`
      + `Have your Social Security number or EIN ready, and your bank’s routing and account numbers if you want direct deposit. The link works for ${INVITE_DAYS} days and is just for you.\n\nQuestions? Reply to this email.\n\n${platformName}`,
      { replyTo: platformEmail });
    db.prepare('UPDATE affiliate_invites SET sent_count = sent_count + ?, last_sent_at = CASE WHEN ? THEN ? ELSE last_sent_at END WHERE id = ?').run(emailed ? 1 : 0, emailed ? 1 : 0, now(), inv.id);
    return { emailed, link };
  }
  route('POST', '/api/super/affiliate-invites', async (req, res, p, url, ctx) => {
    if (!sealed) throw new HttpError(409, TAX_NOT_READY);
    const b = await json(req);
    const email = clean(b.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter the email address to send the invitation to.', 'email');
    const share = formField('share', () => cleanShare(b.share_bp)), months = formField('months', () => cleanMonths(b.months));
    const blocked = inviteBlock(email);
    if (blocked) throw new HttpError(409, blocked, 'email');
    const token = randomToken(24);
    db.prepare(`UPDATE affiliate_invites SET status = 'canceled' WHERE email = ? AND status = 'pending'`).run(email); // a new invitation replaces an old one
    const r = db.prepare('INSERT INTO affiliate_invites (email, share_bp, months, token_hash, expires_at, created_by) VALUES (?,?,?,?,?,?)')
      .run(email, share, months, sha256(token), sqlTime(now(), `+${INVITE_DAYS} days`), ctx.user.id);
    const inv = db.prepare('SELECT * FROM affiliate_invites WHERE id = ?').get(Number(r.lastInsertRowid));
    const sent = await sendInvite(req, inv, token);
    send(res, 201, { invite: inviteRow(db.prepare('SELECT * FROM affiliate_invites WHERE id = ?').get(inv.id)), ...sent });
  }, { auth: 'super' });
  // A fresh link (the old one stops working) and another 14 days.
  route('POST', '/api/super/affiliate-invites/:id/resend', async (req, res, p) => {
    const inv = db.prepare('SELECT * FROM affiliate_invites WHERE id = ?').get(p.id);
    if (!inv) throw new HttpError(404, 'Not found');
    if (inv.status !== 'pending') throw new HttpError(409, inv.status === 'accepted' ? 'They already joined.' : 'This invitation was canceled. Send a new one.');
    const blocked = inviteBlock(inv.email);
    if (blocked) throw new HttpError(409, blocked);
    const token = randomToken(24);
    db.prepare('UPDATE affiliate_invites SET token_hash = ?, expires_at = ? WHERE id = ?').run(sha256(token), sqlTime(now(), `+${INVITE_DAYS} days`), inv.id);
    const sent = await sendInvite(req, db.prepare('SELECT * FROM affiliate_invites WHERE id = ?').get(inv.id), token);
    send(res, 200, { invite: inviteRow(db.prepare('SELECT * FROM affiliate_invites WHERE id = ?').get(inv.id)), ...sent });
  }, { auth: 'super' });
  route('POST', '/api/super/affiliate-invites/:id/cancel', async (req, res, p) => {
    const ch = db.prepare(`UPDATE affiliate_invites SET status = 'canceled' WHERE id = ? AND status = 'pending'`).run(p.id).changes;
    if (!ch) throw new HttpError(409, 'That invitation isn’t waiting anymore. Reload the page.');
    send(res, 200, { ok: true });
  }, { auth: 'super' });

  // Field-specific messages for checks that throw plain HttpErrors.
  function formField(field, fn) {
    try { return fn(); } catch (e) { if (e instanceof HttpError && !e.field) e.field = field; throw e; }
  }
  // An invitation that can still be used: the token matches, it's pending, and it hasn't expired.
  function openInvite(token) {
    const inv = /^[\w-]{20,64}$/.test(token || '') ? db.prepare('SELECT * FROM affiliate_invites WHERE token_hash = ?').get(sha256(token)) : null;
    if (!inv || inv.status !== 'pending' || inv.expires_at <= now()) throw new HttpError(404, `This invitation link has expired or was already used. Ask ${platformName} to send a new one.`);
    return inv;
  }
  // Who is accepting: a new login, the owner of a business (signs in with their password), or nobody
  // (an email we can't use for an affiliate).
  function inviteAccount(inv) {
    const u = userByEmail(inv.email);
    if (!u) return { kind: 'new' };
    if (u.role === 'owner' && u.tenant_id && getTenant(u.tenant_id)) return { kind: 'business', user: u, tenant: getTenant(u.tenant_id) };
    return { kind: 'blocked', user: u };
  }
  function codeCheck(raw, fallback) {
    const c = AFF.normalizeCode(raw);
    if (!c) return { code: fallback, ok: true, message: '' };
    if (!AFF.CODE_RE.test(c)) return { code: c, ok: false, message: 'Use 3 to 40 lowercase letters, numbers or dashes, like utah-rv-club.' };
    if (db.prepare('SELECT 1 FROM affiliates WHERE code = ?').get(c)) return { code: c, ok: false, message: 'That one’s taken. Try another.' };
    return { code: c, ok: true, message: '' };
  }
  // The token travels in the request body, never the URL, so it doesn't land in request logs. (In the
  // browser it's after the #, which isn't sent to the server.)
  route('POST', '/api/public/affiliate-invites/lookup', async (req, res) => {
    if (limited('aff-invite:' + clientIp(req), 120, 3600_000)) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
    const q = await json(req);
    const inv = openInvite(q.token);
    const acct = inviteAccount(inv);
    const base = acct.kind === 'business' ? acct.tenant.slug : slugify(inv.email.split('@')[0].replace(/[._+]+/g, '-'));
    const suggested = uniqueCode(AFF.codeFromSlug(base));
    const check = q.code !== undefined ? codeCheck(q.code, suggested) : null;
    send(res, 200, {
      email: inv.email, share_bp: inv.share_bp, months: inv.months, expires_at: inv.expires_at, platform: platformName,
      account: acct.kind, business_name: acct.kind === 'business' ? acct.tenant.name : null, suggested_code: suggested, link_base: `${siteOrigin(req)}/a/`,
      hold_days: AFF.HOLD_DAYS, min_payout_cents: AFF.MIN_PAYOUT_CENTS, terms_url: '/legal/affiliate-terms', terms_version: AFF.AFFILIATE_TERMS_VERSION,
      tax_ready: Boolean(sealed), ...(check ? { code_check: check } : {}),
    });
  });
  route('POST', '/api/public/affiliate-invites/accept', async (req, res) => {
    if (limited('aff-join:' + clientIp(req), 30, 3600_000)) throw new HttpError(429, 'Too many tries from this network. Wait an hour and try again.');
    const b = await json(req);
    const inv = openInvite(b.token);
    if (!sealed) throw new HttpError(503, TAX_NOT_READY);
    const acct = inviteAccount(inv);
    if (acct.kind === 'blocked') throw new HttpError(409, `This email already has a ${platformName} login that can’t be used for the referral program. Email support for help.`);
    if (acct.kind === 'business') {
      if (limited('aff-join-pw:' + inv.id, 10, 3600_000)) throw new HttpError(429, 'Too many password tries. Wait an hour and try again.');
      if (!verifyPassword(String(b.password || ''), acct.user.password_hash)) throw new HttpError(400, `That password doesn’t match your ${platformName} login. Use the password you log in with.`, 'password');
    } else if (String(b.password || '').length < 10) throw new HttpError(400, 'Choose a password of at least 10 characters.', 'password');
    const name = acct.kind === 'business' ? acct.tenant.name : clean(b.name, 120);
    if (name.length < 2) throw new HttpError(400, 'Enter your name, or your group’s or company’s name.', 'name');
    const phone = clean(b.phone, 40), audience = clean(b.audience, 500);
    const cc = codeCheck(b.code, '');
    if (!cc.code || !cc.ok) throw new HttpError(400, cc.message || 'Choose your link name.', 'code');
    const w = formCheck(() => W9.checkW9(b.w9 || {}));
    const pay = checkPayout(b.payout || {});
    if (!b.agree) throw new HttpError(400, 'Check the box to confirm you’re 18 or older and accept the Affiliate Program Terms and Privacy Policy.', 'agree');
    if (acct.kind === 'business' && affiliateOfTenant(acct.tenant.id)) throw new HttpError(409, `${acct.tenant.name} is already in the referral program. Log in to see your link.`);
    let user = acct.user, a;
    const ts = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      // The same link, still pending and unexpired at this moment (not just when the request started).
      if (!db.prepare(`UPDATE affiliate_invites SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'pending' AND token_hash = ? AND expires_at > ?`).run(ts, inv.id, inv.token_hash, ts).changes) throw new HttpError(409, 'This invitation link was already used, replaced or expired. Log in, or ask for a new link.');
      if (!user) {
        const u = db.prepare(`INSERT INTO users (tenant_id, email, name, password_hash, role, last_login_at) VALUES (NULL, ?, ?, ?, 'affiliate', ?)`).run(inv.email, name, hashPassword(b.password), ts);
        user = getUser(Number(u.lastInsertRowid));
      } else db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ts, user.id);
      const isBiz = acct.kind === 'business';
      const r = db.prepare(`INSERT INTO affiliates (tenant_id, user_id, code, share_bp, months, name, email, phone, audience, terms_accepted_at, terms_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(isBiz ? acct.tenant.id : null, isBiz ? null : user.id, cc.code, inv.share_bp, inv.months, isBiz ? null : name, isBiz ? null : inv.email, phone || null, audience || null, ts, AFF.AFFILIATE_TERMS_VERSION, ts, ts);
      a = getAffiliate(Number(r.lastInsertRowid));
      logRate(a);
      db.prepare('UPDATE affiliate_invites SET affiliate_id = ? WHERE id = ?').run(a.id, inv.id);
      recordAcceptance(req, user, a, 'affiliate-terms', AFF.AFFILIATE_TERMS_VERSION);
      recordAcceptance(req, user, a, 'privacy', AGREEMENT_VERSION);
      saveW9(req, a, w, user);
      savePayout(req, a, pay, user);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    a = getAffiliate(a.id);
    const link = affiliateLink(req, a);
    notify.email(inv.email, `Your ${platformName} referral link`, `You’re in. Here’s your referral link:\n${link}\n\nYou earn ${a.share_bp / 100}% of the fee ${platformName} keeps on online payments (card or bank) from each business that signs up through it, ${shareSpan(a.months)}. Businesses can also type your code, ${a.code}, when they sign up.\n\nWhen you share your link, say that you earn a share if they sign up.\n\nSee your clicks, referrals and earnings any time: ${siteOrigin(req)}/admin/\n\n${platformName}`, { replyTo: platformEmail });
    notify.email(platformEmail, `New affiliate: ${affiliateName(a)}`, `${affiliateName(a)} <${inv.email}> accepted the invitation and joined the referral program (code ${a.code}, ${a.share_bp / 100}%${a.months ? `, ${a.months} months` : ''}). W-9 received; payouts by ${a.payout_method === 'ach' ? 'ACH' : 'check'}.\n\n${siteOrigin(req)}/admin/#/affiliates/${a.id}`);
    send(res, 201, { link, code: a.code, name: affiliateName(a), share_bp: a.share_bp, months: a.months }, { 'Set-Cookie': cookie(req, sess.create(user.id), sess.maxAge) });
  });

  // Super admin: the full W-9 (printable hard copy) and bank details. Every view is logged.
  route('GET', '/api/super/affiliates/:id/w9', async (req, res, p, url, ctx) => {
    const a = getAffiliate(p.id); if (!a) throw new HttpError(404, 'Not found');
    if (!sealed) throw new HttpError(503, TAX_NOT_READY);
    const wid = Number(url.searchParams.get('w')) || 0;
    const w = wid ? db.prepare('SELECT * FROM affiliate_w9 WHERE id = ? AND affiliate_id = ?').get(wid, a.id) : latestW9(a.id);
    if (!w) throw new HttpError(404, 'No W-9 has been submitted online for this affiliate.');
    let tin;
    try { tin = sealed.open(w.tin_sealed, tinContext(a.id)); } catch { throw new HttpError(409, 'This W-9 can’t be read with the current DATA_ENCRYPTION_KEY. Was the key changed?'); }
    logSensitive(req, ctx.user, a.id, 'w9_viewed');
    const fields = { ...w, tin, llc_class: w.llc_class || '', other_class: w.other_class || '', business_name: w.business_name || '', exempt_payee_code: w.exempt_payee_code || '', fatca_code: w.fatca_code || '' };
    const intact = W9.recordHash(fields, w.signed_at, sealed.fingerprint) === w.record_sha256;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...securityHeaders });
    res.end(W9.renderW9Record({ w, tin, requester: `Agilities Tech, LLC (${platformName})`, viewedBy: ctx.user.email, viewedAt: now(), intact }));
  }, { auth: 'super' });
  route('POST', '/api/super/affiliates/:id/bank', async (req, res, p, url, ctx) => {
    const a = getAffiliate(p.id); if (!a) throw new HttpError(404, 'Not found');
    if (!sealed) throw new HttpError(503, TAX_NOT_READY);
    if (a.payout_method !== 'ach' || !a.payout_sealed) throw new HttpError(404, 'They chose to be paid by check, so there are no bank details.');
    let bank;
    try { bank = JSON.parse(sealed.open(a.payout_sealed, bankContext(a.id))); } catch { throw new HttpError(409, 'These bank details can’t be read with the current DATA_ENCRYPTION_KEY. Was the key changed?'); }
    logSensitive(req, ctx.user, a.id, 'bank_viewed');
    send(res, 200, { holder: bank.holder, routing: bank.routing, account: bank.account, type: bank.type, updated_at: a.payout_updated_at });
  }, { auth: 'super' });
  // Email an existing affiliate a link to fill out (or update) their W-9 and payout details.
  route('POST', '/api/super/affiliates/:id/request-details', async (req, res, p) => {
    const a = getAffiliate(p.id); if (!a) throw new HttpError(404, 'Not found');
    if (!sealed) throw new HttpError(409, TAX_NOT_READY);
    const to = affiliateEmail(a);
    const link = `${siteOrigin(req)}/admin/#/${a.tenant_id ? 'affiliate/details' : 'account'}`;
    const emailed = await notify.email(to, `Add your W-9 and payout details for ${platformName} referrals`, `Hi,\n\nTo pay your referral earnings, we need a W-9 tax form and how you’d like to be paid. Log in and fill them out here (about 5 minutes):\n${link}\n\nHave your Social Security number or EIN ready, and your bank’s routing and account numbers if you want direct deposit.\n\n${platformName}`, { replyTo: platformEmail });
    send(res, 200, { emailed, link, to });
  }, { auth: 'super' });

  // Super admin: affiliates, referrals, payouts.
  route('GET', '/api/super/affiliates', async (req, res) => {
    sweepAffiliateLedger();
    const affiliates = db.prepare('SELECT a.* FROM affiliates a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY COALESCE(t.name, a.name) COLLATE NOCASE').all().map(superAffiliateRow);
    const businesses = db.prepare('SELECT id, name, slug FROM tenants WHERE id NOT IN (SELECT tenant_id FROM affiliates WHERE tenant_id IS NOT NULL) ORDER BY name COLLATE NOCASE').all();
    const years = db.prepare(`SELECT DISTINCT substr(paid_at, 1, 4) AS y FROM affiliate_payouts ORDER BY y DESC`).all().map((r) => r.y);
    const invites = db.prepare(`SELECT * FROM affiliate_invites WHERE status = 'pending' OR (status = 'accepted' AND accepted_at >= ?) ORDER BY id DESC LIMIT 200`).all(sqlTime(now(), '-30 days')).map(inviteRow);
    send(res, 200, { affiliates, businesses, invites, tax_ready: Boolean(sealed), email_enabled: notify.emailEnabled, years: [...new Set([now().slice(0, 4), ...years])], min_payout_cents: AFF.MIN_PAYOUT_CENTS });
  }, { auth: 'super' });
  route('POST', '/api/super/affiliates', async (req, res) => {
    const b = await json(req);
    const t = getTenant(Number(b.tenant_id));
    if (!t) throw new HttpError(400, 'Pick the business to make an affiliate.');
    if (affiliateOfTenant(t.id)) throw new HttpError(409, 'That business is already an affiliate. Open it from the list to make changes.');
    const share = cleanShare(b.share_bp), months = cleanMonths(b.months);
    const code = AFF.normalizeCode(b.code) ? cleanCode(b.code) : uniqueCode(AFF.codeFromSlug(t.slug));
    const ts = now();
    const r = db.prepare('INSERT INTO affiliates (tenant_id, code, share_bp, months, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(t.id, code, share, months, ts, ts);
    const a = getAffiliate(Number(r.lastInsertRowid));
    logRate(a);
    send(res, 201, superAffiliateDetail(req, a));
  }, { auth: 'super' });
  route('GET', '/api/super/affiliate-payouts.csv', async (req, res, p, url) => {
    const year = /^\d{4}$/.test(url.searchParams.get('year') || '') ? url.searchParams.get('year') : now().slice(0, 4);
    const rows = db.prepare(`SELECT a.*, t.legal_profile, COUNT(p.id) AS payouts, SUM(p.amount_cents) AS total
      FROM affiliate_payouts p JOIN affiliates a ON a.id = p.affiliate_id LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE substr(p.paid_at, 1, 4) = ? GROUP BY a.id ORDER BY COALESCE(t.name, a.name) COLLATE NOCASE`).all(year);
    // Form 1099-NEC/MISC threshold: $600 through 2025 payments, $2,000 for 2026 payments (indexed after 2026).
    const threshold = Number(year) <= 2025 ? 60000 : 200000;
    const lines = rows.map((r) => {
      const w = latestW9(r.id);
      const lp = customerTerms.parseProfile(r.legal_profile) || {};
      const address = w ? `${w.address}, ${w.city}, ${w.state} ${W9.zipText(w.zip)}` : [lp.addressLine1, lp.addressLine2, lp.city, [lp.state, lp.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return AFF.csvLine([year, affiliateName(r), w ? w.legal_name : lp.legalName || '', w?.business_name || '', w ? W9.classText(w) : '', w ? W9.maskedTin(w.tin_type, w.tin_last4) : '', address, affiliateEmail(r), r.code,
        w ? `electronic (${w.signed_at.slice(0, 10)})` : r.w9_on_file ? `paper (${(r.w9_on_file_at || '').slice(0, 10)})` : 'no', w?.backup_withholding ? 'yes' : '', String(r.payouts), { usd: r.total }, r.total >= threshold ? 'yes' : 'no']);
    });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="affiliate-payouts-${year}.csv"`, 'Cache-Control': 'no-store' });
    res.end([AFF.csvLine(['Year', 'Affiliate', 'Legal name (W-9 line 1)', 'Business name (line 2)', 'Tax classification', 'Tax ID (last 4)', 'Address', 'Email', 'Affiliate code', 'W-9', 'Backup withholding', 'Payouts', 'Total paid', `At or over ${usd(threshold).replace('.00', '')} (1099 likely)`]), ...lines].join('\n') + '\n');
  }, { auth: 'super' });
  route('GET', '/api/super/affiliates/:id', async (req, res, p) => {
    const a = getAffiliate(p.id); if (!a) throw new HttpError(404, 'Not found');
    send(res, 200, superAffiliateDetail(req, a));
  }, { auth: 'super' });
  route('PATCH', '/api/super/affiliates/:id', async (req, res, p) => {
    const a = getAffiliate(p.id); if (!a) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const code = b.code !== undefined ? cleanCode(b.code, a.id) : a.code;
    const share = b.share_bp !== undefined ? cleanShare(b.share_bp) : a.share_bp;
    const months = b.months !== undefined ? cleanMonths(b.months) : a.months;
    const status = ['active', 'paused'].includes(b.status) ? b.status : a.status;
    const w9 = b.w9_on_file !== undefined ? (b.w9_on_file ? 1 : 0) : a.w9_on_file;
    const w9Day = w9 && b.w9_date !== undefined ? pastDay(b.w9_date, 'W-9 date') : '';
    const w9At = !w9 ? null : w9Day ? `${w9Day} 00:00:00` : a.w9_on_file_at || now();
    db.prepare('UPDATE affiliates SET code = ?, share_bp = ?, months = ?, status = ?, w9_on_file = ?, w9_on_file_at = ?, updated_at = ? WHERE id = ?').run(code, share, months, status, w9, w9At, now(), a.id);
    if (share !== a.share_bp || months !== a.months) logRate(getAffiliate(a.id));
    send(res, 200, superAffiliateDetail(req, getAffiliate(a.id)));
  }, { auth: 'super' });
  // Record a payout of the whole available balance (paid outside the app: ACH, check, Stripe or other).
  // The form sends the amount the admin saw (and paid); if the balance has changed since, it's refused.
  const BALANCE_CHANGED = 'The available balance changed. Reload and check the amount.';
  route('POST', '/api/super/affiliates/:id/payouts', async (req, res, p, url, ctx) => {
    const a = getAffiliate(p.id); if (!a) throw new HttpError(404, 'Not found');
    const b = await json(req);
    if (!AFF.PAYOUT_METHODS.includes(b.method)) throw new HttpError(400, 'Choose how you paid them: ACH, check, Stripe or other.');
    const day = pastDay(b.paid_on, 'payout date');
    const paidAt = day ? `${day} 12:00:00` : now();
    sweepAffiliateLedger();
    const available = affiliateTotals(a.id).available_cents;
    const blocked = payoutBlock(a, available);
    if (blocked) throw new HttpError(409, blocked);
    if (!Number.isInteger(b.amount_cents)) throw new HttpError(400, 'Reload the page and check the amount, then record the payout again.');
    if (b.amount_cents !== available) throw new HttpError(409, BALANCE_CHANGED);
    // Synchronous from here: nothing else can touch the ledger between the total and the update.
    db.exec('BEGIN IMMEDIATE');
    try {
      const pid = Number(db.prepare('INSERT INTO affiliate_payouts (affiliate_id, amount_cents, method, reference, paid_at, created_by) VALUES (?,?,?,?,?,?)').run(a.id, available, b.method, clean(b.reference, 120) || null, paidAt, ctx.user.id).lastInsertRowid);
      const marked = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM affiliate_ledger WHERE affiliate_id = ? AND status = 'available' AND type != 'payout'`).get(a.id).s;
      if (marked !== available) throw new HttpError(409, BALANCE_CHANGED);
      db.prepare(`UPDATE affiliate_ledger SET status = 'paid', payout_id = ? WHERE affiliate_id = ? AND status = 'available' AND type != 'payout'`).run(pid, a.id);
      db.prepare(`INSERT INTO affiliate_ledger (affiliate_id, type, amount_cents, status, available_at, payout_id, note, created_at) VALUES (?, 'payout', ?, 'paid', ?, ?, ?, ?)`).run(a.id, -available, paidAt, pid, clean(b.reference, 120) || null, now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    send(res, 201, superAffiliateDetail(req, getAffiliate(a.id)));
  }, { auth: 'super' });
  // A manual credit (+) or debit (-), available right away. The affiliate sees the note.
  route('POST', '/api/super/affiliates/:id/adjustments', async (req, res, p) => {
    const a = getAffiliate(p.id); if (!a) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const amount = Number(b.amount_cents), note = clean(b.note, 300);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) throw new HttpError(400, 'Enter an amount, like 10.00 to add or -10.00 to take away.');
    if (note.length < 3) throw new HttpError(400, 'Add a short note. The affiliate sees it.');
    const ts = now();
    db.prepare(`INSERT INTO affiliate_ledger (affiliate_id, type, amount_cents, status, available_at, note, created_at) VALUES (?, 'adjustment', ?, 'available', ?, ?, ?)`).run(a.id, amount, ts, note, ts);
    send(res, 201, superAffiliateDetail(req, a));
  }, { auth: 'super' });

  // Super admin: who referred a business. Changing it recalculates that business's earnings.
  function tenantReferral(t) {
    const a = t.referred_by_affiliate_id ? getAffiliate(t.referred_by_affiliate_id) : null;
    return {
      referred_by: a ? { id: a.id, code: a.code, name: affiliateName(a) } : null,
      referred_at: t.referred_at, how: t.referred_how, joined: t.created_at, own_affiliate_id: affiliateOfTenant(t.id)?.id ?? null,
      affiliates: db.prepare('SELECT a.id, a.code, a.status, COALESCE(t.name, a.name) AS name FROM affiliates a LEFT JOIN tenants t ON t.id = a.tenant_id WHERE a.tenant_id IS NULL OR a.tenant_id != ? ORDER BY COALESCE(t.name, a.name) COLLATE NOCASE').all(t.id),
    };
  }
  route('GET', '/api/super/tenants/:id/referral', async (req, res, p) => {
    const t = getTenant(p.id); if (!t) throw new HttpError(404, 'Not found');
    send(res, 200, tenantReferral(t));
  }, { auth: 'super' });
  route('PUT', '/api/super/tenants/:id/referral', async (req, res, p) => {
    const t = getTenant(p.id); if (!t) throw new HttpError(404, 'Not found');
    const b = await json(req);
    const affId = Number(b.affiliate_id) || null;
    if (affId) {
      const a = getAffiliate(affId);
      if (!a) throw new HttpError(404, 'That affiliate doesn’t exist. Reload the page and pick again.');
      if (a.tenant_id === t.id) throw new HttpError(400, 'A business can’t refer itself. Pick a different affiliate.');
      // Payments from this day on count (never before the business signed up).
      const day = pastDay(b.from, 'start date');
      const at = day ? (`${day} 00:00:00` < t.created_at ? t.created_at : `${day} 00:00:00`) : now();
      if (affId !== t.referred_by_affiliate_id || day) setReferral(t.id, affId, 'admin', at);
    } else setReferral(t.id, null);
    resyncTenantLedger(t.id);
    send(res, 200, tenantReferral(getTenant(t.id)));
  }, { auth: 'super' });

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

  // Checks the Stripe settings in Render (never showing them) and asks Stripe to confirm the key.
  route('POST', '/api/super/stripe-check', async (req, res) => {
    const checks = [];
    const keyProblem = env.STRIPE_SECRET_KEY ? stripeSettingProblem('STRIPE_SECRET_KEY', env.STRIPE_SECRET_KEY) : 'No STRIPE_SECRET_KEY is set on the server.';
    // Payments on businesses' own accounts only reach HitchPoint through the Connected-accounts webhook.
    const connect = env.STRIPE_CONNECT_WEBHOOK_SECRET ? stripeSettingProblem('STRIPE_CONNECT_WEBHOOK_SECRET', env.STRIPE_CONNECT_WEBHOOK_SECRET, 'webhook') : 'No STRIPE_CONNECT_WEBHOOK_SECRET is set, so HitchPoint won’t hear when customers pay a business. Add the signing secret of your Connected-accounts webhook in Render.';
    const legacy = env.STRIPE_WEBHOOK_SECRET ? stripeSettingProblem('STRIPE_WEBHOOK_SECRET', env.STRIPE_WEBHOOK_SECRET, 'webhook') : '';
    checks.push({ name: 'Webhook signing secret (connected accounts)', ok: !connect, message: connect || 'Looks right (starts with whsec_).' });
    if (env.STRIPE_WEBHOOK_SECRET) checks.push({ name: 'Webhook signing secret (your account)', ok: !legacy, message: legacy || 'Looks right (starts with whsec_).' });
    const mode = cleanSecret(env.STRIPE_SECRET_KEY).includes('_live_') ? 'live' : 'test';
    if (keyProblem) return send(res, 200, { ok: false, error: keyProblem, checks });
    const onLiveSite = /gethitchpoint\.com/i.test(env.PLATFORM_URL || env.BASE_URL || '');
    const modeNote = onLiveSite && mode === 'test' ? ' Warning: this is a TEST key on the live site, so real customers can’t pay. Use your sk_live_ key here.' : '';
    try {
      const a = await stripe.platformAccount();
      send(res, 200, { ok: true, test_mode: stripe.testMode, mode_note: modeNote, account_id: a.id, name: a.settings?.dashboard?.display_name || a.business_profile?.name || '', charges_enabled: Boolean(a.charges_enabled), details_submitted: Boolean(a.details_submitted), checks });
    } catch (e) {
      send(res, 200, { ok: false, error: `The key looks right, but Stripe turned it down: ${e.message} If you rolled (replaced) the key in Stripe, paste the new one into Render.`, checks });
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
    const ref = adminReferralCode(b.referral_code);
    const t = db.prepare(`INSERT INTO tenants (slug, name, email, phone, notify_phone) VALUES (?,?,?,?,?)`).run(uniqueSlug(business), business, email, clean(b.phone, 40), clean(b.phone, 40));
    const tid = Number(t.lastInsertRowid);
    if (ref) setReferral(tid, ref.id, 'admin');
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
    // An old or mistyped service link goes to the business's services instead of an error page.
    if (!product) { res.writeHead(302, { Location: `${onDomain ? '/' : `/s/${t.slug}`}#services`, 'Cache-Control': 'no-store' }); return res.end(); }
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
            // 'affiliate': a referral partner's own login (no business), or a business user as for 'tenant'.
            if (r.auth === 'affiliate' && ctx.user.role === 'affiliate') { /* no business to check */ }
            else if (r.auth === 'tenant' || r.auth === 'owner' || r.auth === 'affiliate') {
              if (!ctx.tenant) throw new HttpError(ctx.isSuper ? 409 : 403, ctx.isSuper ? 'Choose a business to view first.' : 'Forbidden');
              if (!ctx.isSuper && ctx.tenant.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact support.');
              if (!ctx.isSuper && needsAgreements(ctx.user)) throw new HttpError(428, 'Please accept the updated agreements.');
              // A business that hasn't connected its own Stripe account keeps its whole dashboard (requests,
              // quotes, cash and check). Only online payments wait (onlineReady), and the dashboard shows a
              // banner asking the owner to connect.
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
      // Affiliate referral links, sign-up links that carry a code, and the Affiliate Program Terms.
      if ((um = /^\/a\/([^/]{1,80})\/?$/.exec(pathname))) return affiliateClick(req, res, um[1]);
      if (pathname === '/signup' && AFF.CODE_RE.test(AFF.normalizeCode(url.searchParams.get('ref')))) { res.writeHead(302, { Location: `/admin/?ref=${AFF.normalizeCode(url.searchParams.get('ref'))}#/signup`, 'Cache-Control': 'no-store' }); return res.end(); }
      if (pathname === '/legal/affiliate-terms' && serveFile(res, 'legal/affiliate-terms.html')) return;

      if (ownerFeaturePage(req, res, pathname)) return; // owner features: calendar feed, app manifest, offline page
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
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong. Try again.' : e.message, ...(e.field && status !== 500 ? { field: e.field } : {}) });
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
