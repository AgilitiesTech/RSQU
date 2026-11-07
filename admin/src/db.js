import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Bump when the platform legal documents change: every owner is asked to accept again.
// 2026-11-02.2: businesses become the merchant of record (direct charges on their own Stripe account).
// 2026-11-02.3: Terms of Service say a referring business may get a share of HitchPoint's fees.
// 2026-11-03.1: Privacy Policy covers affiliates' tax forms and bank details.
// 2026-11-03.2: Privacy Policy: how affiliates' phone numbers are used; tax IDs never sold or shown; secure disposal.
export const AGREEMENT_VERSION = '2026-11-03.2';
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
      -- The business's own Stripe account (see stripe_account_type in migrate()); legacy: Express payout account
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
      role TEXT NOT NULL CHECK (role IN ('owner','staff','super','affiliate')), -- affiliate: a referral partner with no business
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
      payout_cents INTEGER NOT NULL DEFAULT 0,        -- what the business keeps (direct) or was transferred (legacy)
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
  migrate(db);
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

// ---------- additive migrations (safe to run on every start) ----------
function addColumn(db, table, column, definition) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Changes a table's definition in a way ALTER TABLE can't (a CHECK or NOT NULL), the way SQLite
// recommends: copy into a new table, drop the old one, rename, and put back its indexes and
// triggers, in one transaction. Foreign keys are off during the swap and checked before committing.
// edit(sql) returns the new CREATE TABLE text; if it returns the same text, nothing happens.
export function rebuildTable(db, name, edit) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  if (!row) return false;
  const next = edit(row.sql);
  if (next === row.sql) return false;
  const tmp = `${name}__rebuild`;
  const created = next.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?("?)(\w+)\2/i, `CREATE TABLE ${tmp}`);
  if (created === next) throw new Error(`Couldn't read the definition of ${name}.`);
  const extras = db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL`).all(name).map((r) => r.sql);
  const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => `"${c.name}"`).join(', ');
  const brokenBefore = db.prepare('PRAGMA foreign_key_check').all().length;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(created);
      db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${name}`);
      db.exec(`DROP TABLE ${name}`);
      db.exec(`ALTER TABLE ${tmp} RENAME TO ${name}`);
      for (const s of extras) db.exec(s);
      const brokenAfter = db.prepare('PRAGMA foreign_key_check').all().length;
      if (brokenAfter > brokenBefore) throw new Error(`Rebuilding ${name} would break ${brokenAfter - brokenBefore} foreign key reference(s).`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
  return true;
}

function migrate(db) {
  // Referral partners who aren't businesses log in with role 'affiliate' (older databases had a
  // CHECK without it).
  rebuildTable(db, 'users', (sql) => (/'affiliate'/.test(sql) ? sql : sql.replace(/(role\s+IN\s*\([^)]*)\)/i, "$1,'affiliate')")));
  // Seller of record. 'v2_merchant': the business's own Stripe account (Accounts v2, merchant
  // configuration). Customers pay it directly (direct charges), so the business is the merchant
  // of record. NULL with a stripe_account_id = a legacy Express payout account from the old
  // model, where the platform was the merchant of record and transferred payouts.
  addColumn(db, 'tenants', 'stripe_account_type', 'TEXT');
  addColumn(db, 'tenants', 'legacy_stripe_account_id', 'TEXT');
  // One-time business setup used in the customer Terms & Conditions, proposals and payment pages
  // (legal name, address, license, insurance, policies). JSON; see src/customer-terms.js.
  addColumn(db, 'tenants', 'legal_profile', 'TEXT');
  // Website sections and local-search details the business edits itself (src/site-profile.js)
  addColumn(db, 'tenants', 'site_profile', 'TEXT');
  // Set the first time a request arrives on the business's own domain (DNS points here), so its domain
  // becomes the canonical address only once it actually works.
  addColumn(db, 'tenants', 'domain_live_at', 'TEXT');

  // Which terms version a customer accepted when signing a proposal.
  addColumn(db, 'quotes', 'customer_terms_version', 'INTEGER');
  addColumn(db, 'quotes', 'customer_terms_sha256', 'TEXT');

  // 'direct' = charged on the business's own Stripe account (business is merchant of record).
  // NULL = legacy platform charge followed by a transfer.
  addColumn(db, 'payments', 'charge_type', 'TEXT');
  addColumn(db, 'payments', 'stripe_account', 'TEXT');
  addColumn(db, 'payments', 'customer_terms_version', 'INTEGER');
  // Part of the platform's 3% returned to the business on refunds (Payment Terms § 6).
  addColumn(db, 'payments', 'fee_refunded_cents', 'INTEGER NOT NULL DEFAULT 0');

  // Every customer Terms & Conditions version a business owner approved. Append-only, so the
  // exact wording any customer agreed to can always be shown again.
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_terms (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      markdown TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      source TEXT NOT NULL,                 -- template | customized
      template_version TEXT NOT NULL,
      profile_fingerprint TEXT NOT NULL,
      approver_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approver_name TEXT NOT NULL,
      approver_title TEXT NOT NULL,
      attestation TEXT NOT NULL,            -- the exact statement the owner confirmed
      ip TEXT, ua TEXT,
      approved_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tenant_id, version)
    );
  `);

  // Photos the technician took for a proposal ([{ file, show }]) and the AI draft notes for the
  // technician (findings, safety notes, questions). Both JSON.
  addColumn(db, 'quotes', 'photos', 'TEXT');
  addColumn(db, 'quotes', 'ai_draft', 'TEXT');
  // Products as services on the website: a tile picture, a longer write-up for the service's own page,
  // and the order they appear in.
  addColumn(db, 'products', 'image', 'TEXT');
  addColumn(db, 'products', 'details', 'TEXT');
  addColumn(db, 'products', 'sort', 'INTEGER NOT NULL DEFAULT 0');
  // When the customer's receipt was sent (text and/or email), so it's sent once.
  addColumn(db, 'payments', 'receipt_sent_at', 'TEXT');

  // Each business's customers and what they agreed to receive. Consent is recorded with the exact
  // wording shown, when, from where, and on which proposal.
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT, phone TEXT, phone_key TEXT, email TEXT,
      email_opt_in INTEGER NOT NULL DEFAULT 0, email_consent_at TEXT, email_consent_text TEXT, email_unsubscribed_at TEXT,
      sms_opt_in INTEGER NOT NULL DEFAULT 0, sms_consent_at TEXT, sms_consent_text TEXT,
      consent_ip TEXT, consent_ua TEXT, source TEXT,
      unsub_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS customers_phone ON customers (tenant_id, phone_key);
    CREATE INDEX IF NOT EXISTS customers_email ON customers (tenant_id, email);
    -- Every opt-in and opt-out, append-only: the proof of who agreed to what, where, and when.
    CREATE TABLE IF NOT EXISTS consent_log (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
      action TEXT NOT NULL CHECK (action IN ('opt_in','opt_out')),
      address TEXT NOT NULL,                -- the email address or phone number it applies to
      text TEXT, source TEXT, ip TEXT, ua TEXT,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  migrateAffiliates(db);
  migrateOwnerFeatures(db);
  migrateCommunity(db);
  migrateLeadSource(db);
}

// Affiliate (referral revenue-share) program. Agilities pays an affiliate business a share of
// HitchPoint's net platform fee on online payments from businesses it referred (src/affiliates.js).
function migrateAffiliates(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER UNIQUE REFERENCES tenants(id) ON DELETE CASCADE, -- a business on the platform, or NULL for a person or group (user_id)
      code TEXT NOT NULL UNIQUE,                       -- /a/<code> and the sign-up form; /^[a-z0-9-]{3,40}$/
      share_bp INTEGER NOT NULL CHECK (share_bp BETWEEN 0 AND 10000), -- of HitchPoint's net fee; 2000 = 20%
      months INTEGER CHECK (months IS NULL OR months > 0),             -- from the referred business's sign-up; NULL = as long as it stays
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')), -- paused: no new referrals
      w9_on_file INTEGER NOT NULL DEFAULT 0, w9_on_file_at TEXT,
      terms_accepted_at TEXT, terms_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Every share/duration an affiliate has had, so each payment uses the terms in effect when it was paid.
    CREATE TABLE IF NOT EXISTS affiliate_rates (
      id INTEGER PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      share_bp INTEGER NOT NULL, months INTEGER,
      effective_at TEXT NOT NULL                       -- 'YYYY-MM-DD HH:MM:SS.sss' UTC
    );
    CREATE INDEX IF NOT EXISTS ix_aff_rates ON affiliate_rates(affiliate_id, effective_at);
    -- Link clicks per day. Unique visitors are counted from a keyed hash of the IP that is kept only
    -- for the current day (affiliate_click_visitors); raw IPs are never stored.
    CREATE TABLE IF NOT EXISTS affiliate_clicks (
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      day TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0, uniques INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (affiliate_id, day)
    );
    CREATE TABLE IF NOT EXISTS affiliate_click_visitors (
      affiliate_id INTEGER NOT NULL, day TEXT NOT NULL, ip_hash TEXT NOT NULL,
      PRIMARY KEY (affiliate_id, day, ip_hash)
    );
    CREATE INDEX IF NOT EXISTS ix_aff_visitors_day ON affiliate_click_visitors(day);
    CREATE TABLE IF NOT EXISTS affiliate_payouts (
      id INTEGER PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      method TEXT NOT NULL CHECK (method IN ('ach','check','stripe','other')),
      reference TEXT,
      paid_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Append-only: amounts never change and rows are never deleted. Only status moves
    -- (pending -> available after the hold -> paid with a payout).
    CREATE TABLE IF NOT EXISTS affiliate_ledger (
      id INTEGER PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id),
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,    -- the referred business
      payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
      type TEXT NOT NULL CHECK (type IN ('earning','reversal','payout','adjustment')),
      amount_cents INTEGER NOT NULL,                   -- signed
      status TEXT NOT NULL CHECK (status IN ('pending','available','paid')),
      available_at TEXT,
      payout_id INTEGER REFERENCES affiliate_payouts(id),
      share_bp INTEGER,                                -- the share applied (earnings and reversals)
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ix_aff_ledger ON affiliate_ledger(affiliate_id, status);
    CREATE INDEX IF NOT EXISTS ix_aff_ledger_pay ON affiliate_ledger(payment_id);
    CREATE TRIGGER IF NOT EXISTS affiliate_ledger_no_delete BEFORE DELETE ON affiliate_ledger
      BEGIN SELECT RAISE(ABORT, 'affiliate_ledger is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS affiliate_ledger_fixed BEFORE UPDATE OF affiliate_id, type, amount_cents ON affiliate_ledger
      BEGIN SELECT RAISE(ABORT, 'affiliate_ledger amounts never change'); END;
    -- Status only moves forward: pending -> available, available -> paid (with a payout), or pending ->
    -- paid (with a payout) once the hold has passed. A payout, once set, is never cleared or changed.
    -- Its own name, so databases created before it get it too.
    CREATE TRIGGER IF NOT EXISTS affiliate_ledger_moves BEFORE UPDATE OF status, payout_id ON affiliate_ledger
      WHEN NOT ((OLD.payout_id IS NULL OR NEW.payout_id IS OLD.payout_id) AND (
        NEW.status = OLD.status
        OR (OLD.status = 'pending' AND NEW.status = 'available')
        OR (OLD.status = 'available' AND NEW.status = 'paid' AND NEW.payout_id IS NOT NULL)
        OR (OLD.status = 'pending' AND NEW.status = 'paid' AND NEW.payout_id IS NOT NULL AND OLD.available_at <= datetime('now'))))
      BEGIN SELECT RAISE(ABORT, 'affiliate_ledger status only moves forward'); END;
  `);
  // Who referred a business, when (payments before this earn nothing), and how: link | code | admin.
  addColumn(db, 'tenants', 'referred_by_affiliate_id', 'INTEGER REFERENCES affiliates(id)');
  addColumn(db, 'tenants', 'referred_at', 'TEXT');
  addColumn(db, 'tenants', 'referred_how', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS ix_tenants_referrer ON tenants(referred_by_affiliate_id)');
  migrateAffiliateInvites(db);
}

// Affiliates who aren't businesses (a person, club or group with its own login), invitations by
// email, electronic W-9s and payout details. Tax ID and bank numbers are stored encrypted
// (src/sealed.js); only the last 4 digits are kept readable.
function migrateAffiliateInvites(db) {
  // Databases from before affiliates could be people: tenant_id was required.
  rebuildTable(db, 'affiliates', (sql) => sql.replace(/tenant_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE/i, 'tenant_id INTEGER UNIQUE'));
  addColumn(db, 'affiliates', 'user_id', 'INTEGER REFERENCES users(id)');  // the login of a person or group affiliate
  addColumn(db, 'affiliates', 'name', 'TEXT');                             // person or group name (businesses use tenants.name)
  addColumn(db, 'affiliates', 'email', 'TEXT');
  addColumn(db, 'affiliates', 'phone', 'TEXT');
  addColumn(db, 'affiliates', 'audience', 'TEXT');                         // where they said they'll share their link
  addColumn(db, 'affiliates', 'payout_method', 'TEXT');                    // ach | check
  addColumn(db, 'affiliates', 'payout_sealed', 'TEXT');                    // encrypted JSON: holder, routing, account, type
  addColumn(db, 'affiliates', 'payout_last4', 'TEXT');
  addColumn(db, 'affiliates', 'payout_updated_at', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_affiliates_user ON affiliates(user_id) WHERE user_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS affiliate_invites (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE,
      share_bp INTEGER NOT NULL CHECK (share_bp BETWEEN 0 AND 10000),
      months INTEGER CHECK (months IS NULL OR months > 0),
      token_hash TEXT NOT NULL UNIQUE,                 -- sha256 of the link token; the token itself is never stored
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','canceled')),
      affiliate_id INTEGER REFERENCES affiliates(id),
      created_by INTEGER,
      sent_count INTEGER NOT NULL DEFAULT 0, last_sent_at TEXT,
      accepted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_aff_invites_pending ON affiliate_invites(email) WHERE status = 'pending';
    -- Every W-9 an affiliate submits, append-only; the newest is the one in effect.
    CREATE TABLE IF NOT EXISTS affiliate_w9 (
      id INTEGER PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id),
      form_revision TEXT NOT NULL,
      legal_name TEXT NOT NULL, business_name TEXT,
      tax_class TEXT NOT NULL, llc_class TEXT, other_class TEXT,
      foreign_owners INTEGER NOT NULL DEFAULT 0,
      exempt_payee_code TEXT, fatca_code TEXT,
      address TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL,
      tin_type TEXT NOT NULL CHECK (tin_type IN ('ssn','ein')),
      tin_sealed TEXT NOT NULL, tin_last4 TEXT NOT NULL,
      backup_withholding INTEGER NOT NULL DEFAULT 0,  -- the payee crossed out certification item 2
      signature TEXT NOT NULL, signed_at TEXT NOT NULL,
      user_id INTEGER, signer_email TEXT, ip TEXT, ua TEXT,
      record_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ix_aff_w9 ON affiliate_w9(affiliate_id, id);
    CREATE TRIGGER IF NOT EXISTS affiliate_w9_no_update BEFORE UPDATE ON affiliate_w9
      BEGIN SELECT RAISE(ABORT, 'affiliate_w9 is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS affiliate_w9_no_delete BEFORE DELETE ON affiliate_w9
      BEGIN SELECT RAISE(ABORT, 'affiliate_w9 is append-only'); END;
    -- Who saw or changed tax and bank details, and when.
    CREATE TABLE IF NOT EXISTS sensitive_access_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER, user_email TEXT,
      affiliate_id INTEGER,
      what TEXT NOT NULL,       -- w9_submitted | w9_viewed | payout_changed | bank_viewed
      ip TEXT, ua TEXT,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ix_sensitive_access ON sensitive_access_log(affiliate_id, id);
  `);
}

// Owner features: time zone, background sender, review requests, scheduling, invoices, update emails.
function migrateOwnerFeatures(db) {
  // The business's time zone (IANA name). Receipts, reminders and quiet hours use it.
  addColumn(db, 'tenants', 'timezone', "TEXT NOT NULL DEFAULT 'America/Denver'");
  // Review requests after payment. review_requests NULL = on by default once there's a Google review link.
  addColumn(db, 'tenants', 'review_requests', 'INTEGER');
  addColumn(db, 'tenants', 'review_delay_hours', 'INTEGER NOT NULL DEFAULT 24');
  addColumn(db, 'tenants', 'review_message', 'TEXT');
  // The owner turned on Affirm/Klarna in Stripe: show "Pay over time available at checkout".
  addColumn(db, 'tenants', 'pay_over_time', 'INTEGER NOT NULL DEFAULT 0');
  // 'invoice' skips signing: the customer accepts the business's terms by paying.
  addColumn(db, 'quotes', 'kind', "TEXT NOT NULL DEFAULT 'proposal'");
  // Why a payment needs the owner's attention (paid after a void, paid twice, more or less than was due).
  addColumn(db, 'payments', 'note', 'TEXT');
  // Refunds the business made from its Stripe Dashboard (charge.refunded), for the QuickBooks download.
  addColumn(db, 'payments', 'refunded_cents', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'payments', 'refunded_at', 'TEXT');
  // Private calendar feed per user (/cal/<token>.ics).
  addColumn(db, 'users', 'cal_token', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_cal_token ON users (cal_token) WHERE cal_token IS NOT NULL;

    -- Appointments.
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
      customer_name TEXT, customer_phone TEXT, customer_email TEXT, address TEXT,
      start_at TEXT NOT NULL,                       -- UTC 'YYYY-MM-DD HH:MM:SS'
      duration_min INTEGER NOT NULL DEFAULT 60,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','en_route','done','canceled')),
      on_way_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS jobs_tenant_start ON jobs (tenant_id, start_at);

    -- Messages the background sender delivers. The wording is built when it's sent, so a changed
    -- appointment or a customer who unsubscribed in the meantime is always respected.
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,                           -- job_confirm | job_reminder | review | campaign
      channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
      to_addr TEXT NOT NULL,
      ref_id INTEGER,                               -- job, payment or campaign id
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      meta TEXT,                                    -- JSON
      send_after TEXT NOT NULL,                     -- UTC
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped','failed','canceled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS sched_due ON scheduled_messages (status, send_after);
    CREATE INDEX IF NOT EXISTS sched_ref ON scheduled_messages (tenant_id, kind, ref_id);

    -- Numbers that replied STOP to the platform's text number (Twilio blocks them too).
    CREATE TABLE IF NOT EXISTS sms_stops (
      phone_key TEXT PRIMARY KEY,
      word TEXT,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Update and offer emails a business sent to its subscribers.
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      recipients INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'sending',      -- sending | done
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS campaigns_tenant ON campaigns (tenant_id, created_at);
  `);
  // STOP replies from before sms_stops existed were only written to consent_log ("Replied STOP").
  // Copy them over once. Once only, so a later START reply isn't undone on the next restart.
  if (!db.prepare(`SELECT 1 FROM platform_settings WHERE key = 'sms_stops_backfilled'`).get()) {
    const ins = db.prepare('INSERT OR IGNORE INTO sms_stops (phone_key, word, at) VALUES (?,?,?)');
    const rows = db.prepare(`SELECT address, text, at FROM consent_log WHERE channel = 'sms' AND action = 'opt_out' AND substr(text, 1, 8) = 'Replied ' ORDER BY id DESC`).all();
    for (const r of rows) {
      const digits = String(r.address || '').replace(/\D/g, '');
      if (digits.length >= 10) ins.run(digits.slice(-10), r.text.slice(8).trim().toUpperCase(), r.at);
    }
    db.prepare(`INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('sms_stops_backfilled', datetime('now'))`).run();
  }
}

// Where a website request came from (src/lead-source.js): the visit's tracking tags, Google's click ID,
// the page it landed on, the site that sent it, and what the customer picked for "How did you hear
// about us?". All empty for call-ins the owner adds and for requests from before this existed.
function migrateLeadSource(db) {
  for (const col of ['src_source', 'src_medium', 'src_campaign', 'src_term', 'src_content', 'src_click_id', 'src_click_type', 'src_landing', 'src_referrer', 'src_at', 'heard_about']) {
    addColumn(db, 'requests', col, 'TEXT');
  }
}

// Blog posts and the questions-and-answers board on business websites (src/community.js).
// Both are off until the owner turns them on.
function migrateCommunity(db) {
  addColumn(db, 'tenants', 'blog_on', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'tenants', 'qa_on', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,                           -- its address; fixed once published
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',             -- for Google and link previews
      body TEXT NOT NULL DEFAULT '',
      image TEXT,                                   -- cover photo (uploads, t<id>-post-…)
      city TEXT,                                    -- a town page slug it also shows on
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS posts_slug ON posts (tenant_id, slug);
    CREATE INDEX IF NOT EXISTS posts_published ON posts (tenant_id, status, published_at);

    -- Questions visitors send from the business's website. Name, email and the original wording stay
    -- private; only the owner's title and answer are shown, and only after the owner publishes them.
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      question TEXT NOT NULL,                       -- as the visitor wrote it
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      ip TEXT, ua TEXT,
      title TEXT,                                   -- the question as shown on the site
      answer TEXT,
      slug TEXT,                                    -- set when first published, then fixed
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','published','hidden')),
      published_at TEXT,
      answered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      asker_notified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS questions_slug ON questions (tenant_id, slug) WHERE slug IS NOT NULL;
    CREATE INDEX IF NOT EXISTS questions_status ON questions (tenant_id, status, created_at);
  `);
}
