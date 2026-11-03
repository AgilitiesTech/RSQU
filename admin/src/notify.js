// Optional text alerts (Twilio) and email (Resend). Both silently do nothing when
// not configured, so the app works without them.
// With NOTIFY_CAPTURE set (tests), messages are recorded in `outbox` instead of being sent.
export function notifier(env, log = console) {
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN, from = env.TWILIO_FROM;
  const capture = Boolean(env.NOTIFY_CAPTURE);
  const outbox = [];
  const smsEnabled = capture || Boolean(sid && token && from);
  const emailEnabled = capture || Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  return {
    smsEnabled, emailEnabled, outbox,
    async sms(to, body) {
      if (!smsEnabled || !to) return;
      if (capture) { outbox.push({ kind: 'sms', to, body }); return; }
      try {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: from, To: to, Body: body.slice(0, 1500) }).toString(),
        });
        if (!res.ok) log.error('SMS failed', res.status, await res.text());
      } catch (e) { log.error('SMS failed', e.message); }
    },
    // opts.replyTo: where customer replies go (the business); opts.headers: e.g. List-Unsubscribe.
    async email(to, subject, text, opts = {}) {
      if (!emailEnabled || !to) return false;
      if (capture) { outbox.push({ kind: 'email', to, subject, text, ...opts }); return true; }
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: opts.fromName ? `"${opts.fromName.replace(/["\\\r\n<>]/g, '')}" <${String(env.EMAIL_FROM).replace(/^.*<|>.*$/g, '')}>` : env.EMAIL_FROM, to, subject, text, ...(opts.replyTo ? { reply_to: opts.replyTo } : {}), ...(opts.headers ? { headers: opts.headers } : {}) }),
        });
        if (!res.ok) { log.error('Email failed', res.status, await res.text()); return false; }
        return true;
      } catch (e) { log.error('Email failed', e.message); return false; }
    },
  };
}
