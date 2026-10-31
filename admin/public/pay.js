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
    applyBrand(p.business);
    const o = p.online;
    const isDeposit = p.kind === 'deposit';
    doc.innerHTML = `
      <h1>${p.status === 'paid' ? 'Thank you' : 'Payment'}</h1>
      <section class="card stack">
        <h2>${esc(p.description)}</h2>
        <p style="font-family:var(--display);font-size:44px;line-height:1.1">${money(p.amount_cents)}</p>
        ${isDeposit ? `<p>If you go ahead with the job, this full amount is credited toward it.</p>` : ''}
        ${p.status === 'paid' ? `<p class="alert ok">Paid${p.fee_cents ? ` (plus ${money(p.fee_cents)} Processing Fee)` : ''}. ${esc(p.business.name)} has been notified.</p>` : o.card_payments ? `
          ${o.fee ? `<dl class="totals"><dt>Amount</dt><dd>${money(p.amount_cents)}</dd><dt>Processing Fee (${o.bp / 100}%)</dt><dd>${money(o.fee)}</dd><dt class="big">Total paid online</dt><dd class="big">${money(o.charge)}</dd></dl>` : ''}
          <button class="btn primary block" id="paybtn" type="button">Pay ${money(o.charge)} by card or bank</button>
          <p class="small muted">You’ll go to Stripe’s secure checkout, then come right back here.${o.fee ? ` Paying by cash or check instead? No Processing Fee.` : ''}</p>` : `<p>Online payment isn’t available yet. Please pay ${esc(p.business.name)} directly.</p>`}
        <p class="alert err" id="perr" hidden></p>
      </section>
      <p class="small muted">${contactLine(p.business)} <a href="/legal/customer-terms" target="_blank" rel="noopener">Customer terms</a></p>`;
    const pb = document.getElementById('paybtn');
    if (pb) pb.addEventListener('click', async () => {
      pb.disabled = true; pb.textContent = 'Opening secure checkout…';
      try { const { url } = await api(`/api/public/payments/${encodeURIComponent(token)}/checkout`, {}); location.href = url; }
      catch (e) { const el = document.getElementById('perr'); el.textContent = e.message; el.hidden = false; pb.disabled = false; pb.textContent = 'Try again'; }
    });
  }
  load();
})();
