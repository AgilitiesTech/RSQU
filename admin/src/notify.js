// Optional text-message alerts to Mike through Twilio. Silently does nothing
// when Twilio isn't configured, so the app works without it.
export function notifier(env, log = console) {
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM, to = env.NOTIFY_SMS_TO;
  const enabled = Boolean(sid && token && from && to);
  return {
    enabled,
    async sms(body) {
      if (!enabled) return;
      try {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ From: from, To: to, Body: body.slice(0, 1500) }).toString(),
        });
        if (!res.ok) log.error('SMS alert failed', res.status, await res.text());
      } catch (e) {
        log.error('SMS alert failed', e.message);
      }
    },
  };
}
