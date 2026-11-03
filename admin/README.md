# HitchPoint (RSQU admin)

**HitchPoint** (a d/b/a of Agilities) is a white-label back office for mobile RV and trailer repair businesses. The marketing site for recruiting owners is served at `/` (point the HitchPoint domain at this app). The first business on it is Mike Stevens Emergency RV & Trailer Repair.

**Each business gets:** sign-up and log-in, its own brand (name, colors, logo, photo), a hosted website with a request form (`/s/<business>` or its own domain), a request inbox with photo, GPS, call/text/map, an optional up-front deposit (Mike: $129, credited toward the job), onsite quotes from its products list, a branded proposal the customer signs with a finger, its own customer Terms & Conditions (generated from a template, approved by the owner), online card and bank payments straight into **its own Stripe account** (the business is the seller and merchant of record), cash/check recording, team members, and text alerts. Also a schedule with appointment confirmations, reminders and “On my way” texts, quick invoices without a signature, Google review requests, update emails to subscribers, a QuickBooks download, and a dashboard that installs on a phone.

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
4. Connect → Settings → **Payment methods**: allow **ACH Direct Debit** for connected accounts (new business accounts request it; set `STRIPE_ACH_PAYMENTS=off` to stop). Also allow **Affirm** and **Klarna**, so businesses can offer pay over time. Checkout never sets `payment_method_types`, so each business’s own Stripe settings decide what customers see.
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

- **Texts** (Twilio): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Used for owner alerts and customer texts (receipts, appointment confirmations and reminders, “On my way”, review requests for customers who agreed to texts). Each business enters the number to alert on its Business page. Point the Twilio number’s “A message comes in” webhook at `https://<BASE_URL>/api/twilio/inbound`: STOP replies are recorded for every number (no more texts of any kind to it) and START or UNSTOP lifts that.
- **Email** (Resend): `RESEND_API_KEY`, `EMAIL_FROM`. Password resets, receipts, appointment emails, review requests and update emails. Without it, send reset links by hand from the business page.

### 4a. Background sender

Messages that go out later (appointment confirmations and reminders, review requests, update emails) sit in the `scheduled_messages` table. A timer inside the app sends what’s due every 30 seconds (`WORKER_INTERVAL_MS` changes that; `DISABLE_WORKER=1` turns it off, which the tests do and drive it with `runDueMessages(now)` instead).

- Each message is claimed with one `UPDATE … WHERE status = 'pending'`, so it goes out once, even with more than one copy of the app running.
- Texts only go out 8am to 8pm in the business’s time zone (Business page). Outside those hours they wait for 8am. The time is checked right before each text, so a long batch never runs past 8pm.
- The wording, the appointment and the customer’s consent are checked when the message is sent, so a moved appointment, an unsubscribe or a STOP always wins.
- Update emails go out in batches of 50 per run.
- A suspended business sends nothing: its queued messages are canceled (“business suspended”).
- STOP replies recorded before `sms_stops` existed (in `consent_log`) are copied into it once when the app starts. Receipts skip the text (not the email) to a number that replied STOP.
- A message that was being sent when the app stopped stays marked “sending” and isn’t retried, so nobody gets it twice.

### 5. Custom domains

A business can serve its hosted site from its own domain: it adds a CNAME pointing at the dashboard host and enters the domain on its Business page. Your host must also accept the domain and issue TLS for it (on Render: Settings → Custom Domains).

### 6. Legal

**Platform documents** (between HitchPoint and businesses) are in `public/legal/` and served at `/legal/terms`, `/legal/privacy`, `/legal/payment-terms` and `/legal/customer-terms` (a short payment and e-signature notice for customers). Company details (Agilities Tech, LLC; Utah law; Morgan County venue) are filled in. **Have a lawyer review them**; launch is on these drafts. Acceptance is recorded with version `2026-11-02.3` (`AGREEMENT_VERSION` in `src/db.js`); bump it when the documents change and every owner is asked to accept again on next log-in.

**Customer Terms & Conditions** (between each business and its customers): the master template is `templates/customer-terms.md` (plain Markdown with `{{placeholders}}` and `{{#if …}}` blocks, so a lawyer can edit it directly). Each owner fills in a one-time **Business details** form (legal name, address, license, insurance, sales tax rate, payment and service policies), reviews the generated draft at **Settings → Customer Terms & Conditions**, may edit the wording, and gives **final approval**: typed name and title plus three statements (authority to bind the business, reviewed with the chance to consult an attorney, and that the business is the seller and merchant of record responsible for its terms, refunds, disputes and sales tax). Only the owner can approve; Agilities admins viewing the account can’t. Each approval is stored as an immutable version (`customer_terms` table: wording, SHA-256, approver, attestation, time, IP). Customers accept the current version when they sign a proposal (recorded on the quote) or pay online (recorded on the payment and in Stripe metadata), and can read it at `/s/<business>/terms` (or `/terms` on the business’s own domain; `?v=N` for earlier versions). After editing the template, bump `TEMPLATE_VERSION` in `src/customer-terms.js`; owners are asked to re-approve, and customers keep the last approved version until they do.

### 7. Affiliates (referral revenue share)

Agilities pays an affiliate a share of HitchPoint’s **net platform fee** (the 3% actually collected, minus any part returned on refunds) on card payments from businesses it referred. Every affiliate is a business on the platform. Code: the `// ---------- affiliates ----------` block in `server.js`, `src/affiliates.js`, and `migrateAffiliates()` in `src/db.js`.

- **Set up (super admin → Affiliates):** pick the business, its share (e.g. 20%), the months each referred business earns it a share (empty = as long as that business stays), and its code (defaults to the business’s web address name, e.g. `mike-stevens`). Pause an affiliate to stop new referrals; businesses it already referred keep earning. Share changes apply to payments from then on (`affiliate_rates` keeps the history).
- **The owner** sees a “Refer businesses, earn a share” card on the Business page and accepts the **Affiliate Program Terms** (`/legal/affiliate-terms`, version `AFFILIATE_TERMS_VERSION` in `src/affiliates.js`) before the link works. Their page (`#/affiliate`) shows the link, clicks, referred businesses (names, status and earnings only, never payment volume), pending / available / paid totals, and their earnings from each business added up by month (never single payments or HitchPoint’s fee rate), plus payouts and adjustments, with a CSV. Super admins see every ledger row.
- **Credit:** `GET /a/<code>` counts the click (daily totals, plus a keyed IP hash kept one day for unique visitors; no raw IPs) and sets the `hp_ref` cookie for 90 days, first click wins, then redirects to the landing page. The sign-up form has a “Referral code” box filled in from the cookie or `?ref=`. A typed code wins over the cookie; an affiliate can’t use its own code (matched on the owner email or phone). Super admins can set or change the referrer on a business’s page (“Count payments from” a date) or enter a code when adding a business.
- **Earnings:** `syncAffiliateLedger(paymentId)` runs when a direct payment settles, on the checkout webhook, and when HitchPoint’s fee is returned on a refund. It adds an `earning`, or a negative `reversal`, for the difference from what the ledger already has for that payment, so it’s safe to repeat. Earnings are pending for 30 days after the payment, then available. Cash, check and legacy payments earn nothing.
- **Payouts (by hand):** pay the affiliate by ACH, check or Stripe, then **Record payout** on their page. It needs a W-9 on file, accepted terms and at least $25.00 available, and marks those ledger rows paid. The form sends the amount it showed; if the balance changed since, it asks you to reload and check. Ledger rows only move forward (pending → available → paid), and a payout on a row never changes. **Download payouts for 1099s** gives each affiliate’s total paid for a year.

---

## Business owners

- **Business:** name, phone, service area, colors, logo and photo, website text, own domain, team members, and the snippet to connect an existing website’s form.
- **Website sections and Google search** (`#/website`, from the Business page): base city and travel radius, up to 20 cities served (each gets a page at `/areas/<city-st>`), hours, certifications, FAQs, YouTube videos, Google Business Profile / review / social links, the Google Search Console verification tag, and downloadable PDFs (checklists, guides; up to 20, 10 MB each). A checklist shows what's still missing for local search.
  - The site publishes schema.org markup (`AutoRepair` with service areas, hours, credentials and services; `FAQPage`; `Service` and breadcrumbs on city pages), canonical URLs (the business's own domain when it has one) and Open Graph tags.
  - City pages are offered to search engines (`index`, and listed in the sitemap) only once the owner writes at least 120 characters about that city, so they aren't near-duplicate doorway pages. Until then they're `noindex`.
  - Sitemaps: a business on its own domain gets `/sitemap.xml` and `/robots.txt` there; businesses hosted at `/s/<slug>` are listed in the platform sitemap.
  - Videos show a preview image and load YouTube's privacy-enhanced player only when a visitor presses play; the site's Content-Security-Policy allows just `i.ytimg.com` and `www.youtube-nocookie.com` for this.
- **Site looks:** under Website sections → Look. **Classic** (light) or **Bold** (dark menu bar, a full-width banner picture with an optional phone crop, service tiles from products that have a tile picture, a highlights bar of up to 4 items, and the request form on dark).
  - Products can also have an order on the website and a write-up. A product with a write-up that's shown on the website gets its own page at `/services/<name>`, with `Service` markup, and is listed in the sitemap.
  - `node scripts/apply-rsqu-site.js [slug]` moves Mike's RSQU Mobile RV Service site onto his hosted site in the Bold look, using the files in `seed/rsqu/`. It's safe to re-run.
- **Quote from photos** (Quotes → From photos, or on a request): take up to 4 photos and add a note. With `ANTHROPIC_API_KEY` set, Claude drafts the proposal:
  - The title, a plain-language summary for the customer, and lines from the business's own price list.
  - Anything not on the price list comes in at $0, flagged "Set a price". Labor uses the hourly rate from Customer Terms details.
  - Notes for the technician only: what the photos show, safety concerns, and what to confirm.
  - The technician edits everything before sending and chooses which photos appear on the proposal. Without a key, the photos are kept and the technician fills in the lines.
- **Receipts and subscribers:**
  - When customers sign, they confirm their phone and email for the receipt. They can keep "email me updates and offers" on (one-click unsubscribe in every email) and opt in to texts. The texts box is unchecked, with STOP/HELP wording.
  - The exact wording, time, IP and proposal are stored with each consent.
  - After any payment (card, cash or check), the customer gets a receipt link (`/r/<token>`) by text and email, once.
  - Quotes → Customers lists everyone and what they agreed to, with a CSV download. Email unsubscribe is at `/u/<token>`: GET asks, POST unsubscribes, including mail apps' one-click.
- **Products:** prices for quotes; “Show on website” lists one on the site; “Customers can book it” makes a fixed-price package bookable from the form. On phones the menu has five items (Requests, Schedule, Quotes, Business, Settings), so Products is a card on the Business page.
- **Time zone** (Business page; Mountain by default): receipt dates, reminders, texting hours and the QuickBooks download use it.
- **Schedule** (`#/schedule`): day and week lists with today highlighted. Book from scratch or with “Schedule this job” on a request or quote. Pick who’s going.
  - The customer gets a confirmation email and text right away and a reminder the day before at 9am. If the time changes, they get the new time and the old reminder is dropped. These are appointment messages for a job the customer asked for, so they don’t need the offers opt-in, but they never go to a number that replied STOP. Every message has the business phone. The owner can uncheck the box to book without messaging.
  - “On my way” texts the customer “{business} is on the way, about N minutes” right away, only between 8am and 8pm.
  - Each person gets a private calendar link (`/cal/<token>.ics`) for Google or Apple Calendar: owners see every appointment, team members see theirs. “Make a new link” turns the old one off.
- **Quick invoices** (Quotes → New invoice): bill for work without a proposal to sign. The customer page says “Invoice” with a Pay button; paying accepts the business’s current Terms & Conditions, recorded on the payment and in Stripe like the deposit page. Cash, check, tax, deposits and receipts work the same. A customer who opens the payment page twice gets the same Stripe Checkout. When the owner changes, voids or records cash on a quote or invoice, any Checkout the customer still has open is closed first (if they are mid-payment, the owner is asked to refresh in a minute). A payment that doesn’t match what’s owed (after a void, a second payment, too much or too little) is kept with a note on the quote, the quote is marked paid only once what’s owed is covered, and the owner gets a text and an email.
- **Google review requests** (Settings): with a Google review link on the Website page, receipts for paid work show “Happy with the work? Leave us a Google review.” A follow-up goes out a set time after payment (1 day by default): by email to customers who agreed to emails, by text only to customers who agreed to texts, never after an unsubscribe or STOP, and at most once per customer every 90 days. Review emails carry the business name and mailing address like update emails, so they are skipped until that address is filled in. The owner can turn it off and edit the message.
- **Email subscribers** (Quotes → Customers → Email subscribers, owners only): a subject and plain-text message to customers who agreed to email updates, with a test to yourself first. Every email has the business name, its mailing address from Customer Terms details (required before sending), and a one-click unsubscribe link with `List-Unsubscribe` headers. One per business per 24 hours; the `campaigns` table keeps the log and counts. Texts to subscribers aren’t offered: state texting laws and carrier registration come first.
- **Pay over time** (Settings → Payments): steps to turn on Affirm and Klarna in the business’s Stripe Dashboard. Once the owner checks “I turned these on”, proposals and invoices of $50 or more say “Pay over time available at checkout”.
- **Download for QuickBooks** (Settings, owners only): a CSV of paid payments for a date range with Date, Customer, Description, Amount, Method, Processing fees, Net and Reference. A refund made from the Stripe Dashboard (`charge.refunded`) gets its own negative “Refund” row on the refund date; the original row’s Net is the amount less Stripe’s fee and HitchPoint’s fee (less the part of it returned). Every cell is quoted and formula characters are neutralized. A live QuickBooks connection needs Intuit app approval, so it isn’t built.
- **Install on a phone:** the dashboard has a web app manifest and a service worker (`/admin/sw.js`) that keeps the app shell and shows an offline page. It never stores `/api/` responses. Phones see a dismissible “Add HitchPoint to your home screen” tip on Requests.
- **Settings:** customer Terms & Conditions status, their own Stripe account (opens the Stripe Dashboard for refunds, disputes and payouts), pay over time, recent online payments with the Processing Fee on each, the deposit name and amount, default tax and job notes, review requests, the QuickBooks download, change password.
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
