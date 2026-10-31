'use strict';
(function () {
  const view = document.getElementById('view');

  // ---------- utils ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toCents = (v) => Math.round(parseFloat(String(v).replace(/[^0-9.]/g, '')) * 100) || 0;
  const dollars = (c) => (Number(c || 0) / 100).toFixed(2);
  const when = (s) => {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    const mins = Math.round((Date.now() - d) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    if (mins < 1440) return Math.round(mins / 60) + ' hr ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
  const smsHref = (p, body) => 'sms:' + String(p || '').replace(/[^\d+]/g, '') + (body ? '?&body=' + encodeURIComponent(body) : '');
  const mapHref = (loc) => {
    const gps = /GPS:\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(loc || '');
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(gps ? gps[1] + ',' + gps[2] : loc || '');
  };
  const STATUS = { new: 'New', contacted: 'Contacted', quoted: 'Quoted', accepted: 'Accepted', paid: 'Paid', closed: 'Closed' };
  const QSTATUS = { draft: 'Draft', sent: 'Sent', signed: 'Signed', paid: 'Paid', void: 'Void' };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Please log in.'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function flash(el, msg, kind = 'ok') {
    if (!el) return;
    el.className = 'alert ' + kind; el.textContent = msg; el.hidden = false;
    if (kind === 'ok') setTimeout(() => { el.hidden = true; }, 3000);
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); if (btn) { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = t), 1500); } }
    catch { window.prompt('Copy this link:', text); }
  }

  // ---------- shell ----------
  function setNav(name) {
    document.querySelectorAll('[data-nav]').forEach((a) => { if (a.dataset.nav === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  function showChrome(on) {
    document.getElementById('topbar').hidden = !on;
    document.getElementById('bottomnav').hidden = !on;
  }
  let newCount = 0;
  function setNewCount(n) {
    newCount = n;
    document.querySelectorAll('[data-newcount]').forEach((b) => { b.textContent = n; b.hidden = !n; });
    document.title = (n ? `(${n}) ` : '') + 'Mike’s Dashboard';
  }

  function showLogin() {
    showChrome(false);
    view.innerHTML = `
      <form class="card login stack" id="login">
        <h1>Mike’s Dashboard</h1>
        <p class="muted">Log in to see repair requests, build quotes and take payments.</p>
        <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></div>
        <p class="alert err" id="login-err" hidden></p>
        <button class="btn primary block" type="submit">Log in</button>
      </form>`;
    const f = document.getElementById('login');
    f.pw.focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/login', { method: 'POST', body: { password: f.pw.value } }); route(); }
      catch (err) { flash(document.getElementById('login-err'), err.message, 'err'); }
    });
  }

  // ---------- requests ----------
  let reqFilter = 'open';
  async function requestsView() {
    setNav('requests');
    const data = await api('/api/requests?filter=' + reqFilter);
    setNewCount(data.counts.new);
    const tab = (k, label, n) => `<button type="button" data-filter="${k}" aria-pressed="${reqFilter === k}">${label} (${n})</button>`;
    view.innerHTML = `
      <div class="row between"><h1>Requests</h1><a class="btn sm" href="#/requests/new">+ Add a call-in</a></div>
      <div class="tabs" role="group" aria-label="Filter">${tab('new', 'New', data.counts.new)}${tab('open', 'Open', data.counts.open)}${tab('all', 'All', data.counts.all)}</div>
      <div class="list">${data.rows.length ? data.rows.map((r) => `
        <a class="item" href="#/requests/${r.id}">
          <div class="grow stack" style="gap:4px">
            <div class="row" style="gap:8px"><span class="item-title">${esc(r.name || 'No name')}</span>
              <span class="tag ${r.type}">${r.type === 'winterize' ? 'Winterize' : 'Repair'}</span>
              ${r.status === 'new' ? '<span class="tag new">New</span>' : `<span class="tag ${r.status}">${STATUS[r.status] || r.status}</span>`}
              ${r.has_photo ? '<span class="tag">Photo</span>' : ''}</div>
            <div class="small">${esc((r.location || '').split('\n')[0]).slice(0, 140)}</div>
            <div class="small muted">${esc(r.rig || '')}${r.rig && r.issue ? ' · ' : ''}${esc((r.issue || '').slice(0, 90))}${r.preferred_date ? ' · wants ' + esc(r.preferred_date) : ''}</div>
          </div>
          <div class="small muted" style="white-space:nowrap">${when(r.created_at)}</div>
        </a>`).join('') : '<p class="empty">Nothing here. New website requests show up here automatically.</p>'}
      </div>`;
    view.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { reqFilter = b.dataset.filter; requestsView(); }));
  }

  function newRequestView() {
    setNav('requests');
    view.innerHTML = `
      <a href="#/requests" class="small">← Requests</a>
      <form class="card stack" id="nr">
        <h1>Add a call-in or walk-up</h1>
        <div class="grid2">
          <div><label for="nr-type">Type</label><select id="nr-type" name="type"><option value="repair">Repair</option><option value="winterize">Winterizing</option></select></div>
          <div><label for="nr-name">Name</label><input id="nr-name" name="name"></div>
          <div><label for="nr-phone">Phone</label><input id="nr-phone" name="phone" type="tel"></div>
          <div><label for="nr-rig">Year, make, model</label><input id="nr-rig" name="rig"></div>
        </div>
        <div><label for="nr-loc">Location</label><textarea id="nr-loc" name="location" rows="2"></textarea></div>
        <div><label for="nr-issue">What’s wrong</label><textarea id="nr-issue" name="issue" rows="3"></textarea></div>
        <p class="alert err" id="nr-err" hidden></p>
        <button class="btn primary" type="submit">Save request</button>
      </form>`;
    const f = document.getElementById('nr');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/requests', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
        location.hash = '#/requests/' + r.id;
      } catch (err) { flash(document.getElementById('nr-err'), err.message, 'err'); }
    });
  }

  async function requestView(id) {
    setNav('requests');
    const [r, cfg] = await Promise.all([api('/api/requests/' + id), api('/api/config')]);
    const dep = cfg.settings.deposit_cents;
    const depPending = r.payments.filter((p) => p.kind === 'deposit' && p.status === 'pending');
    view.innerHTML = `
      <a href="#/requests" class="small">← Requests</a>
      <div class="row between">
        <div class="stack" style="gap:6px"><h1>${esc(r.name || 'No name')}</h1>
          <div class="row" style="gap:8px"><span class="tag ${r.type}">${r.type === 'winterize' ? 'Winterizing booking' : 'Repair request'}</span><span class="small muted">#${r.id} · ${when(r.created_at)}</span></div></div>
        <div><label for="rq-status" class="small">Status</label>
          <select id="rq-status" style="min-width:160px">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <a class="btn primary" href="${telHref(r.phone)}">Call ${esc(r.phone)}</a>
        <a class="btn" href="${smsHref(r.phone, `Hi ${r.name || ''}, this is Mike Stevens with Emergency RV & Trailer Repair. I got your request and I'm on it.`)}">Text</a>
        <a class="btn ghost" href="${mapHref(r.location)}" target="_blank" rel="noopener">Map</a>
      </div>
      <p class="alert" id="rq-msg" hidden></p>
      <div class="grid2">
        <section class="card">
          <h2>Details</h2>
          <dl class="facts">
            <dt>Where</dt><dd>${esc(r.location)}</dd>
            ${r.rig ? `<dt>Rig</dt><dd>${esc(r.rig)}</dd>` : ''}
            ${r.issue ? `<dt>Problem</dt><dd>${esc(r.issue)}</dd>` : ''}
            ${r.preferred_date ? `<dt>Wants</dt><dd>${esc(r.preferred_date)}</dd>` : ''}
            ${r.email ? `<dt>Email</dt><dd>${esc(r.email)}</dd>` : ''}
          </dl>
          ${r.photo ? `<a href="/api/uploads/${esc(r.photo)}" target="_blank" rel="noopener"><img class="photo" style="margin-top:12px" src="/api/uploads/${esc(r.photo)}" alt="Photo sent by the customer"></a>` : ''}
          <div style="margin-top:14px"><label for="rq-notes">Your notes</label><textarea id="rq-notes" rows="3">${esc(r.notes || '')}</textarea>
          <button class="btn sm" id="rq-save-notes" type="button" style="margin-top:8px">Save notes</button></div>
        </section>
        <div class="stack">
          ${r.type === 'repair' ? `
          <section class="card stack">
            <h2>Diagnosis deposit, ${money(dep)}</h2>
            <p class="small muted">For the diagnosis and onsite review. It’s credited toward the job if the customer goes ahead.</p>
            ${r.deposit_paid_cents ? `<p class="alert ok">${money(r.deposit_paid_cents)} paid. It will be credited on the quote.</p>` : `
            <div class="row">
              <button class="btn primary" type="button" data-dep="card">Card payment link</button>
              <button class="btn ghost" type="button" data-dep="cash">Got cash</button>
              <button class="btn ghost" type="button" data-dep="check">Got a check</button>
            </div>
            ${!cfg.stripe.enabled ? '<p class="small muted">Card payments aren’t connected yet. See Settings.</p>' : ''}
            ${depPending.map((p) => payLinkBox(location.origin + '/pay/' + p.token, r)).join('')}`}
          </section>` : ''}
          <section class="card stack">
            <div class="row between"><h2>Quotes</h2><button class="btn primary" id="rq-quote" type="button">Build a quote</button></div>
            ${r.quotes.length ? `<div class="list">${r.quotes.map((q) => `<a class="item" href="#/quotes/${q.id}"><div class="grow"><div class="item-title">${esc(q.title)}</div><div class="small muted">#${q.id} · ${when(q.created_at)}</div></div><div class="stack" style="gap:4px;align-items:flex-end"><strong>${money(q.totals.total)}</strong><span class="tag ${q.status}">${QSTATUS[q.status]}</span></div></a>`).join('')}</div>` : '<p class="muted small">No quotes yet.</p>'}
          </section>
        </div>
      </div>`;
    const msg = document.getElementById('rq-msg');
    document.getElementById('rq-status').addEventListener('change', async (e) => {
      try { await api('/api/requests/' + id, { method: 'PATCH', body: { status: e.target.value } }); flash(msg, 'Status saved.'); } catch (err) { flash(msg, err.message, 'err'); }
    });
    document.getElementById('rq-save-notes').addEventListener('click', async () => {
      try { await api('/api/requests/' + id, { method: 'PATCH', body: { notes: document.getElementById('rq-notes').value } }); flash(msg, 'Notes saved.'); } catch (err) { flash(msg, err.message, 'err'); }
    });
    view.querySelectorAll('[data-dep]').forEach((b) => b.addEventListener('click', async () => {
      const method = b.dataset.dep;
      if (method !== 'card' && !confirm(`Record ${money(dep)} paid by ${method}?`)) return;
      try { await api(`/api/requests/${id}/deposit`, { method: 'POST', body: { method } }); requestView(id); } catch (err) { flash(msg, err.message, 'err'); }
    }));
    view.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));
    document.getElementById('rq-quote').addEventListener('click', async () => {
      try { const q = await api('/api/quotes', { method: 'POST', body: { request_id: Number(id) } }); location.hash = '#/quotes/' + q.id; } catch (err) { flash(msg, err.message, 'err'); }
    });
  }

  function payLinkBox(url, r) {
    return `<div class="stack" style="gap:8px;border-top:1px solid var(--line);padding-top:12px">
      <p class="small"><strong>Payment link ready.</strong> Hand over your phone, or text it.</p>
      <div class="row">
        <a class="btn gold sm" href="${esc(url)}" target="_blank" rel="noopener">Open payment page</a>
        <a class="btn sm" href="${smsHref(r.customer_phone || r.phone, 'Mike Stevens RV Repair: here is your secure payment link: ' + url)}">Text link</a>
        <button class="btn ghost sm" type="button" data-copy="${esc(url)}">Copy link</button>
      </div></div>`;
  }

  // ---------- quotes ----------
  async function quotesView() {
    setNav('quotes');
    const rows = await api('/api/quotes');
    view.innerHTML = `
      <div class="row between"><h1>Quotes</h1><button class="btn primary sm" id="q-new" type="button">+ New quote</button></div>
      <div class="list">${rows.length ? rows.map((q) => `
        <a class="item" href="#/quotes/${q.id}">
          <div class="grow"><div class="item-title">${esc(q.customer_name || 'No name')}</div><div class="small muted">${esc(q.title)} · #${q.id} · ${when(q.created_at)}</div></div>
          <div class="stack" style="gap:4px;align-items:flex-end"><strong>${money(q.totals.total)}</strong><span class="tag ${q.status}">${QSTATUS[q.status]}</span></div>
        </a>`).join('') : '<p class="empty">No quotes yet. Open a request and tap “Build a quote”.</p>'}</div>`;
    document.getElementById('q-new').addEventListener('click', async () => { const q = await api('/api/quotes', { method: 'POST', body: {} }); location.hash = '#/quotes/' + q.id; });
  }

  async function quoteView(id) {
    setNav('quotes');
    const [q, products, cfg] = await Promise.all([api('/api/quotes/' + id), api('/api/products'), api('/api/config')]);
    const locked = Boolean(q.signed_at) || q.status === 'paid' || q.status === 'void';
    let items = q.items.map((it) => ({ ...it }));
    const active = products.filter((p) => p.active);

    view.innerHTML = `
      <a href="${q.request_id ? '#/requests/' + q.request_id : '#/quotes'}" class="small">← ${q.request_id ? 'Request #' + q.request_id : 'Quotes'}</a>
      <div class="row between"><h1>Quote #${q.id}</h1><span class="tag ${q.status}">${QSTATUS[q.status]}</span></div>
      <p class="alert" id="q-msg" hidden></p>
      ${locked && q.signed_at ? `<p class="alert ok">Signed by ${esc(q.signer_name)} on ${esc(new Date(q.signed_at.replace(' ', 'T') + 'Z').toLocaleString())}. Signed quotes can’t be edited.</p>` : ''}
      <form id="qf" class="stack">
        <fieldset ${locked ? 'disabled' : ''} style="border:0;padding:0;margin:0" class="stack">
        <section class="card stack">
          <h2>Customer</h2>
          <div class="grid2">
            <div><label for="q-title">Proposal title</label><input id="q-title" name="title" value="${esc(q.title)}"></div>
            <div><label for="q-name">Name</label><input id="q-name" name="customer_name" value="${esc(q.customer_name)}"></div>
            <div><label for="q-phone">Phone</label><input id="q-phone" name="customer_phone" type="tel" value="${esc(q.customer_phone)}"></div>
            <div><label for="q-email">Email (for the receipt)</label><input id="q-email" name="customer_email" type="email" value="${esc(q.customer_email)}"></div>
            <div><label for="q-rig">Year, make, model</label><input id="q-rig" name="rig" value="${esc(q.rig)}"></div>
            <div><label for="q-loc">Location</label><textarea id="q-loc" name="location" rows="2">${esc(q.location)}</textarea></div>
          </div>
        </section>
        <section class="card stack">
          <h2>Work and parts</h2>
          <div class="lines" id="lines"></div>
          <div class="row" ${locked ? 'hidden' : ''}>
            <div class="grow" style="min-width:220px"><label for="q-add" class="small">Add from your products</label>
              <select id="q-add"><option value="">Choose a product…</option>${active.map((p) => `<option value="${p.id}">${esc(p.name)} (${money(p.price_cents)})</option>`).join('')}</select></div>
            <button class="btn" type="button" id="q-custom" style="align-self:flex-end">+ Custom line</button>
          </div>
        </section>
        <section class="card stack">
          <h2>Notes and terms</h2>
          <div><label for="q-notes">Notes for the customer</label><textarea id="q-notes" name="notes" rows="3" placeholder="What you found and what you’ll do">${esc(q.notes)}</textarea></div>
          <div><label for="q-terms">Terms</label><textarea id="q-terms" name="terms" rows="3">${esc(q.terms)}</textarea></div>
          <div style="max-width:200px"><label for="q-tax">Sales tax % (taxable lines)</label><input id="q-tax" name="tax" inputmode="decimal" value="${(q.tax_rate_bp / 100).toString()}"></div>
        </section>
        </fieldset>
        <section class="card stack">
          <h2>Total</h2>
          <dl class="totals" id="totals"></dl>
        </section>
        <div class="sticky-actions row">
          ${locked ? '' : '<button class="btn" type="submit">Save</button><button class="btn primary" type="button" id="q-show">Save and show proposal</button>'}
          ${locked ? `<a class="btn primary" href="${esc(q.proposal_url)}" target="_blank" rel="noopener">Open proposal</a>` : ''}
          <a class="btn ghost" href="${smsHref(q.customer_phone, 'Mike Stevens RV Repair: here is your proposal to review and sign: ' + q.proposal_url)}" id="q-text">Text link</a>
          <button class="btn ghost" type="button" data-copy="${esc(q.proposal_url)}">Copy link</button>
        </div>
      </form>
      <section class="card stack" id="q-pay"></section>`;

    const linesEl = document.getElementById('lines');
    const f = document.getElementById('qf');
    const msg = document.getElementById('q-msg');

    function totals() {
      const tax = toCents(f.elements.tax.value); // percent x 100 = basis points
      let sub = 0, taxable = 0;
      items.forEach((it) => { const l = Math.round((Number(it.qty) || 0) * it.unit_cents); sub += l; if (it.taxable) taxable += l; });
      const taxC = Math.round(taxable * tax / 10000);
      const total = sub + taxC;
      const credit = Math.min(q.deposit_credit_cents || 0, total);
      return { sub, taxC, total, credit, balance: total - credit };
    }
    function renderTotals() {
      const t = locked ? { sub: q.totals.subtotal, taxC: q.totals.tax, total: q.totals.total, credit: q.totals.credit, balance: q.totals.balance } : totals();
      document.getElementById('totals').innerHTML = `
        <dt>Subtotal</dt><dd>${money(t.sub)}</dd>
        ${t.taxC ? `<dt>Sales tax</dt><dd>${money(t.taxC)}</dd>` : ''}
        <dt>Total</dt><dd>${money(t.total)}</dd>
        ${t.credit ? `<dt>Diagnosis deposit paid</dt><dd>−${money(t.credit)}</dd>` : ''}
        <dt class="big">Balance due</dt><dd class="big">${money(t.balance)}</dd>`;
    }
    function renderLines() {
      linesEl.innerHTML = items.length ? items.map((it, i) => `
        <div class="line" data-i="${i}">
          <div class="nm field"><label class="small" for="ln-n${i}">Item</label><input id="ln-n${i}" data-k="name" value="${esc(it.name)}"></div>
          <div class="field"><label class="small" for="ln-q${i}">Qty</label><input id="ln-q${i}" data-k="qty" inputmode="decimal" value="${esc(it.qty)}"></div>
          <div class="field"><label class="small" for="ln-p${i}">Price each</label><input id="ln-p${i}" data-k="price" inputmode="decimal" value="${dollars(it.unit_cents)}"></div>
          <button class="btn ghost sm del" type="button" data-del="${i}" aria-label="Remove ${esc(it.name)}">Remove</button>
          <div class="desc field"><label class="small" for="ln-d${i}">Description (optional)</label><input id="ln-d${i}" data-k="description" value="${esc(it.description || '')}"></div>
          <label class="check small" style="grid-column:1/-1"><input type="checkbox" data-k="taxable" ${it.taxable ? 'checked' : ''}> Taxable</label>
        </div>`).join('') : '<p class="muted small">No lines yet. Add a product or a custom line.</p>';
      renderTotals();
    }
    linesEl.addEventListener('input', (e) => {
      const row = e.target.closest('[data-i]'); if (!row) return;
      const it = items[row.dataset.i]; const k = e.target.dataset.k;
      if (k === 'price') it.unit_cents = toCents(e.target.value);
      else if (k === 'qty') it.qty = e.target.value;
      else if (k === 'taxable') it.taxable = e.target.checked ? 1 : 0;
      else it[k] = e.target.value;
      renderTotals();
    });
    linesEl.addEventListener('change', (e) => { if (e.target.dataset.k === 'taxable') { items[e.target.closest('[data-i]').dataset.i].taxable = e.target.checked ? 1 : 0; renderTotals(); } });
    linesEl.addEventListener('click', (e) => { const d = e.target.closest('[data-del]'); if (d) { items.splice(Number(d.dataset.del), 1); renderLines(); } });
    f.elements.tax.addEventListener('input', renderTotals);
    if (!locked) {
      document.getElementById('q-add').addEventListener('change', (e) => {
        const p = active.find((x) => String(x.id) === e.target.value); if (!p) return;
        items.push({ product_id: p.id, name: p.name, description: p.description, qty: 1, unit_cents: p.price_cents, taxable: p.taxable });
        e.target.value = ''; renderLines();
      });
      document.getElementById('q-custom').addEventListener('click', () => {
        items.push({ name: '', description: '', qty: 1, unit_cents: 0, taxable: 0 }); renderLines();
        linesEl.querySelector(`[data-i="${items.length - 1}"] input`).focus();
      });
    }
    async function save() {
      const body = Object.fromEntries(new FormData(f));
      body.tax_rate_bp = toCents(f.elements.tax.value);
      body.items = items.map((it) => ({ ...it, qty: Number(it.qty) || 0 })).filter((it) => it.name.trim());
      return api('/api/quotes/' + id, { method: 'PUT', body });
    }
    f.addEventListener('submit', async (e) => { e.preventDefault(); try { await save(); await quoteView(id); flash(document.getElementById('q-msg'), 'Saved.'); } catch (err) { flash(msg, err.message, 'err'); } });
    const show = document.getElementById('q-show');
    if (show) show.addEventListener('click', async () => {
      const w = window.open('', '_blank');
      try { const saved = await save(); if (w) w.location = saved.proposal_url; else location.href = saved.proposal_url; quoteView(id); }
      catch (err) { if (w) w.close(); flash(msg, err.message, 'err'); }
    });
    view.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));
    renderLines();

    // payment / status card
    const pay = document.getElementById('q-pay');
    const paidList = q.payments.filter((p) => p.status === 'paid');
    pay.innerHTML = `
      <h2>Payment</h2>
      ${q.status === 'paid' ? `<p class="alert ok">Paid in full. ${paidList.map((p) => `${money(p.amount_cents)} by ${esc(p.method)}`).join(', ')}.</p>` :
        q.signed_at ? `<p>Balance due: <strong>${money(q.totals.balance)}</strong>. The customer can pay by card on the proposal page${cfg.stripe.enabled ? '' : ' once card payments are connected in Settings'}, or record cash or a check here.</p>
        <div class="row"><button class="btn ghost" type="button" data-paid="cash">Got cash</button><button class="btn ghost" type="button" data-paid="check">Got a check</button></div>` :
        q.status === 'void' ? '<p class="muted">This quote is void.</p>' : '<p class="muted">The customer signs the proposal first, then pays.</p>'}
      ${q.status !== 'paid' ? `<div class="row" style="border-top:1px solid var(--line);padding-top:12px">${q.status === 'void' ? (q.signed_at ? '' : '<button class="linkbtn" type="button" data-st="draft">Restore quote</button>') : '<button class="linkbtn" type="button" data-st="void">Void this quote</button>'}</div>` : ''}`;
    pay.querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Record ${money(q.totals.balance)} paid by ${b.dataset.paid}?`)) return;
      try { await api(`/api/quotes/${id}/payments`, { method: 'POST', body: { method: b.dataset.paid } }); quoteView(id); } catch (err) { flash(msg, err.message, 'err'); }
    }));
    pay.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.st === 'void' && !confirm('Void this quote? The customer link will stop working.')) return;
      try { await api(`/api/quotes/${id}/status`, { method: 'POST', body: { status: b.dataset.st } }); quoteView(id); } catch (err) { flash(msg, err.message, 'err'); }
    }));
  }

  // ---------- products ----------
  async function productsView() {
    setNav('products');
    const rows = await api('/api/products');
    view.innerHTML = `
      <h1>Products and services</h1>
      <p class="muted">These show up when you build a quote. Prices can still be changed on each quote.</p>
      <form class="card stack" id="pf">
        <h2>Add a product</h2>
        <div class="grid2">
          <div><label for="pf-name">Name</label><input id="pf-name" name="name" required placeholder="Trailer tire, ST225/75R15"></div>
          <div><label for="pf-price">Price ($)</label><input id="pf-price" name="price" inputmode="decimal" required placeholder="0.00"></div>
        </div>
        <div><label for="pf-desc">Description</label><input id="pf-desc" name="description"></div>
        <label class="check"><input type="checkbox" name="taxable"> Taxable</label>
        <p class="alert" id="pf-msg" hidden></p>
        <button class="btn primary" type="submit">Add product</button>
      </form>
      <div class="list">${rows.map((p) => `
        <div class="item" style="display:block;padding:14px 16px;border-bottom:1px solid var(--line)" data-pid="${p.id}">
          <div class="row between">
            <div class="grow"><span class="item-title">${esc(p.name)}</span> ${p.active ? '' : '<span class="tag void">Hidden</span>'} ${p.taxable ? '<span class="tag">Taxable</span>' : ''}<div class="small muted">${esc(p.description || '')}</div></div>
            <strong>${money(p.price_cents)}</strong>
            <button class="btn ghost sm" type="button" data-edit="${p.id}">Edit</button>
          </div>
        </div>`).join('')}</div>`;
    const f = document.getElementById('pf');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/products', { method: 'POST', body: { name: f.elements.name.value, description: f.elements.description.value, price_cents: toCents(f.elements.price.value), taxable: f.elements.taxable.checked } });
        productsView();
      } catch (err) { flash(document.getElementById('pf-msg'), err.message, 'err'); }
    });
    view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const p = rows.find((x) => String(x.id) === b.dataset.edit);
      const box = view.querySelector(`[data-pid="${p.id}"]`);
      box.innerHTML = `<form class="stack">
        <div class="grid2"><div><label for="e-n${p.id}">Name</label><input id="e-n${p.id}" name="name" value="${esc(p.name)}"></div>
        <div><label for="e-p${p.id}">Price ($)</label><input id="e-p${p.id}" name="price" inputmode="decimal" value="${dollars(p.price_cents)}"></div></div>
        <div><label for="e-d${p.id}">Description</label><input id="e-d${p.id}" name="description" value="${esc(p.description || '')}"></div>
        <label class="check"><input type="checkbox" name="taxable" ${p.taxable ? 'checked' : ''}> Taxable</label>
        <label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Show when building quotes</label>
        <div class="row"><button class="btn primary sm" type="submit">Save</button><button class="btn ghost sm" type="button" data-cancel>Cancel</button></div></form>`;
      const ef = box.querySelector('form');
      ef.querySelector('[data-cancel]').addEventListener('click', productsView);
      ef.addEventListener('submit', async (e) => {
        e.preventDefault();
        await api('/api/products/' + p.id, { method: 'PATCH', body: { name: ef.elements.name.value, description: ef.elements.description.value, price_cents: toCents(ef.elements.price.value), taxable: ef.elements.taxable.checked, active: ef.elements.active.checked } });
        productsView();
      });
    }));
  }

  // ---------- settings ----------
  async function settingsView() {
    setNav('settings');
    const cfg = await api('/api/config');
    const s = cfg.settings, st = cfg.stripe;
    view.innerHTML = `
      <h1>Settings</h1>
      <form class="card stack" id="sf">
        <h2>Quotes</h2>
        <div class="grid2">
          <div><label for="s-dep">Diagnosis deposit ($)</label><input id="s-dep" name="dep" inputmode="decimal" value="${dollars(s.deposit_cents)}"></div>
          <div><label for="s-tax">Default sales tax % (taxable lines)</label><input id="s-tax" name="tax" inputmode="decimal" value="${s.tax_rate_bp / 100}"></div>
        </div>
        <div><label for="s-terms">Default terms on proposals</label><textarea id="s-terms" name="terms" rows="4">${esc(s.terms)}</textarea></div>
        <p class="alert" id="s-msg" hidden></p>
        <button class="btn primary" type="submit">Save settings</button>
      </form>
      <section class="card stack">
        <h2>Card payments</h2>
        ${st.enabled ? `<p class="alert ok">Stripe is connected${st.test_mode ? ' in <strong>test mode</strong> (no real money moves)' : ''}${st.connected_account ? ' through a connected account' : ''}.</p>
          ${st.webhook ? '' : '<p class="small">Tip: add the Stripe webhook so bank (ACH) payments are confirmed automatically. See the README.</p>'}`
          : '<p>Not connected yet. Card payments need a Stripe key on the server (see the README). Until then, record cash and check payments here.</p>'}
      </section>
      <section class="card stack">
        <h2>Text alerts</h2>
        <p>${cfg.sms_alerts ? 'On. You get a text for each new request, signature and payment.' : 'Off. Add Twilio settings on the server to get a text for every new request.'}</p>
      </section>
      <button class="btn ghost" type="button" id="logout">Log out</button>`;
    const f = document.getElementById('sf');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/settings', { method: 'PUT', body: { deposit_cents: toCents(f.dep.value), tax_rate_bp: toCents(f.tax.value), terms: f.terms.value } }); flash(document.getElementById('s-msg'), 'Saved.'); }
      catch (err) { flash(document.getElementById('s-msg'), err.message, 'err'); }
    });
    document.getElementById('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); showLogin(); });
  }

  // ---------- router ----------
  async function route() {
    const me = await api('/api/me').catch(() => ({ authed: false }));
    if (!me.authed) return showLogin();
    showChrome(true);
    const h = location.hash.replace(/^#\/?/, '') || 'requests';
    const [a, b] = h.split('/');
    try {
      if (a === 'requests' && b === 'new') newRequestView();
      else if (a === 'requests' && b) await requestView(b);
      else if (a === 'quotes' && b) await quoteView(b);
      else if (a === 'quotes') await quotesView();
      else if (a === 'products') await productsView();
      else if (a === 'settings') await settingsView();
      else await requestsView();
      window.scrollTo(0, 0);
    } catch (err) {
      if (err.message !== 'Please log in.') view.innerHTML = `<p class="alert err">${esc(err.message)}</p><a href="#/requests">Back to requests</a>`;
    }
  }
  window.addEventListener('hashchange', route);
  route();

  // Check for new requests every 30 seconds.
  setInterval(async () => {
    if (document.getElementById('topbar').hidden) return;
    try {
      const d = await api('/api/requests?filter=new');
      if (d.counts.new > newCount && 'Notification' in window && Notification.permission === 'granted') new Notification('New request', { body: d.rows[0] ? `${d.rows[0].name || 'Customer'}: ${(d.rows[0].location || '').slice(0, 80)}` : '' });
      setNewCount(d.counts.new);
      if ((location.hash === '' || location.hash === '#/requests') && document.activeElement === document.body) requestsView();
    } catch { /* offline */ }
  }, 30000);
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
})();
