'use strict';
(function () {
  const doc = document.getElementById('doc');
  const token = location.pathname.split('/').pop();
  const params = new URLSearchParams(location.search);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = (q) => (Number(q) % 1 ? Number(q).toFixed(2) : String(Number(q)));
  const date = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  async function load() {
    // Returning from Stripe Checkout: confirm the payment first.
    if (params.get('paid') && params.get('session_id')) {
      try { await api(`/api/public/payments/${encodeURIComponent(params.get('paid'))}/confirm`, { session_id: params.get('session_id') }); } catch { /* webhook will catch up */ }
      history.replaceState(null, '', location.pathname);
    }
    let q;
    try { q = await api('/api/public/proposals/' + encodeURIComponent(token)); }
    catch (e) { doc.innerHTML = `<p class="alert err">${esc(e.message)}</p><p>Questions? Call or text Mike at <a href="tel:+18012324995">801-232-4995</a>.</p>`; return; }
    render(q);
  }

  function render(q) {
    const t = q.totals;
    const signed = Boolean(q.signed_at), paid = q.status === 'paid';
    doc.innerHTML = `
      <div class="stack" style="gap:6px">
        <p class="muted small">Proposal #${q.id} · ${date(q.created_at)}</p>
        <h1>${esc(q.title)}</h1>
        ${paid ? '<div><span class="paid-stamp">Paid</span></div>' : ''}
      </div>
      <section class="card">
        <dl class="facts">
          ${q.customer_name ? `<dt>For</dt><dd>${esc(q.customer_name)}</dd>` : ''}
          ${q.rig ? `<dt>RV</dt><dd>${esc(q.rig)}</dd>` : ''}
          ${q.location ? `<dt>Where</dt><dd>${esc(q.location)}</dd>` : ''}
        </dl>
      </section>
      ${q.notes ? `<section class="card"><h2>What Mike found</h2><p style="white-space:pre-wrap">${esc(q.notes)}</p></section>` : ''}
      <section class="card stack">
        <table class="items">
          <thead><tr><th scope="col">Work and parts</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Amount</th></tr></thead>
          <tbody>${q.items.map((it) => `<tr><td><strong>${esc(it.name)}</strong>${it.description ? `<div class="small muted">${esc(it.description)}</div>` : ''}</td><td class="num">${qtyFmt(it.qty)}</td><td class="num">${money(Math.round(it.qty * it.unit_cents))}</td></tr>`).join('')}</tbody>
        </table>
        <dl class="totals">
          <dt>Subtotal</dt><dd>${money(t.subtotal)}</dd>
          ${t.tax ? `<dt>Sales tax (${q.tax_rate_bp / 100}%)</dt><dd>${money(t.tax)}</dd>` : ''}
          <dt>Total</dt><dd>${money(t.total)}</dd>
          ${t.credit ? `<dt>Diagnosis deposit already paid</dt><dd>−${money(t.credit)}</dd>` : ''}
          <dt class="big">${paid ? 'Paid' : 'Balance due'}</dt><dd class="big">${money(t.balance)}</dd>
        </dl>
      </section>
      ${q.terms ? `<section class="card"><h2>Terms</h2><p class="small" style="white-space:pre-wrap">${esc(q.terms)}</p></section>` : ''}
      <section class="card stack" id="sign"></section>
      <section class="card stack no-print" id="pay"></section>
      <p class="small muted no-print">Questions? Call or text Mike at <a href="tel:+18012324995">801-232-4995</a>. <button class="linkbtn" type="button" id="print">Print or save a copy</button></p>`;
    document.getElementById('print').addEventListener('click', () => window.print());

    const sign = document.getElementById('sign');
    if (signed) {
      sign.innerHTML = `<h2>Accepted</h2><img class="sig-img" src="${q.signature_png}" alt="Signature of ${esc(q.signer_name)}"><p>${esc(q.signer_name)} · ${date(q.signed_at)}</p>`;
    } else {
      sign.innerHTML = `
        <h2>Accept and sign</h2>
        <form id="sf" class="stack">
          <div><label for="sn">Your full name</label><input id="sn" name="name" autocomplete="name" value="${esc(q.customer_name || '')}" required></div>
          <div><p id="sig-label" style="font-family:var(--cond);font-weight:600;font-size:17px;margin-bottom:4px">Sign with your finger or mouse</p>
            <canvas class="sigpad" id="pad" role="img" aria-labelledby="sig-label"></canvas>
            <button class="linkbtn" type="button" id="clear">Clear signature</button></div>
          <label class="check"><input type="checkbox" name="agree" id="agree"> I approve this work and the total above, and I agree to the terms.</label>
          <p class="alert err" id="serr" hidden></p>
          <button class="btn primary block" type="submit">Accept and sign</button>
        </form>`;
      setupSign(q);
    }

    const pay = document.getElementById('pay');
    if (paid) pay.innerHTML = `<p class="alert ok">Paid in full. Thank you!</p>`;
    else if (!signed) pay.hidden = true;
    else if (t.balance <= 0) pay.innerHTML = `<p class="alert ok">Nothing is due right now.</p>`;
    else pay.innerHTML = `
      <h2>Pay ${money(t.balance)}</h2>
      ${q.card_payments ? `<button class="btn primary block" type="button" id="paybtn">Pay by card or bank</button>
      <p class="small muted">You’ll go to Stripe’s secure checkout, then come right back here.</p>` : ''}
      <p class="small">${q.card_payments ? 'Or pay' : 'Pay'} Mike directly by cash or check.</p>
      <p class="alert err" id="perr" hidden></p>`;
    const pb = document.getElementById('paybtn');
    if (pb) pb.addEventListener('click', async () => {
      pb.disabled = true; pb.textContent = 'Opening secure checkout…';
      try { const { url } = await api(`/api/public/proposals/${encodeURIComponent(token)}/checkout`, {}); location.href = url; }
      catch (e) { const el = document.getElementById('perr'); el.textContent = e.message; el.hidden = false; pb.disabled = false; pb.textContent = 'Pay by card or bank'; }
    });
  }

  function setupSign(q) {
    const canvas = document.getElementById('pad');
    const ctx = canvas.getContext('2d');
    let drawing = false, inked = false, last = null;
    function size() {
      const r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      const prev = inked ? canvas.toDataURL() : null;
      canvas.width = r.width * d; canvas.height = r.height * d;
      ctx.scale(d, d); ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1F1C17';
      if (prev) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height); img.src = prev; }
    }
    size(); window.addEventListener('resize', size);
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return; const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; inked = true;
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
    document.getElementById('clear').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); inked = false; });

    const f = document.getElementById('sf');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('serr');
      if (!f.elements.name.value.trim()) { err.textContent = 'Type your full name.'; err.hidden = false; return; }
      if (!inked) { err.textContent = 'Please sign in the box.'; err.hidden = false; return; }
      if (!f.elements.agree.checked) { err.textContent = 'Check the box to approve the work.'; err.hidden = false; return; }
      // Export on a white background, scaled down to keep it small.
      const out = document.createElement('canvas'); out.width = 600; out.height = 600 * canvas.height / canvas.width;
      const o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0, out.width, out.height);
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        await api(`/api/public/proposals/${encodeURIComponent(token)}/sign`, { name: f.elements.name.value, agree: true, signature: out.toDataURL('image/png') });
        load();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    });
  }

  load();
})();
