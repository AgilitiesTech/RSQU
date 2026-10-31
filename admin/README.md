# Service platform (RSQU admin)

A white-label back office for mobile service businesses, run by Agilities. The first business on it is Mike Stevens Emergency RV & Trailer Repair.

**Each business gets:** sign-up and log-in, its own brand (name, colors, logo, photo), a hosted website with a request form (`/s/<business>` or its own domain), a request inbox with photo, GPS, call/text/map, an optional up-front deposit (Mike: $129, credited toward the job), onsite quotes from its products list, a branded proposal the customer signs with a finger, online card and bank payments through its own Stripe account, cash/check recording, team members, and text alerts.

**Agilities gets:** a super admin dashboard over every business, a 3% **Processing Fee** on every online payment (collected automatically into the Agilities Stripe account), per-business fee overrides, suspend/restore, “open their dashboard” access, password reset links, agreement records, and a CSV of all Processing Fees.

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

Required settings (see `.env.example`): `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `BASE_URL` (the dashboard’s public address). The super admin account is created on first start; change the password afterwards from Settings, and you can then remove `SUPER_ADMIN_PASSWORD`.

### 2. Set up Stripe Connect (once, on the Agilities Stripe account)

1. Stripe Dashboard → **Connect** → Get started → choose **Platform**. Allow **Standard** connected accounts.
2. Connect → Settings → **Branding**: add the Agilities name, icon and color. Business owners see this during Stripe onboarding.
3. Developers → **API keys**: put the secret key in `STRIPE_SECRET_KEY` (use `sk_test_…` first).
4. Developers → **Webhooks** → Add endpoint `https://<BASE_URL>/api/stripe/webhook`, choose **Events on Connected accounts**, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `account.updated`. Put its signing secret in `STRIPE_CONNECT_WEBHOOK_SECRET`.
5. Optional: each business can turn on **ACH Direct Debit** in its own Stripe settings for cheaper bank payments.

Processing Fees arrive in the Agilities Stripe balance as **Collected fees** (Connect → Collected fees) and pay out to the Agilities bank account on your normal payout schedule.

### 3. Manage businesses

Log in at `https://<BASE_URL>/admin` with the super admin email. You land on **Businesses**:

- **Totals:** Processing Fees this month and all time, online payment volume, active businesses. **Download Processing Fees (CSV)** for bookkeeping.
- **Add a business:** enter the business and owner email. You get a setup link (valid 7 days) to send the owner. They set a password and accept the agreements on first log-in. Owners can also sign themselves up at `https://<BASE_URL>/signup`.
- **Open a business** to:
  - **Open their dashboard:** work inside their account exactly as they see it (a yellow bar shows you are viewing as them; “Back to all businesses” returns you).
  - **Suspend / restore:** a suspended business can’t log in, take requests, or show its website.
  - **Processing Fee:** leave blank for the platform default, or set a custom % and whether it is added to the customer’s total, taken from the business’s payout, or off.
  - **Stripe account ID:** paste an `acct_…` if you connected an existing Stripe account from your Stripe dashboard; otherwise the owner connects from their Settings.
  - **Reset link** for any user, the **agreements log** (document, version, time, IP), and their **payments** with Processing Fees.
- **Platform** tab: the default Processing Fee (3%) and mode (added to the customer’s total by default), and service status.

Customers and businesses only ever see the fee as **Processing Fee**. Customers see their business’s brand, not Agilities.

### 4. Optional services

- **Text alerts** (Twilio): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Each business enters the number to alert on its Business page.
- **Password reset emails** (Resend): `RESEND_API_KEY`, `EMAIL_FROM`. Without it, send reset links by hand from the business page.

### 5. Custom domains

A business can serve its hosted site from its own domain: it adds a CNAME pointing at the dashboard host and enters the domain on its Business page. Your host must also accept the domain and issue TLS for it (on Render: Settings → Custom Domains).

### 6. Legal

Drafts are in `public/legal/` and served at `/legal/terms`, `/legal/privacy`, `/legal/payment-terms` and `/legal/customer-terms`. Fill in the bracketed placeholders and **have a lawyer review them before launch**, especially the Processing Fee rules (see below). Agreement acceptance is recorded with version `2026-11-01` (`AGREEMENT_VERSION` in `src/db.js`); bump it when the documents change and every owner is asked to accept again on next log-in.

**Processing Fee compliance:** a fee added to a customer’s card payment is a surcharge under card network rules. In the US it generally must be disclosed before payment (the app does this), is capped (3% under current Visa rules), can’t be applied to debit or prepaid cards, and is restricted in some states. Stripe Checkout can’t vary the fee by card type, so get legal advice; the safer settings are “taken from the business’s payout” or applying it only where allowed.

---

## Business owners

- **Business:** name, phone, service area, colors, logo and photo, website text, own domain, team members, and the snippet to connect an existing website’s form.
- **Products:** prices for quotes; “Show on website” lists one on the site; “Customers can book it” makes a fixed-price package bookable from the form.
- **Settings:** connect Stripe, the deposit name and amount, default tax and terms, change password.

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
