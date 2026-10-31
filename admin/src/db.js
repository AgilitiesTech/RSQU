import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'rsqu.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('repair','winterize')),
      status TEXT NOT NULL DEFAULT 'new',
      name TEXT, phone TEXT NOT NULL, email TEXT,
      location TEXT NOT NULL, rig TEXT, issue TEXT, preferred_date TEXT,
      photo TEXT, notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL, description TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      taxable INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY,
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
      token TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('deposit','quote')),
      request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
      quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      method TEXT NOT NULL DEFAULT 'card',
      status TEXT NOT NULL DEFAULT 'pending',
      stripe_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);

  const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'seeded'`).get();
  if (!seeded) {
    const ins = db.prepare(`INSERT INTO products (name, description, price_cents, taxable) VALUES (?, ?, ?, 0)`);
    ins.run('Onsite winterizing package', 'All 12 winterizing steps, RV antifreeze, labor and travel within the service area', 49900);
    ins.run('Repair diagnosis and onsite review', 'Diagnosis and onsite review for a custom quote. Credited toward the job if work is agreed.', 12900);
    const set = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
    set.run('tax_rate_bp', '0');
    set.run('deposit_cents', '12900');
    set.run('terms', 'Work is done onsite as described above. Parts and labor not listed are quoted separately and only done with your approval. The $129 diagnosis deposit, if paid, is credited toward this job. Payment is due when the work is complete.');
    set.run('seeded', '1');
  }
  return db;
}

export function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return {
    tax_rate_bp: Number(out.tax_rate_bp || 0),
    deposit_cents: Number(out.deposit_cents || 12900),
    terms: out.terms || '',
  };
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
