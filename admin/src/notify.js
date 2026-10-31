// Optional text alerts (Twilio) and email (Resend). Both silently do nothing when
// not configured, so the app works without them.
export function notifier(env, log = console) {
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN, from = env.TWILIO_FROM;
  const smsEnabled = Boolean(sid && token && from);
  const emailEnabled = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  return {
    smsEnabled, emailEnabled,
    async sms(to, body) {
      if (!smsEnabled || !to) return;
      try {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: from, To: to, Body: body.slice(0, 1500) }).toString(),
        });
        if (!res.ok) log.error('SMS failed', res.status, await res.text());
      } catch (e) { log.error('SMS failed', e.message); }
    },
    async email(to, subject, text) {
      if (!emailEnabled || !to) return false;
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
        });
        if (!res.ok) { log.error('Email failed', res.status, await res.text()); return false; }
        return true;
      } catch (e) { log.error('Email failed', e.message); return false; }
    },
  };
}
