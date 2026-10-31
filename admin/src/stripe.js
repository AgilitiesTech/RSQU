import crypto from 'node:crypto';

// Minimal Stripe client using the REST API directly (no SDK dependency).
// Model: every online payment is charged on the platform's own Stripe account
// (the platform is the merchant of record and pays Stripe's fee). After the
// payment succeeds, the platform transfers the business's share to the
// business's Stripe Express account, and Stripe pays it out to their bank.
export function stripeClient(env) {
  const key = env.STRIPE_SECRET_KEY;
  const base = env.STRIPE_API_BASE || 'https://api.stripe.com';

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

  async function call(method, pathname, body, { idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${key}` };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetch(base + pathname, { method, headers, body: body ? form(body).toString() : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`);
    return json;
  }

  // Card statements show the platform descriptor plus this suffix (max 22 chars, no special characters).
  const suffix = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 22).trim() || undefined;

  return {
    enabled: Boolean(key),
    testMode: String(key || '').includes('_test_'),

    // Express account: Stripe collects identity and the bank account for direct deposit.
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
    getAccount(id) {
      return call('GET', `/v1/accounts/${encodeURIComponent(id)}`);
    },

    createCheckout({ name, amountCents, successUrl, cancelUrl, ref, email, statementName }) {
      return call('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: ref,
        customer_email: email || undefined,
        line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name } } } },
        metadata: { payment_token: ref },
        payment_intent_data: { description: name, statement_descriptor_suffix: suffix(statementName), transfer_group: ref, metadata: { payment_token: ref } },
      });
    },
    // Session with the charge and its balance transaction (Stripe's actual fee).
    retrieveCheckout(id) {
      return call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent.latest_charge.balance_transaction`);
    },
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
