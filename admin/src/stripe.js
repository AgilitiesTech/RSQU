import crypto from 'node:crypto';

// Minimal Stripe client using the REST API directly (no SDK dependency).
// STRIPE_SECRET_KEY is the Agilities platform key. Each business connects its own
// Stripe account (Connect, Standard); charges are direct charges on that account
// and the Processing Fee is collected as an application fee.
export function stripeClient(env) {
  const key = env.STRIPE_SECRET_KEY;
  const base = env.STRIPE_API_BASE || 'https://api.stripe.com';

  function form(obj, prefix = '', out = new URLSearchParams()) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      const name = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === 'object') form(v, name, out);
      else out.append(name, String(v));
    }
    return out;
  }

  async function call(method, pathname, body, account) {
    const headers = { Authorization: `Bearer ${key}` };
    if (account) headers['Stripe-Account'] = account;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(base + pathname, { method, headers, body: body ? form(body).toString() : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`);
    return json;
  }

  return {
    enabled: Boolean(key),
    testMode: String(key || '').includes('_test_'),

    createAccount({ email, businessName, tenantId }) {
      return call('POST', '/v1/accounts', { type: 'standard', email, business_profile: { name: businessName }, metadata: { tenant_id: tenantId } });
    },
    accountLink({ account, refreshUrl, returnUrl }) {
      return call('POST', '/v1/account_links', { account, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
    },
    getAccount(id) {
      return call('GET', `/v1/accounts/${encodeURIComponent(id)}`);
    },

    // lines: [{ name, description, amountCents }]; feeCents goes to the platform.
    createCheckout({ account, lines, feeCents, successUrl, cancelUrl, ref, email, statementName }) {
      const line_items = {};
      lines.forEach((l, i) => { line_items[i] = { quantity: 1, price_data: { currency: 'usd', unit_amount: l.amountCents, product_data: { name: l.name, description: l.description || undefined } } }; });
      return call('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: ref,
        customer_email: email || undefined,
        line_items,
        metadata: { payment_token: ref },
        payment_intent_data: {
          description: statementName ? `${statementName}: ${lines[0].name}` : lines[0].name,
          metadata: { payment_token: ref },
          application_fee_amount: feeCents || undefined,
        },
      }, account);
    },
    retrieveCheckout(id, account) {
      return call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`, null, account);
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
