# HitchPoint (RSQU admin)

**HitchPoint** (a d/b/a of Agilities) is a white-label back office for mobile RV and trailer repair businesses. The marketing site for recruiting owners is served at `/` (point the HitchPoint domain at this app). The first business on it is Mike Stevens Emergency RV & Trailer Repair.

**Each business gets:** sign-up and log-in, its own brand (name, colors, logo, photo), a hosted website with a request form (`/s/<business>` or its own domain), a request inbox with photo, GPS, call/text/map, an optional up-front deposit (Mike: $129, credited toward the job), onsite quotes from its products list, a branded proposal the customer signs with a finger, online card and bank payments with payouts to its bank by direct deposit, cash/check recording, team members, and text alerts.

**Agilities gets:** the HitchPoint landing page with lead capture, a super admin dashboard over every business, and a **Processing Fee** on every online payment: Stripe’s actual fee plus 3%, kept before the business is paid out. Also per-business overrides of the 3%, suspend/restore, “open their dashboard” access, password reset links, agreement records, and a CSV of all Processing Fees.

No outside packages: Node.js 22.13+ with built-in SQLite. Data and uploads live in `DATA_DIR`.

```bash
cd admin
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD=choose-a-long-one node --no-warnings server.js
npm test   # end-to-end tests with a fake Stripe
```

---

## Agilities: run the platform

### 1. Deploy

- **Render:** New → Blueprint → this repo (`render.yaml` at the repo root). Starter plan with a 1 GB disk.
- **Anywhere with Docker:** build `admin/Dockerfile`, mount a volume at `/data`.

Required settings (see `.env.example`): `SUPER_ADMIN_EMAIL` (aaron@agilitiestech.com), `SUPER_ADMIN_PASSWORD`, `BASE_URL` (the app’s public address, e.g. `https://app.hitchpoint…`), and `PLATFORM_URL` (the marketing domain, used for canonical links and the sitemap). `PLATFORM_CONTACT_EMAIL` defaults to aaron@agilitiestech.com and receives lead and sign-up alerts. The super admin account is created on first start; change the password afterwards from Settings, and you can then remove `SUPER_ADMIN_PASSWORD`.

### 2. Set up Stripe (once, on the Agilities / HitchPoint Stripe account)

**How money moves:** every online payment is charged on the HitchPoint Stripe account (HitchPoint is the merchant of record and pays Stripe’s fee). When the payment clears, the app reads Stripe’s actual fee for it, keeps that plus 3% (shown to owners as one “Processing Fee”), and transfers the rest to the owner’s Stripe Express account, which pays out to their bank by direct deposit. Customers pay only the amount due. If an owner isn’t verified yet, the payout waits and goes out automatically once Stripe finishes; you can also retry from the business page.

1. Settings → Business: set the public business name and the **statement descriptor** to `HITCHPOINT` (customers’ statements show it plus the owner’s business name).
2. **Connect** → Get started → **Platform**; enable **Express** accounts with the **transfers** capability. Connect → Settings → Branding: HitchPoint name, icon (`public/brand/favicon.svg`) and color `#10243A`.
3. Developers → **API keys**: secret key into `STRIPE_SECRET_KEY` (start with `sk_test_…`).
4. Developers → **Webhooks**: two endpoints, both to `https://<BASE_URL>/api/stripe/webhook`:
   - **Your account** events `checkout.session.completed`, `checkout.session.async_payment_succeeded` → secret into `STRIPE_WEBHOOK_SECRET`.
   - **Connected accounts** event `account.updated` → secret into `STRIPE_CONNECT_WEBHOOK_SECRET`.
5. Settings → Payment methods: turn on **ACH Direct Debit** to give customers a cheaper bank option (lower Stripe fee, bigger payout for the owner).

Your 3% builds up in the HitchPoint Stripe balance and pays out to the Agilities bank account on your normal schedule. As merchant of record, HitchPoint receives refunds requests and disputes; recover them from the owner by reversing the transfer in Stripe (Connect → Transfers).

### 3. Manage businesses

Log in at `https://<BASE_URL>/admin` with the super admin email. You land on **Businesses**:

- **Totals:** your 3% this month and all time, Stripe fees passed through, online volume, payouts to owners, payouts waiting, new leads. **Download Processing Fees (CSV)** for bookkeeping (customer paid, Stripe fee, platform share, payout, transfer IDs).
- **Leads:** owners who filled in “Talk to us” on the landing page (you also get an email at `PLATFORM_CONTACT_EMAIL` if email is set up). Call, text or email them from here and track status.
- **Add a business:** enter the business and owner email. You get a setup link (valid 7 days) to send the owner. They set a password and accept the agreements on first log-in. Owners can also sign themselves up at `https://<BASE_URL>/signup`.
- **Open a business** to:
  - **Open their dashboard:** work inside their account exactly as they see it (a yellow bar shows you are viewing as them; “Back to all businesses” returns you).
  - **Suspend / restore:** a suspended business can’t log in, take requests, or show its website.
  - **Platform share:** leave blank for the default 3%, or set a custom % for this business.
  - **Payout account:** the owner’s Stripe Express account (`acct_…`), created when they set up direct deposit.
  - **Payments:** each online payment with Stripe fee, your share, payout and payout status, with **Retry** for any payout that’s waiting.
  - **Reset link** for any user, the **agreements log** (document, version, time, IP), and their **payments** with Processing Fees.
- **Platform** tab: the default platform share (3%) and service status.

Owners see the Stripe fee + 3% only as **Processing Fee**. Customers pay no fee and see their business’s brand; their card statement reads HITCHPOINT plus the business name.

### 4. Optional services

- **Text alerts** (Twilio): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Each business enters the number to alert on its Business page.
- **Password reset emails** (Resend): `RESEND_API_KEY`, `EMAIL_FROM`. Without it, send reset links by hand from the business page.

### 5. Custom domains

A business can serve its hosted site from its own domain: it adds a CNAME pointing at the dashboard host and enters the domain on its Business page. Your host must also accept the domain and issue TLS for it (on Render: Settings → Custom Domains).

### 6. Legal

Drafts are in `public/legal/` and served at `/legal/terms`, `/legal/privacy`, `/legal/payment-terms` and `/legal/customer-terms`. Fill in the bracketed placeholders and **have a lawyer review them before launch**, especially the Processing Fee rules (see below). Agreement acceptance is recorded with version `2026-11-01` (`AGREEMENT_VERSION` in `src/db.js`); bump it when the documents change and every owner is asked to accept again on next log-in.

**Merchant of record:** because HitchPoint now processes every payment, have your lawyer confirm the money transmission, sales tax (marketplace facilitator) and 1099-K position for the states you serve. Stripe Connect is designed for this model, but the analysis is yours.

---

## Business owners

- **Business:** name, phone, service area, colors, logo and photo, website text, own domain, team members, and the snippet to connect an existing website’s form.
- **Products:** prices for quotes; “Show on website” lists one on the site; “Customers can book it” makes a fixed-price package bookable from the form.
- **Settings:** direct deposit status and bank details (through Stripe), recent payouts with the Processing Fee on each, the deposit name and amount, default tax and terms, change password.
- **Sign-up:** create the account, accept the agreements, then set up direct deposit with Stripe (required before the dashboard opens).

### Connect an existing website (like Mike’s GitHub Pages site)

Add to the page `<head>`:

```html
<meta name="rsqu-api" content="https://<BASE_URL>">
<meta name="rsqu-business" content="<business-slug>">
```

and include `forms.js` from the repo root. Until both are set, the forms open a pre-filled text message instead.

### Mike’s business

```bash
DATA_DIR=/data BASE_URL=https://<BASE_URL> node scripts/seed-mike.js mike@hisemail.com
```

creates his business with his brand, photo, service area, the $499 winterizing package, the $129 diagnosis deposit, and prints a setup link for him. (Or let him sign up and enter these himself.)

## Backups

Back up `DATA_DIR` (`rsqu.db` and `uploads/`).
