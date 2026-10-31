import crypto from 'node:crypto';

// Minimal Stripe client using the REST API directly (no SDK dependency).
// Works with Mike's own Stripe account (STRIPE_SECRET_KEY), or with a platform
// key plus STRIPE_CONNECT_ACCOUNT_ID when Mike's account is connected to an
// Agilities platform account (Stripe Connect, direct charges).
export function stripeClient(env) {
  const key = env.STRIPE_SECRET_KEY;
  const base = env.STRIPE_API_BASE || 'https://api.stripe.com';
  const account = env.STRIPE_CONNECT_ACCOUNT_ID || '';
  const feeBp = Number(env.STRIPE_APPLICATION_FEE_BP || 0); // platform fee, basis points

  function form(obj, prefix = '', out = new URLSearchParams()) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      const name = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === 'object') form(v, name, out);
      else out.append(name, String(v));
    }
    return out;
  }

  async function call(method, pathname, body) {
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
    connected: Boolean(account),

    createCheckout({ amountCents, name, description, successUrl, cancelUrl, ref, email }) {
      const fee = account && feeBp ? Math.round((amountCents * feeBp) / 10000) : undefined;
      return call('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: ref,
        customer_email: email || undefined,
        line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name, description: description || undefined } } } },
        metadata: { payment_token: ref },
        payment_intent_data: { description: name, metadata: { payment_token: ref }, application_fee_amount: fee },
      });
    },

    retrieveCheckout(id) {
      return call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
    },
  };
}

// Verifies a Stripe webhook signature header against the raw body.
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
