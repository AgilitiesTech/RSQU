# Mike’s Dashboard (RSQU admin)

The back office for Mike Stevens Emergency RV & Trailer Repair. Mike uses it on his phone to:

1. **Get requests** from the website’s repair form and $499 winterizing booking form, with photo, GPS location and one-tap call, text and map. A new request can also send him a text alert.
2. **Take the $129 diagnosis deposit** by card link (hand over the phone or text the link), cash or check. A paid deposit is credited automatically on the job’s quote.
3. **Build a quote onsite** from his products list plus custom lines, with quantities, optional sales tax, notes and terms.
4. **Show the proposal** to the customer, who reviews it and **signs with a finger** on the spot (name, signature image, time, IP and device are recorded).
5. **Collect payment** by card or bank (ACH) through Stripe Checkout, or record cash or check.
6. **Manage products** and default settings (deposit amount, tax rate, terms).

No outside packages: plain Node.js 22.13+ with the built-in SQLite. The database and photos live in `DATA_DIR`.

## Run it locally

```bash
cd admin
ADMIN_PASSWORD=test node --no-warnings server.js
# open http://localhost:3000
npm test        # end-to-end test of the request → deposit → quote → sign → pay flow (fake Stripe)
```

## Deploy

It needs a small always-on server with a persistent disk (the database is a single file).

- **Render:** New → Blueprint → this repo. `render.yaml` (repo root) sets up the service and a 1 GB disk (Starter plan). Fill in the secret settings it asks for.
- **Anywhere with Docker** (Fly.io, Railway, a VPS): build `admin/Dockerfile` and mount a volume at `/data`.

Settings are listed in `.env.example`. At minimum set `ADMIN_PASSWORD`, `BASE_URL` and `ALLOWED_ORIGINS`.

### Connect the website

In `index.html` and `winterize.html` at the repo root, set:

```html
<meta name="rsqu-api" content="https://YOUR-DASHBOARD-ADDRESS">
```

and add the website’s address to `ALLOWED_ORIGINS`. Until that’s set, or if the dashboard can’t be reached, the website forms open a pre-filled text message to Mike instead, so no request is lost.

### Payments (Stripe)

1. Create (or log in to) Mike’s Stripe account and finish business verification.
2. Developers → API keys: put the secret key in `STRIPE_SECRET_KEY` (start with `sk_test_...`).
3. Developers → Webhooks → add endpoint `https://YOUR-DASHBOARD-ADDRESS/api/stripe/webhook` with events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Settings → Payment methods: turn on **ACH Direct Debit** to let customers pay big jobs from their bank for a much lower fee than cards. Checkout shows whatever methods are turned on there.

Card payments are confirmed when the customer returns from checkout; the webhook is the backup and is required for bank payments, which take a few days to clear.

**Stripe Connect (optional, for Agilities):** if Mike’s account is connected to an Agilities platform account, use the platform’s secret key, set `STRIPE_CONNECT_ACCOUNT_ID=acct_...`, and optionally `STRIPE_APPLICATION_FEE_BP` (basis points, e.g. `100` = 1%). Charges go to Mike’s account; any platform fee goes to Agilities.

### Text alerts (optional, Twilio)

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and `NOTIFY_SMS_TO` to text Mike for every new request, signature and payment. Without them, the dashboard still shows new requests (it checks every 30 seconds and can show a browser notification).

### Backups

Back up `DATA_DIR` (the `rsqu.db` file and `uploads/` folder). Customer photos and signatures are only visible to a logged-in admin, except that a customer sees their own signature on their proposal link.
