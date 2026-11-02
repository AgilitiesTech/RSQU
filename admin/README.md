# HitchPoint (RSQU admin)

**HitchPoint** (a d/b/a of Agilities) is a white-label back office for mobile RV and trailer repair businesses. The marketing site for recruiting owners is served at `/` (point the HitchPoint domain at this app). The first business on it is Mike Stevens Emergency RV & Trailer Repair.

**Each business gets:** sign-up and log-in, its own brand (name, colors, logo, photo), a hosted website with a request form (`/s/<business>` or its own domain), a request inbox with photo, GPS, call/text/map, an optional up-front deposit (Mike: $129, credited toward the job), onsite quotes from its products list, a branded proposal the customer signs with a finger, its own customer Terms & Conditions (generated from a template, approved by the owner), online card and bank payments straight into **its own Stripe account** (the business is the seller and merchant of record), cash/check recording, team members, and text alerts.

**Agilities gets:** the HitchPoint landing page with lead capture, a super admin dashboard over every business, and a **3% platform fee** on every online payment, collected by Stripe as an application fee. Stripe bills its own processing fee to the business directly; owners see the two together as one “Processing Fee” (Stripe’s fee + 3%, same as before). Also per-business overrides of the 3%, suspend/restore, “open their dashboard” access, password reset links, agreement records, customer-terms approval records, and a CSV of all Processing Fees.

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

**How money moves (since 2026-11-02.2):** each business has its **own Stripe account** (Stripe Accounts v2, merchant configuration, full Stripe Dashboard). Customers pay that account directly (“direct charges”), so **the business is the seller and merchant of record**: its name is on the customer’s statement, and it handles its own refunds, disputes and sales tax from its Stripe Dashboard. Stripe bills its processing fee to the business; HitchPoint takes its 3% as an **application fee** on each payment. Stripe (not HitchPoint) carries negative-balance liability (`losses_collector: stripe`). HitchPoint never holds or transfers business funds, which removes its merchant-of-record and marketplace-facilitator exposure. Have your attorney confirm the position for the states you serve.

Online payments for a business turn on only when **both** are true: Stripe has enabled card payments on its account, **and** the owner has approved the business’s customer Terms & Conditions.

1. **Connect → Platform setup:** set the platform up as a **Platform** (businesses sell to their own customers; connected accounts get the full Stripe Dashboard; Stripe handles risk and negative balances), and make sure **Accounts v2** is enabled for Connect. Connect → Settings → Branding: HitchPoint name, icon (`public/brand/favicon.svg`) and color `#10243A` (shown during onboarding).
2. Developers → **API keys**: secret key into `STRIPE_SECRET_KEY` (start with `sk_test_…`).
3. Developers → **Webhooks**, both to `https://<BASE_URL>/api/stripe/webhook`:
   - **Connected accounts** events `account.updated`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded` → secret into `STRIPE_CONNECT_WEBHOOK_SECRET`. (Payments now happen on businesses’ accounts, so checkout and refund events arrive here.)
   - **Your account** events `checkout.session.completed`, `checkout.session.async_payment_succeeded` → secret into `STRIPE_WEBHOOK_SECRET`. Only needed while payments taken under the old model are still settling.
4. Connect → Settings → **Payment methods**: allow **ACH Direct Debit** for connected accounts (new business accounts request it; set `STRIPE_ACH_PAYMENTS=off` to stop).
5. **Refunds and the 3%:** businesses refund customers from their own Stripe Dashboard. When the `charge.refunded` event arrives, the app automatically returns the matching share of HitchPoint’s 3% (refunds the application fee proportionally, safe to replay), as the Payment Terms promise. You can see returned fees under Connect → **Collected fees**.

Your 3% builds up in the HitchPoint Stripe balance and pays out to the Agilities bank account on your normal schedule.

**Businesses set up before this change** (Express payout accounts, HitchPoint as merchant of record) are sent through **Connect with Stripe** again at their next log-in and get their own account. Their old payout account is kept (`legacy_stripe_account_id`), and payments taken before the switch still pay out to it automatically.

### 3. Manage businesses

Log in at `https://<BASE_URL>/admin` with the super admin email. You land on **Businesses**:

- **Totals:** your 3% this month and all time, Stripe fees passed through, online volume, payouts to owners, payouts waiting, new leads. **Download Processing Fees (CSV)** for bookkeeping (customer paid, Stripe fee, platform share, payout, transfer IDs).
- **Leads:** owners who filled in “Talk to us” on the landing page (you also get an email at `PLATFORM_CONTACT_EMAIL` if email is set up). Call, text or email them from here and track status.
- **Add a business:** enter the business and owner email. You get a setup link (valid 7 days) to send the owner. They set a password and accept the agreements on first log-in. Owners can also sign themselves up at `https://<BASE_URL>/signup`.
- **Open a business** to:
  - **Open their dashboard:** work inside their account exactly as they see it (a yellow bar shows you are viewing as them; “Back to all businesses” returns you).
  - **Suspend / restore:** a suspended business can’t log in, take requests, or show its website.
  - **Platform share:** leave blank for the default 3%, or set a custom % for this business.
  - **Stripe account:** the business’s own Stripe account (`acct_…`), created when the owner connects Stripe. A “Legacy payouts” tag means they still need to move to their own account.
  - **Payments:** each online payment with Stripe fee, your share and what the business kept (`direct`), with **Retry** to re-read fees for any payment still settling (or a legacy payout that’s waiting).
  - **Reset link** for any user, the **agreements log** (document, version, time, IP), the **customer Terms & Conditions approvals** (version, approver name and title, time, IP) with a link to the public terms page, and their **payments** with Processing Fees.
- **Platform** tab: the default platform share (3%) and service status.

Owners see the Stripe fee + 3% together as **Processing Fee**. Customers pay no fee, see their business’s brand, and their card statement shows the business’s name.

### 4. Optional services

- **Text alerts** (Twilio): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Each business enters the number to alert on its Business page.
- **Password reset emails** (Resend): `RESEND_API_KEY`, `EMAIL_FROM`. Without it, send reset links by hand from the business page.

### 5. Custom domains

A business can serve its hosted site from its own domain: it adds a CNAME pointing at the dashboard host and enters the domain on its Business page. Your host must also accept the domain and issue TLS for it (on Render: Settings → Custom Domains).

### 6. Legal

**Platform documents** (between HitchPoint and businesses) are in `public/legal/` and served at `/legal/terms`, `/legal/privacy`, `/legal/payment-terms` and `/legal/customer-terms` (a short payment and e-signature notice for customers). Fill in the bracketed placeholders and **have a lawyer review them before launch**. Acceptance is recorded with version `2026-11-02.2` (`AGREEMENT_VERSION` in `src/db.js`); bump it when the documents change and every owner is asked to accept again on next log-in.

**Customer Terms & Conditions** (between each business and its customers): the master template is `templates/customer-terms.md` (plain Markdown with `{{placeholders}}` and `{{#if …}}` blocks, so a lawyer can edit it directly). Each owner fills in a one-time **Business details** form (legal name, address, license, insurance, sales tax rate, payment and service policies), reviews the generated draft at **Settings → Customer Terms & Conditions**, may edit the wording, and gives **final approval**: typed name and title plus three statements (authority to bind the business, reviewed with the chance to consult an attorney, and that the business is the seller and merchant of record responsible for its terms, refunds, disputes and sales tax). Only the owner can approve; Agilities admins viewing the account can’t. Each approval is stored as an immutable version (`customer_terms` table: wording, SHA-256, approver, attestation, time, IP). Customers accept the current version when they sign a proposal (recorded on the quote) or pay online (recorded on the payment and in Stripe metadata), and can read it at `/s/<business>/terms` (or `/terms` on the business’s own domain; `?v=N` for earlier versions). After editing the template, bump `TEMPLATE_VERSION` in `src/customer-terms.js`; owners are asked to re-approve, and customers keep the last approved version until they do.

---

## Business owners

- **Business:** name, phone, service area, colors, logo and photo, website text, own domain, team members, and the snippet to connect an existing website’s form.
- **Products:** prices for quotes; “Show on website” lists one on the site; “Customers can book it” makes a fixed-price package bookable from the form.
- **Settings:** customer Terms & Conditions status, their own Stripe account (opens the Stripe Dashboard for refunds, disputes and payouts), recent online payments with the Processing Fee on each, the deposit name and amount, default tax and job notes, change password.
- **Customer Terms & Conditions** (Settings → Review your terms): one-time business details, the generated draft, edits, and the owner’s final approval. Online payments turn on after approval.
- **Sign-up:** create the account, accept the agreements, then connect their own Stripe account (required before the dashboard opens).

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
