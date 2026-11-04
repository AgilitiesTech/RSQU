# Stripe Checkout: integration notes and remaining steps

This file is the single source of truth for the Stripe Checkout Studio settings applied on 2026-11-04.

HitchPoint already created Checkout Sessions (Scenario A in Stripe's prompt), so only the parameters of that one call changed. No new routes, files or Stripe keys were added.

## Values to Replace

None. Every `sample_only` value in the existing call is already a real value, so nothing was replaced with a placeholder.

**Files containing the Checkout Session call:**
- [admin/src/stripe.js](admin/src/stripe.js) (`createCheckout`)
- [admin/server.js](admin/server.js) (`startCheckout`, which fills in the values below)

| Field | Current value | Notes |
|-------|---------------|-------|
| mode | `payment` | Correct: customers pay a one-time amount (deposit, proposal or invoice balance). |
| success_url | `<site>/pay/<token>` or `<site>/p/<token>`, plus `paid=<token>&session_id={CHECKOUT_SESSION_ID}` | Real HitchPoint pages; keeps the `{CHECKOUT_SESSION_ID}` template. |
| cancel_url | `<site>/pay/<token>` or `<site>/p/<token>` | Returns the customer to the page they came from. |
| line_items | One `price_data` line: the payment's description and amount in USD | HitchPoint prices each job, so there are no Stripe Price IDs (`price_...`) to set. |

## Configured Parameters

These parameters were configured in Checkout Studio and are now sent on every Checkout Session.

**Files containing these parameters:**
- [admin/src/stripe.js](admin/src/stripe.js)

| Parameter | Value |
|-----------|-------|
| ui_mode | `hosted_page` |
| billing_address_collection | `auto` |
| phone_number_collection | `{ enabled: false }` |
| automatic_tax | `{ enabled: false }` |
| allow_promotion_codes | `false` |
| submit_type | `auto` |
| integration_identifier | `hosted_mobile_app_0001` |
| origin_context | `mobile_app` when the HitchPoint phone app starts the payment, otherwise `web` (see below) |

### Where this differs from the generated prompt, and why

- **`origin_context`**: Stripe uses `mobile_app` to switch on its app-to-web purchase flow (an app sending someone to a Stripe-hosted page). HitchPoint's customers pay from proposal and invoice pages in a normal browser, so those sessions send `web`. When the request comes from the HitchPoint app (its user agent contains `HitchPointApp/`), the session sends `mobile_app`. To send `mobile_app` on every session instead, change that one line in `createCheckout`.
- **`payment_method_collection`**: not sent. Stripe only accepts it in `subscription` mode, and every HitchPoint Checkout is `payment` mode.
- **Parameters kept that the prompt said to remove**: `client_reference_id`, `customer_email`, `metadata` and `payment_intent_data` (HitchPoint's application fee, the card-statement suffix, the payment token and the customer-terms version). Removing them would stop HitchPoint collecting its fee, stop webhooks matching a payment to its invoice, and drop the terms record. They stay.
- **`ui_mode` and the Stripe API version**: HitchPoint calls Stripe's REST API directly (no Stripe SDK), and v1 calls send no `Stripe-Version` header, so they use the platform account's default version. That default is `2026-10-28.endive`, and `hosted_page` exists from `2026-03-25.dahlia` on. If the account's default version were ever rolled back before dahlia, Stripe would reject `hosted_page`; use `hosted` in that case.

## Setup and next steps

### Environment variables (Render → HitchPoint-admin → Environment)

No new variables. The existing ones are unchanged:

| Variable | What it holds |
|----------|---------------|
| `STRIPE_SECRET_KEY` | The platform's secret key (`sk_live_...` on gethitchpoint.com). |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | The `whsec_...` signing secret for the webhook that listens to connected accounts. This is how HitchPoint hears that a customer paid. |
| `STRIPE_WEBHOOK_SECRET` | Optional: the signing secret for a webhook on HitchPoint's own account (older payments only). |

Never paste these into chat; they go only in Render.

### Project structure

No new files except this one.

### How the integration works

1. A customer opens a payment, proposal or invoice page and taps Pay.
2. `startCheckout` in `admin/server.js` checks the business can take online payments, then calls `createCheckout`.
3. `createCheckout` creates the Checkout Session on the business's own Stripe account (direct charge, `Stripe-Account` header). The business is the merchant of record; HitchPoint's share is the application fee.
4. The customer pays on Stripe's hosted page and returns to the `success_url`.
5. The `checkout.session.completed` webhook (and the return page) mark the payment paid and record Stripe's fee.

### Testing

On a test copy (a `sk_test_` key), use Stripe's test cards:

| Card | Result |
|------|--------|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0025 0000 3155` | Asks for 3D Secure |
| `4000 0000 0000 9995` | Declined (insufficient funds) |

Any future expiry date, any 3-digit CVC and any ZIP work. Automated tests: `cd admin && npm test`.

On the live site, the real $1 test in the launch checklist (Task 4) is the check: the Checkout page should look the same as before (pay button, no promo-code box, no phone field).

### Next steps

- Products: none to set up. HitchPoint sends each payment's description and amount, not Stripe Price IDs.
- Fulfillment and order tracking: already handled by the webhook and the payment records in HitchPoint.

## Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
