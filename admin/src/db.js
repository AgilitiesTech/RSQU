import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const AGREEMENT_VERSION = '2026-11-02';
export const BUSINESS_AGREEMENTS = ['terms', 'privacy', 'payment-terms'];

export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'rsqu.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',          -- active | suspended
      phone TEXT, email TEXT, notify_phone TEXT,
      tagline TEXT, hero_headline TEXT, about TEXT, service_area TEXT,
      primary_color TEXT NOT NULL DEFAULT '#B0141C',
      accent_color TEXT NOT NULL DEFAULT '#F2CE6E',
      logo TEXT, owner_photo TEXT,
      website_url TEXT, custom_domain TEXT UNIQUE,
      tax_rate_bp INTEGER NOT NULL DEFAULT 0,
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      deposit_label TEXT NOT NULL DEFAULT 'Diagnosis and onsite review',
      terms TEXT,
      -- Stripe Express connected account that receives payouts (direct deposit)
      stripe_account_id TEXT, stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0, stripe_details_submitted INTEGER NOT NULL DEFAULT 0,
      statement_name TEXT,                            -- short name on customers' card statements
      fee_bp INTEGER,                                 -- platform share in basis points; NULL = platform default
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','staff','super')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agreements (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      doc TEXT NOT NULL, version TEXT NOT NULL,
      accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
      ip TEXT, ua TEXT
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('repair','booking')),
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'new',
      name TEXT, phone TEXT NOT NULL, email TEXT,
      location TEXT NOT NULL, rig TEXT, issue TEXT, preferred_date TEXT,
      photo TEXT, notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      taxable INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      on_site INTEGER NOT NULL DEFAULT 0,             -- show on the hosted website
      bookable INTEGER NOT NULL DEFAULT 0,            -- customers can book it as a package
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      title TEXT NOT NULL DEFAULT 'Repair proposal',
      customer_name TEXT, customer_phone TEXT, customer_email TEXT,
      location TEXT, rig TEXT, notes TEXT, terms TEXT,
      tax_rate_bp INTEGER NOT NULL DEFAULT 0,
      deposit_credit_cents INTEGER NOT NULL DEFAULT 0,
      signer_name TEXT, signature_png TEXT, signer_ip TEXT, signer_ua TEXT, signed_at TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quote_items (
      id INTEGER PRIMARY KEY,
      quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      name TEXT NOT NULL, description TEXT,
      qty REAL NOT NULL DEFAULT 1,
      unit_cents INTEGER NOT NULL DEFAULT 0,
      taxable INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('deposit','quote')),
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,                  -- what the customer pays
      method TEXT NOT NULL DEFAULT 'card',
      status TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id TEXT, charge_id TEXT,
      -- Online payments: Processing Fee = stripe_fee_cents + fee_cents, retained before payout
      stripe_fee_cents INTEGER NOT NULL DEFAULT 0,    -- Stripe's actual fee to the platform
      fee_cents INTEGER NOT NULL DEFAULT 0,           -- platform share (3%)
      payout_cents INTEGER NOT NULL DEFAULT 0,        -- transferred to the business
      transfer_id TEXT, transfer_status TEXT,         -- NULL (offline) | pending | sent | failed
      transfer_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY,
      name TEXT, email TEXT, phone TEXT, business_name TEXT, location TEXT, certifications TEXT, message TEXT,
      source TEXT, status TEXT NOT NULL DEFAULT 'new', notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE INDEX IF NOT EXISTS ix_req_tenant ON requests(tenant_id, status);
    CREATE INDEX IF NOT EXISTS ix_quotes_tenant ON quotes(tenant_id);
    CREATE INDEX IF NOT EXISTS ix_pay_tenant ON payments(tenant_id, status);
    CREATE INDEX IF NOT EXISTS ix_products_tenant ON products(tenant_id);
  `);
  const set = db.prepare(`INSERT OR IGNORE INTO platform_settings (key, value) VALUES (?, ?)`);
  set.run('fee_bp', '300');
  return db;
}

export function platformSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM platform_settings').all()) out[r.key] = r.value;
  return { fee_bp: Number(out.fee_bp ?? 300) };
}

// Platform share of an online payment (the 3% part of the Processing Fee).
export function platformFee(db, tenant, amountCents) {
  const bp = tenant.fee_bp ?? platformSettings(db).fee_bp;
  return { bp, fee: Math.round((amountCents * bp) / 10000) };
}

// Totals for a quote. All money is integer cents.
export function quoteTotals(quote, items) {
  let subtotal = 0, taxableBase = 0;
  for (const it of items) {
    const line = Math.round(it.qty * it.unit_cents);
    subtotal += line;
    if (it.taxable) taxableBase += line;
  }
  const tax = Math.round((taxableBase * quote.tax_rate_bp) / 10000);
  const total = subtotal + tax;
  const credit = Math.min(quote.deposit_credit_cents || 0, total);
  return { subtotal, tax, total, credit, balance: total - credit };
}

export function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48) || 'business';
}
