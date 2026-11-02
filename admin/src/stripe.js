import crypto from 'node:crypto';

// Minimal Stripe client using the REST API directly (no SDK dependency).
//
// Model (current): each business has its OWN Stripe account (Accounts v2 with the merchant
// configuration and the full Stripe Dashboard). Customers pay that account directly ("direct
// charges"), so the BUSINESS is the merchant of record: its name is on the customer's statement,
// and it owns refunds, disputes and sales tax. Stripe bills its processing fee to the business,
// and the platform collects its share as an application fee on each payment.
//
// Legacy model (kept only so payments taken before the switch can finish paying out): the
// platform charged on its own account and transferred the business's share to an Express account.
export function stripeClient(env) {
  const key = env.STRIPE_SECRET_KEY;
  const base = env.STRIPE_API_BASE || 'https://api.stripe.com';
  // API v2 requires an explicit version. This is the version stripe-node v23 pins.
  const v2Version = env.STRIPE_API_VERSION || '2026-10-28.endive';
  // ACH Direct Debit on businesses' accounts (cheaper for customers). Set STRIPE_ACH_PAYMENTS=off to skip.
  const requestAch = String(env.STRIPE_ACH_PAYMENTS || 'on').toLowerCase() !== 'off';

  function form(obj, prefix = '', out = new URLSearchParams()) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      const name = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${name}[${i}]`, out) : out.append(`${name}[]`, String(x))));
      else if (typeof v === 'object') form(v, name, out);
      else out.append(name, String(v));
    }
    return out;
  }

  // `account` sends the request on behalf of a business's own Stripe account (Stripe-Account header).
  async function call(method, pathname, body, { idempotencyKey, account } = {}) {
    const headers = { Authorization: `Bearer ${key}` };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (account) headers['Stripe-Account'] = account;
    const res = await fetch(base + pathname, { method, headers, body: body ? form(body).toString() : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`);
    return json;
  }

  // API v2: JSON bodies, explicit version, arrays in queries as include[0]=…&include[1]=…
  async function callV2(method, pathname, body, query) {
    const headers = { Authorization: `Bearer ${key}`, 'Stripe-Version': v2Version };
    if (body) headers['Content-Type'] = 'application/json';
    const qs = query ? '?' + Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x, i) => `${k}[${i}]=${encodeURIComponent(x)}`) : [`${k}=${encodeURIComponent(v)}`])).join('&') : '';
    const res = await fetch(base + pathname + qs, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`);
    return json;
  }

  // Card statements show the account's descriptor plus this suffix (max 22 chars, no special characters).
  const suffix = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 22).trim() || undefined;

  return {
    enabled: Boolean(key),
    testMode: String(key || '').includes('_test_'),

    // The business's own Stripe account (Accounts v2). Responsibilities:
    //  - fees_collector 'stripe': Stripe bills its processing fee to the business directly.
    //  - losses_collector 'stripe': Stripe, not the platform, is liable for negative balances
    //    (refunds and disputes come out of the business's balance, as merchant of record).
    //  - dashboard 'full': the business manages refunds, disputes and payouts itself.
    // Never pass a top-level `type` on v2 accounts.
    createMerchantAccount({ email, businessName, tenantId }) {
      const capabilities = { card_payments: { requested: true } };
      if (requestAch) capabilities.ach_debit_payments = { requested: true };
      return callV2('POST', '/v2/core/accounts', {
        display_name: businessName,
        contact_email: email,
        identity: { country: 'us' },
        dashboard: 'full',
        defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
        configuration: { merchant: { mcc: '7538', capabilities } },
        metadata: { tenant_id: String(tenantId) },
      });
    },
    // Hosted onboarding for the v2 account. (API 2026-09-30+ no longer accepts `configurations`
    // here; Stripe collects what the account's configurations need.)
    merchantAccountLink({ account, refreshUrl, returnUrl }) {
      return callV2('POST', '/v2/core/account_links', {
        account,
        use_case: { type: 'account_onboarding', account_onboarding: { refresh_url: refreshUrl, return_url: returnUrl } },
      });
    },
    // Live status. Card payments come from the v2 merchant configuration; whether the owner has
    // finished onboarding comes from v1 `details_submitted`, which Stripe documents for v1 and v2
    // accounts and which doesn't flip back when a new requirement appears later.
    async merchantStatus(id) {
      const [a, v1] = await Promise.all([
        callV2('GET', `/v2/core/accounts/${encodeURIComponent(id)}`, null, { include: ['configuration.merchant', 'requirements'] }),
        call('GET', `/v1/accounts/${encodeURIComponent(id)}`),
      ]);
      const cardStatus = a?.configuration?.merchant?.capabilities?.card_payments?.status || 'inactive';
      return { id: a.id, chargesEnabled: cardStatus === 'active', detailsSubmitted: Boolean(v1?.details_submitted), cardStatus };
    },
    // Return the platform's application fee (all or part) to the business, e.g. after a refund.
    // Application fees live on the platform account, so no Stripe-Account header.
    getApplicationFee(id) {
      return call('GET', `/v1/application_fees/${encodeURIComponent(id)}`);
    },
    refundApplicationFee(id, amountCents, idempotencyKey) {
      return call('POST', `/v1/application_fees/${encodeURIComponent(id)}/refunds`, { amount: amountCents }, { idempotencyKey });
    },

    // LEGACY: Express payout account (platform-as-merchant model). Not used for new accounts.
    createAccount({ email, businessName, tenantId }) {
      return call('POST', '/v1/accounts', {
        type: 'express', country: 'US', email,
        capabilities: { transfers: { requested: true } },
        business_profile: { name: businessName, mcc: '7538' },
        metadata: { tenant_id: tenantId },
      });
    },
    accountLink({ account, refreshUrl, returnUrl }) {
      return call('POST', '/v1/account_links', { account, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
    },
    loginLink(account) {
      return call('POST', `/v1/accounts/${encodeURIComponent(account)}/login_links`, {});
    },
    // The platform's own Stripe account (used to confirm the API key works).
    platformAccount() {
      return call('GET', '/v1/account');
    },
    getAccount(id) {
      return call('GET', `/v1/accounts/${encodeURIComponent(id)}`);
    },

    // Direct charge: the Checkout Session is created ON the business's account (Stripe-Account),
    // so the business is the merchant of record and Checkout shows its branding. The platform's
    // share is collected as an application fee.
    createCheckout({ account, name, amountCents, applicationFeeCents, successUrl, cancelUrl, ref, email, statementName, metadata = {} }) {
      return call('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: ref,
        customer_email: email || undefined,
        line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name } } } },
        metadata: { payment_token: ref, ...metadata },
        payment_intent_data: {
          description: name,
          application_fee_amount: applicationFeeCents,
          statement_descriptor_suffix: suffix(statementName),
          metadata: { payment_token: ref, ...metadata },
        },
      }, { account });
    },
    // Session with the charge and its balance transaction (Stripe's actual fee). Pass `account`
    // for direct charges; omit it for legacy platform charges.
    retrieveCheckout(id, account) {
      return call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent.latest_charge.balance_transaction`, null, { account });
    },
    // LEGACY: pays out a platform charge taken under the old model.
    createTransfer({ amountCents, destination, sourceTransaction, group, ref }) {
      return call('POST', '/v1/transfers', {
        amount: amountCents, currency: 'usd', destination, source_transaction: sourceTransaction, transfer_group: group, metadata: { payment_token: ref },
      }, { idempotencyKey: `transfer-${ref}` });
    },
  };
}

// Verifies a Stripe webhook signature header against the raw body for any of the given secrets.
export function verifyStripeSignature(rawBody, header, secrets, toleranceSec = 300) {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  if (!header || !list.length) return false;
  const t = Number((/(?:^|,)t=(\d+)/.exec(header) || [])[1]);
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  return list.some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  });
}
