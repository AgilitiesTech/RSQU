'use strict';
(function () {
  const doc = document.getElementById('doc');
  const token = location.pathname.split('/').pop();
  const params = new URLSearchParams(location.search);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  async function load() {
    if (params.get('session_id')) {
      try { await api(`/api/public/payments/${encodeURIComponent(token)}/confirm`, { session_id: params.get('session_id') }); } catch { /* webhook will catch up */ }
      history.replaceState(null, '', location.pathname);
    }
    let p;
    try { p = await api('/api/public/payments/' + encodeURIComponent(token)); }
    catch (e) { doc.innerHTML = `<p class="alert err">${esc(e.message)}</p>`; return; }
    const isDeposit = p.kind === 'deposit';
    doc.innerHTML = `
      <h1>${p.status === 'paid' ? 'Thank you' : 'Payment'}</h1>
      <section class="card stack">
        <h2>${esc(p.description)}</h2>
        <p style="font-family:var(--display);font-size:44px;line-height:1.1">${money(p.amount_cents)}</p>
        ${isDeposit ? '<p>This covers Mike’s diagnosis and onsite review. If you go ahead with the repair, the full amount is credited toward the job.</p>' : ''}
        ${p.status === 'paid' ? '<p class="alert ok">Paid. Mike has been notified.</p>' : p.card_payments ? `
          <button class="btn primary block" id="paybtn" type="button">Pay ${money(p.amount_cents)} by card or bank</button>
          <p class="small muted">You’ll go to Stripe’s secure checkout, then come right back here.</p>` : '<p>Card payments aren’t available yet. Please pay Mike directly.</p>'}
        <p class="alert err" id="perr" hidden></p>
      </section>
      <p class="small muted">Questions? Call or text Mike at <a href="tel:+18012324995">801-232-4995</a>.</p>`;
    const pb = document.getElementById('paybtn');
    if (pb) pb.addEventListener('click', async () => {
      pb.disabled = true; pb.textContent = 'Opening secure checkout…';
      try { const { url } = await api(`/api/public/payments/${encodeURIComponent(token)}/checkout`, {}); location.href = url; }
      catch (e) { const el = document.getElementById('perr'); el.textContent = e.message; el.hidden = false; pb.disabled = false; pb.textContent = `Pay ${money(p.amount_cents)} by card or bank`; }
    });
  }
  load();
})();
