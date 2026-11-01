'use strict';
(function () {
  const view = document.getElementById('view');
  let me = null; // { user, tenant, viewing_as, needs_agreements }

  // ---------- utils ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toCents = (v) => Math.round(parseFloat(String(v).replace(/[^0-9.]/g, '')) * 100) || 0;
  const dollars = (c) => (Number(c || 0) / 100).toFixed(2);
  const pct = (bp) => (Number(bp || 0) / 100).toString() + '%';
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
  const PLATFORM = 'HitchPoint';
  const FEE_TEXT = (bp) => `Stripe’s fee + ${pct(bp)}`;
  const LEGAL = '<a href="/legal/terms" target="_blank" rel="noopener">Terms of Service</a>, <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="/legal/payment-terms" target="_blank" rel="noopener">Payment Processing and Fee Terms</a>';
  const isSuper = () => me && me.user.role === 'super';
  const isOwner = () => me && (me.user.role === 'owner' || isSuper());
  const bizName = () => (me && me.tenant ? me.tenant.name : 'Dashboard');

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (opts.raw) return res;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.quiet) { me = null; showAuth('login'); throw new Error('Please log in.'); }
    if (res.status === 428) { await loadMe(); route(); throw new Error('Please log in.'); }
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
    catch { window.prompt('Copy this:', text); }
  }
  function readImage(file, max = 1600) {
    return new Promise((resolve) => {
      if (!file) return resolve(null);
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85));
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // ---------- shell ----------
  const ICON = {
    requests: '<path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>',
    quotes: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line>',
    products: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>',
    business: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline>',
    settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
    grid: '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>',
  };
  const svg = (k) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  function buildChrome() {
    const tenantMode = Boolean(me.tenant);
    const items = tenantMode
      ? [['requests', 'Requests', 'requests'], ['quotes', 'Quotes', 'quotes'], ['products', 'Products', 'products'], ['business', 'Business', 'business'], ['settings', 'Settings', 'settings']]
      : [['super', 'Businesses', 'grid'], ['leads', 'Leads', 'requests'], ['platform', 'Platform', 'settings']];
    const badge = (k) => (k === 'requests' ? '<span class="badge" data-newcount hidden></span>' : '');
    document.getElementById('topnav').innerHTML = items.map(([k, l]) => `<a href="#/${k}" data-nav="${k}">${l} ${badge(k)}</a>`).join('');
    const bn = document.getElementById('bottomnav');
    bn.style.gridTemplateColumns = `repeat(${items.length}, 1fr)`;
    bn.innerHTML = items.map(([k, l, ic]) => `<a href="#/${k}" data-nav="${k}">${svg(ic)}${l}${badge(k)}</a>`).join('');
    const logo = me.tenant && me.tenant.logo ? `<img src="/media/${esc(me.tenant.slug)}/${esc(me.tenant.logo)}" alt="" style="height:34px;border-radius:4px;background:#fff">` : '';
    document.getElementById('brand').innerHTML = `${logo}<span>${esc(tenantMode ? me.tenant.name : PLATFORM)}<small>${tenantMode ? PLATFORM + ' dashboard' : 'Agilities admin'}</small></span>`;
    document.getElementById('brand').setAttribute('href', tenantMode ? '#/requests' : '#/super');
    const top = document.getElementById('topbar');
    top.style.background = tenantMode ? (me.tenant.primary_color || '') : '#1F1C17';
    const va = document.getElementById('viewas');
    va.hidden = !me.viewing_as;
    if (me.viewing_as) {
      va.innerHTML = `<span>Agilities admin, viewing <strong>${esc(me.tenant.name)}</strong></span><button type="button" class="btn sm gold" id="exit-viewas">Back to all businesses</button>`;
      document.getElementById('exit-viewas').addEventListener('click', async () => { await api('/api/super/view-as', { method: 'POST', body: { tenant_id: 0 } }); location.hash = '#/super'; await loadMe(); route(); });
    }
    document.title = bizName();
  }
  function setNav(name) {
    document.querySelectorAll('[data-nav]').forEach((a) => { if (a.dataset.nav === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  function showChrome(on) {
    document.getElementById('topbar').hidden = !on;
    document.getElementById('bottomnav').hidden = !on;
    if (!on) document.getElementById('viewas').hidden = true;
  }
  let newCount = 0;
  function setNewCount(n) {
    newCount = n;
    document.querySelectorAll('[data-newcount]').forEach((b) => { b.textContent = n; b.hidden = !n; });
    document.title = (n ? `(${n}) ` : '') + bizName();
  }

  // ---------- sign in / sign up / reset ----------
  const brandHead = `<a href="/" class="row" style="gap:10px;text-decoration:none;color:var(--ink);font-family:var(--cond);font-weight:700;font-size:24px"><img src="/favicon.svg" alt="" width="36" height="36">${PLATFORM}</a>`;
  function showAuth(mode, token) {
    showChrome(false);
    const legalNote = `<p class="small muted">${PLATFORM} is a d/b/a of Agilities. <a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a></p>`;
    if (mode === 'signup') {
      view.innerHTML = `
        <form class="card login stack" id="af" style="max-width:480px">
          ${brandHead}
          <h1>Create your business account</h1>
          <p class="muted">Your branded website, job inbox, onsite quotes, e-signatures and payments by direct deposit. No monthly fee.</p>
          <div><label for="a-biz">Business name</label><input id="a-biz" name="business_name" required autocomplete="organization"></div>
          <div><label for="a-name">Your name</label><input id="a-name" name="name" required autocomplete="name"></div>
          <div><label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>
          <div><label for="a-phone">Mobile phone (for request alerts)</label><input id="a-phone" name="phone" type="tel" autocomplete="tel"></div>
          <div><label for="a-pw">Password (10+ characters)</label><input id="a-pw" name="password" type="password" minlength="10" required autocomplete="new-password"></div>
          <label class="check"><input type="checkbox" name="agree" required> <span>I agree to the ${LEGAL}, including the Processing Fee (Stripe’s fee + 3%) deducted from online payments before payout.</span></label>
          <p class="alert err" id="a-err" hidden></p>
          <button class="btn primary block" type="submit">Create account</button>
          <p class="small">Already have an account? <a href="#/login">Log in</a></p>
        </form>`;
    } else if (mode === 'forgot') {
      view.innerHTML = `
        <form class="card login stack" id="af">
          ${brandHead}
          <h1>Reset your password</h1>
          <div><label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>
          <p class="alert" id="a-err" hidden></p>
          <button class="btn primary block" type="submit">Send reset link</button>
          <p class="small"><a href="#/login">Back to log in</a></p>
        </form>`;
    } else if (mode === 'reset') {
      view.innerHTML = `
        <form class="card login stack" id="af">
          ${brandHead}
          <h1>Set your password</h1>
          <div><label for="a-pw">New password (10+ characters)</label><input id="a-pw" name="password" type="password" minlength="10" required autocomplete="new-password"></div>
          <p class="alert err" id="a-err" hidden></p>
          <button class="btn primary block" type="submit">Save password</button>
        </form>`;
    } else {
      view.innerHTML = `
        <form class="card login stack" id="af">
          ${brandHead}
          <h1>Log in</h1>
          <div><label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="username"></div>
          <div><label for="a-pw">Password</label><input id="a-pw" name="password" type="password" required autocomplete="current-password"></div>
          <p class="alert err" id="a-err" hidden></p>
          <button class="btn primary block" type="submit">Log in</button>
          <p class="small"><a href="#/forgot">Forgot your password?</a> · <a href="#/signup">Create a business account</a></p>
          ${legalNote}
        </form>`;
    }
    const f = document.getElementById('af');
    const err = document.getElementById('a-err');
    (f.querySelector('input') || {}).focus?.();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      try {
        if (mode === 'signup') { body.agree = f.elements.agree.checked; await api('/api/signup', { method: 'POST', body, quiet: true }); location.hash = '#/business'; }
        else if (mode === 'forgot') {
          const r = await api('/api/password/forgot', { method: 'POST', body, quiet: true });
          flash(err, r.email_enabled ? 'If that email has an account, a reset link is on its way.' : `Email isn’t set up yet. Ask ${PLATFORM} support for a reset link.`, 'ok'); err.hidden = false; return;
        } else if (mode === 'reset') { await api('/api/password/reset', { method: 'POST', body: { token, password: body.password }, quiet: true }); location.hash = '#/'; }
        else { await api('/api/login', { method: 'POST', body, quiet: true }); if (/^#\/(login|signup|forgot|reset)/.test(location.hash)) location.hash = '#/'; }
        await loadMe(); route();
      } catch (ex) { flash(err, ex.message, 'err'); }
    });
  }

  function agreementsView() {
    showChrome(false);
    view.innerHTML = `
      <form class="card login stack" id="ag" style="max-width:520px">
        <h1>Before you start</h1>
        <p>Please review and accept the agreements for using this platform with ${esc(bizName())}.</p>
        <ul class="stack" style="margin:0;padding-left:20px;gap:6px"><li><a href="/legal/terms" target="_blank" rel="noopener">Business Terms of Service</a></li><li><a href="/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a></li><li><a href="/legal/payment-terms" target="_blank" rel="noopener">Payment Processing and Fee Terms</a></li></ul>
        <label class="check"><input type="checkbox" name="agree"> <span>I have read and agree to the ${LEGAL} on behalf of my business.</span></label>
        <p class="alert err" id="ag-err" hidden></p>
        <button class="btn primary block" type="submit">Accept and continue</button>
        <button class="linkbtn" type="button" id="ag-out">Log out</button>
      </form>`;
    const f = document.getElementById('ag');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!f.elements.agree.checked) return flash(document.getElementById('ag-err'), 'Check the box to accept.', 'err');
      await api('/api/agreements/accept', { method: 'POST', body: { agree: true } }); await loadMe(); route();
    });
    document.getElementById('ag-out').addEventListener('click', logout);
  }
  async function onboardingView(sub) {
    showChrome(false);
    if (sub === 'return' || sub === 'refresh') { try { await api('/api/stripe/refresh', { method: 'POST' }); await loadMe(); } catch { /* shown below */ } if (!me.needs_payout_setup) { location.hash = '#/business'; return route(); } }
    view.innerHTML = `
      <section class="card login stack" style="max-width:520px">
        ${brandHead}
        <h1>Set up direct deposit</h1>
        <p>Online payments from your customers are deposited to your bank account. Stripe, our payments partner, verifies your identity and collects your bank details securely. It takes about 10 minutes.</p>
        <p class="small"><strong>Have ready:</strong> your legal or business name, EIN or SSN, business address, bank routing and account numbers, and a photo ID.</p>
        <p class="small muted">The Processing Fee on each online payment (Stripe’s fee + 3%) is deducted before your payout. Cash and check payments have no fee. See the <a href="/legal/payment-terms" target="_blank" rel="noopener">Payment Processing and Fee Terms</a>.</p>
        ${sub === 'return' ? '<p class="alert err">Stripe still needs a few details. Pick up where you left off.</p>' : ''}
        <p class="alert err" id="ob-err" hidden></p>
        <button class="btn primary block" type="button" id="ob-go">Connect my bank with Stripe</button>
        <button class="linkbtn" type="button" id="ob-out">Log out</button>
      </section>`;
    const go = document.getElementById('ob-go');
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = 'Opening Stripe…';
      try { const { url } = await api('/api/stripe/connect', { method: 'POST' }); location.href = url; }
      catch (err) { flash(document.getElementById('ob-err'), err.message, 'err'); go.disabled = false; go.textContent = 'Connect my bank with Stripe'; }
    });
    document.getElementById('ob-out').addEventListener('click', logout);
  }
  async function logout() { await api('/api/logout', { method: 'POST' }); me = null; location.hash = '#/login'; showAuth('login'); }

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
              <span class="tag ${r.type}">${r.type === 'booking' ? esc(r.product_name ? 'Book: ' + r.product_name : 'Booking') : 'Repair'}</span>
              ${r.status === 'new' ? '<span class="tag new">New</span>' : `<span class="tag ${r.status}">${STATUS[r.status] || r.status}</span>`}
              ${r.has_photo ? '<span class="tag">Photo</span>' : ''}</div>
            <div class="small">${esc((r.location || '').split('\n')[0]).slice(0, 140)}</div>
            <div class="small muted">${esc(r.rig || '')}${r.rig && r.issue ? ' · ' : ''}${esc((r.issue || '').slice(0, 90))}${r.preferred_date ? ' · wants ' + esc(r.preferred_date) : ''}</div>
          </div>
          <div class="small muted" style="white-space:nowrap">${when(r.created_at)}</div>
        </a>`).join('') : '<p class="empty">Nothing here. Requests from your website show up here automatically.</p>'}
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
      try { const r = await api('/api/requests', { method: 'POST', body: Object.fromEntries(new FormData(f)) }); location.hash = '#/requests/' + r.id; }
      catch (err) { flash(document.getElementById('nr-err'), err.message, 'err'); }
    });
  }

  async function requestView(id) {
    setNav('requests');
    const [r, cfg] = await Promise.all([api('/api/requests/' + id), api('/api/config')]);
    const dep = cfg.settings.deposit_cents;
    const depPending = r.payments.filter((p) => p.kind === 'deposit' && p.status === 'pending');
    const online = cfg.stripe.online_ready;
    view.innerHTML = `
      <a href="#/requests" class="small">← Requests</a>
      <div class="row between">
        <div class="stack" style="gap:6px"><h1>${esc(r.name || 'No name')}</h1>
          <div class="row" style="gap:8px"><span class="tag ${r.type}">${r.type === 'booking' ? 'Booking' + (r.product ? ': ' + esc(r.product.name) + ' (' + money(r.product.price_cents) + ')' : '') : 'Repair request'}</span><span class="small muted">#${r.id} · ${when(r.created_at)}</span></div></div>
        <div><label for="rq-status" class="small">Status</label>
          <select id="rq-status" style="min-width:160px">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <a class="btn primary" href="${telHref(r.phone)}">Call ${esc(r.phone)}</a>
        <a class="btn" href="${smsHref(r.phone, `Hi ${r.name || ''}, this is ${bizName()}. I got your request and I'm on it.`)}">Text</a>
        <a class="btn ghost" href="${mapHref(r.location)}" target="_blank" rel="noopener">Map</a>
      </div>
      <p class="alert" id="rq-msg" hidden></p>
      <div class="grid2">
        <section class="card">
          <h2>Details</h2>
          <dl class="facts">
            <dt>Where</dt><dd>${esc(r.location)}</dd>
            ${r.rig ? `<dt>Vehicle</dt><dd>${esc(r.rig)}</dd>` : ''}
            ${r.issue ? `<dt>Problem</dt><dd>${esc(r.issue)}</dd>` : ''}
            ${r.preferred_date ? `<dt>Wants</dt><dd>${esc(r.preferred_date)}</dd>` : ''}
            ${r.email ? `<dt>Email</dt><dd>${esc(r.email)}</dd>` : ''}
          </dl>
          ${r.photo ? `<a href="/api/uploads/${esc(r.photo)}" target="_blank" rel="noopener"><img class="photo" style="margin-top:12px" src="/api/uploads/${esc(r.photo)}" alt="Photo sent by the customer"></a>` : ''}
          <div style="margin-top:14px"><label for="rq-notes">Your notes</label><textarea id="rq-notes" rows="3">${esc(r.notes || '')}</textarea>
          <button class="btn sm" id="rq-save-notes" type="button" style="margin-top:8px">Save notes</button></div>
        </section>
        <div class="stack">
          ${r.type === 'repair' && dep ? `
          <section class="card stack">
            <h2>${esc(cfg.settings.deposit_label)}, ${money(dep)}</h2>
            <p class="small muted">Paid up front and credited toward the job if the customer goes ahead.</p>
            ${r.deposit_paid_cents ? `<p class="alert ok">${money(r.deposit_paid_cents)} paid. It will be credited on the quote.</p>` : `
            <div class="row">
              ${online ? '<button class="btn primary" type="button" data-dep="card">Online payment link</button>' : ''}
              <button class="btn ghost" type="button" data-dep="cash">Got cash</button>
              <button class="btn ghost" type="button" data-dep="check">Got a check</button>
            </div>
            ${!online ? '<p class="small muted">Online payments start once direct deposit is set up. <a href="#/settings">See Settings.</a></p>' : ''}
            ${depPending.map((p) => payLinkBox(location.origin + '/pay/' + p.token, r.phone)).join('')}`}
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

  function payLinkBox(url, phone) {
    return `<div class="stack" style="gap:8px;border-top:1px solid var(--line);padding-top:12px">
      <p class="small"><strong>Payment link ready.</strong> Hand over your phone, or text it.</p>
      <div class="row">
        <a class="btn gold sm" href="${esc(url)}" target="_blank" rel="noopener">Open payment page</a>
        <a class="btn sm" href="${smsHref(phone, bizName() + ': here is your secure payment link: ' + url)}">Text link</a>
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
    const [q, products] = await Promise.all([api('/api/quotes/' + id), api('/api/products')]);
    const locked = Boolean(q.signed_at) || q.status === 'paid' || q.status === 'void';
    const items = q.items.map((it) => ({ ...it }));
    const active = products.filter((p) => p.active);

    view.innerHTML = `
      <a href="${q.request_id ? '#/requests/' + q.request_id : '#/quotes'}" class="small">← ${q.request_id ? 'Request #' + q.request_id : 'Quotes'}</a>
      <div class="row between"><h1>Quote #${q.id}</h1><span class="tag ${q.status}">${QSTATUS[q.status]}</span></div>
      <p class="alert" id="q-msg" hidden></p>
      ${q.signed_at ? `<p class="alert ok">Signed by ${esc(q.signer_name)} on ${esc(new Date(q.signed_at.replace(' ', 'T') + 'Z').toLocaleString())}. Signed quotes can’t be edited.</p>` : ''}
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
          <p class="small muted" id="fee-note"></p>
        </section>
        <div class="sticky-actions row">
          ${locked ? `<a class="btn primary" href="${esc(q.proposal_url)}" target="_blank" rel="noopener">Open proposal</a>` : '<button class="btn" type="submit">Save</button><button class="btn primary" type="button" id="q-show">Save and show proposal</button>'}
          <a class="btn ghost" href="${smsHref(q.customer_phone, bizName() + ': here is your proposal to review and sign: ' + q.proposal_url)}">Text link</a>
          <button class="btn ghost" type="button" data-copy="${esc(q.proposal_url)}">Copy link</button>
        </div>
      </form>
      <section class="card stack" id="q-pay"></section>`;

    const linesEl = document.getElementById('lines');
    const f = document.getElementById('qf');
    const msg = document.getElementById('q-msg');

    function totals() {
      const tax = toCents(f.elements.tax.value);
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
        ${t.credit ? `<dt>Deposit paid</dt><dd>−${money(t.credit)}</dd>` : ''}
        <dt class="big">Balance due</dt><dd class="big">${money(t.balance)}</dd>`;
      const o = q.online;
      document.getElementById('fee-note').textContent = o.card_payments && t.balance > 0
        ? `Paid online, the Processing Fee (${FEE_TEXT(o.bp)}) comes out of your payout. Cash or check: no fee.`
        : '';
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

    const pay = document.getElementById('q-pay');
    const paidList = q.payments.filter((p) => p.status === 'paid');
    pay.innerHTML = `
      <h2>Payment</h2>
      ${q.status === 'paid' ? `<p class="alert ok">Paid in full. ${paidList.map((p) => `${money(p.amount_cents)} by ${esc(p.method)}`).join(', ')}.</p>${paidList.filter((p) => p.method === 'card').map(payoutLine).join('')}` :
        q.signed_at ? `<p>Balance due: <strong>${money(q.totals.balance)}</strong>. ${q.online.card_payments ? 'The customer can pay online on the proposal page, or you can' : 'Online payments aren’t connected yet, so'} record cash or a check here.</p>
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

  function payoutLine(p) {
    if (p.method !== 'card') return '';
    if (!p.transfer_status || (p.transfer_status === 'pending' && !p.payout_cents)) return '<p class="small muted">Payout details appear once Stripe settles the payment.</p>';
    const st = p.transfer_status === 'sent' ? 'sent to your bank' : p.transfer_status === 'failed' ? 'delayed: support has been notified' : 'pending';
    return `<p class="small">Processing Fee ${money(p.stripe_fee_cents + p.fee_cents)} · Payout ${money(p.payout_cents)} ${st}</p>`;
  }

  // ---------- products ----------
  async function productsView() {
    setNav('products');
    const rows = await api('/api/products');
    const flags = (p) => `${p.active ? '' : '<span class="tag void">Hidden</span>'} ${p.on_site ? '<span class="tag">On website</span>' : ''} ${p.bookable ? '<span class="tag winterize">Bookable</span>' : ''} ${p.taxable ? '<span class="tag">Taxable</span>' : ''}`;
    view.innerHTML = `
      <h1>Products and services</h1>
      <p class="muted">These show up when you build a quote. Turn on “Show on website” to list one on your site, and “Customers can book it” for fixed-price packages.</p>
      <form class="card stack" id="pf">
        <h2>Add a product</h2>
        <div class="grid2">
          <div><label for="pf-name">Name</label><input id="pf-name" name="name" required></div>
          <div><label for="pf-price">Price ($)</label><input id="pf-price" name="price" inputmode="decimal" required placeholder="0.00"></div>
        </div>
        <div><label for="pf-desc">Description</label><input id="pf-desc" name="description"></div>
        <div class="row"><label class="check"><input type="checkbox" name="taxable"> Taxable</label><label class="check"><input type="checkbox" name="on_site"> Show on website</label><label class="check"><input type="checkbox" name="bookable"> Customers can book it</label></div>
        <p class="alert" id="pf-msg" hidden></p>
        <button class="btn primary" type="submit">Add product</button>
      </form>
      <div class="list">${rows.map((p) => `
        <div style="padding:14px 16px;border-bottom:1px solid var(--line)" data-pid="${p.id}">
          <div class="row between">
            <div class="grow"><span class="item-title">${esc(p.name)}</span> ${flags(p)}<div class="small muted">${esc(p.description || '')}</div></div>
            <strong>${money(p.price_cents)}</strong>
            <button class="btn ghost sm" type="button" data-edit="${p.id}">Edit</button>
          </div>
        </div>`).join('') || '<p class="empty">No products yet.</p>'}</div>`;
    const f = document.getElementById('pf');
    const el = f.elements;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/products', { method: 'POST', body: { name: el.name.value, description: el.description.value, price_cents: toCents(el.price.value), taxable: el.taxable.checked, on_site: el.on_site.checked, bookable: el.bookable.checked } }); productsView(); }
      catch (err) { flash(document.getElementById('pf-msg'), err.message, 'err'); }
    });
    view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const p = rows.find((x) => String(x.id) === b.dataset.edit);
      const box = view.querySelector(`[data-pid="${p.id}"]`);
      const ck = (n, l) => `<label class="check"><input type="checkbox" name="${n}" ${p[n] ? 'checked' : ''}> ${l}</label>`;
      box.innerHTML = `<form class="stack">
        <div class="grid2"><div><label for="e-n${p.id}">Name</label><input id="e-n${p.id}" name="name" value="${esc(p.name)}"></div>
        <div><label for="e-p${p.id}">Price ($)</label><input id="e-p${p.id}" name="price" inputmode="decimal" value="${dollars(p.price_cents)}"></div></div>
        <div><label for="e-d${p.id}">Description</label><input id="e-d${p.id}" name="description" value="${esc(p.description || '')}"></div>
        <div class="row">${ck('taxable', 'Taxable')}${ck('on_site', 'Show on website')}${ck('bookable', 'Customers can book it')}${ck('active', 'Available in quotes')}</div>
        <div class="row"><button class="btn primary sm" type="submit">Save</button><button class="btn ghost sm" type="button" data-cancel>Cancel</button></div></form>`;
      const ef = box.querySelector('form'), x = ef.elements;
      ef.querySelector('[data-cancel]').addEventListener('click', productsView);
      ef.addEventListener('submit', async (e) => {
        e.preventDefault();
        await api('/api/products/' + p.id, { method: 'PATCH', body: { name: x.name.value, description: x.description.value, price_cents: toCents(x.price.value), taxable: x.taxable.checked, on_site: x.on_site.checked, bookable: x.bookable.checked, active: x.active.checked } });
        productsView();
      });
    }));
  }

  // ---------- business, brand and website ----------
  async function businessView() {
    setNav('business');
    const [b, team] = await Promise.all([api('/api/business'), api('/api/team')]);
    const ro = isOwner() ? '' : 'disabled';
    const embed = `<meta name="rsqu-api" content="${location.origin}">\n<meta name="rsqu-business" content="${b.slug}">`;
    view.innerHTML = `
      <h1>Business and website</h1>
      <section class="card stack">
        <h2>Your website</h2>
        <p>Your hosted site: <a href="${esc(b.site_url)}" target="_blank" rel="noopener">${esc(b.site_url)}</a></p>
        <p class="small muted">Use your own domain: add a CNAME record pointing your domain (for example <code>www.yourbusiness.com</code>) at <code>${esc(location.host)}</code>, then enter the domain below. Agilities support can help.</p>
        <details><summary class="small" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Already have a website? Connect its request form</summary>
          <p class="small">Add these two lines to your site’s &lt;head&gt; and post forms to the address below. Agilities can set this up for you.</p>
          <textarea readonly rows="3" style="font-family:monospace;font-size:13px">${esc(embed)}</textarea>
          <p class="small">Form address: <code>${esc(b.intake_url)}</code></p></details>
      </section>
      <form class="stack" id="bf"><fieldset ${ro} style="border:0;padding:0;margin:0" class="stack">
        <section class="card stack">
          <h2>Business details</h2>
          <div class="grid2">
            <div><label for="b-name">Business name</label><input id="b-name" name="name" value="${esc(b.name)}"></div>
            <div><label for="b-phone">Public phone</label><input id="b-phone" name="phone" type="tel" value="${esc(b.phone)}"></div>
            <div><label for="b-email">Public email</label><input id="b-email" name="email" type="email" value="${esc(b.email)}"></div>
            <div><label for="b-notify">Text new requests to</label><input id="b-notify" name="notify_phone" type="tel" value="${esc(b.notify_phone)}" placeholder="+18015550100"></div>
          </div>
          <div><label for="b-area">Service area</label><input id="b-area" name="service_area" value="${esc(b.service_area)}"></div>
        </section>
        <section class="card stack">
          <h2>Brand</h2>
          <div class="grid2">
            <div><label for="b-pc">Main color</label><input id="b-pc" name="primary_color" type="color" value="${esc(b.primary_color)}" style="padding:4px;height:52px"></div>
            <div><label for="b-ac">Button color</label><input id="b-ac" name="accent_color" type="color" value="${esc(b.accent_color)}" style="padding:4px;height:52px"></div>
          </div>
          <div class="grid2">
            <div class="stack" style="gap:6px"><label for="b-logo">Logo</label>${b.logo ? `<img src="/media/${esc(b.slug)}/${esc(b.logo)}" alt="Current logo" style="max-height:64px;max-width:200px">` : ''}<input id="b-logo" type="file" accept="image/*" data-img="logo"></div>
            <div class="stack" style="gap:6px"><label for="b-photo">Owner or team photo</label>${b.owner_photo ? `<img src="/media/${esc(b.slug)}/${esc(b.owner_photo)}" alt="Current photo" style="max-height:120px;max-width:96px;object-fit:cover;border-radius:6px">` : ''}<input id="b-photo" type="file" accept="image/*" data-img="owner_photo"></div>
          </div>
        </section>
        <section class="card stack">
          <h2>Website text</h2>
          <div><label for="b-head">Headline</label><input id="b-head" name="hero_headline" value="${esc(b.hero_headline)}" placeholder="${esc(b.name)}"></div>
          <div><label for="b-tag">Tagline</label><input id="b-tag" name="tagline" value="${esc(b.tagline)}"></div>
          <div><label for="b-about">About</label><textarea id="b-about" name="about" rows="5">${esc(b.about)}</textarea></div>
          <div class="grid2">
            <div><label for="b-site">Your own website (if any)</label><input id="b-site" name="website_url" value="${esc(b.website_url)}" placeholder="https://"></div>
            <div><label for="b-dom">Custom domain for the hosted site</label><input id="b-dom" name="custom_domain" value="${esc(b.custom_domain)}" placeholder="www.yourbusiness.com"></div>
          </div>
        </section>
        <p class="alert" id="b-msg" hidden></p>
        ${ro ? '<p class="muted small">Only the business owner can change these.</p>' : '<div class="sticky-actions row"><button class="btn primary" type="submit">Save</button><a class="btn ghost" href="' + esc(b.site_url) + '" target="_blank" rel="noopener">View website</a></div>'}
      </fieldset></form>
      <section class="card stack">
        <h2>Team</h2>
        <div class="list">${team.map((u) => `<div class="row between" style="padding:12px 14px;border-bottom:1px solid var(--line)"><div><strong>${esc(u.name || u.email)}</strong> <span class="tag">${u.role === 'owner' ? 'Owner' : 'Staff'}</span><div class="small muted">${esc(u.email)}${u.last_login_at ? ' · last in ' + when(u.last_login_at) : ''}</div></div>${u.role === 'staff' && isOwner() ? `<button class="btn ghost sm" type="button" data-rm="${u.id}">Remove</button>` : ''}</div>`).join('')}</div>
        ${isOwner() ? `<form class="stack" id="tf"><h3>Add a team member</h3><div class="grid2"><div><label for="t-name">Name</label><input id="t-name" name="name"></div><div><label for="t-email">Email</label><input id="t-email" name="email" type="email" required></div><div><label for="t-pw">Temporary password</label><input id="t-pw" name="password" minlength="10" required></div></div><p class="alert" id="t-msg" hidden></p><button class="btn" type="submit">Add team member</button></form>` : ''}
      </section>`;
    const f = document.getElementById('bf'), msg = document.getElementById('b-msg');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/business', { method: 'PUT', body: Object.fromEntries(new FormData(f)) }); await loadMe(); buildChrome(); setNav('business'); flash(msg, 'Saved.'); }
      catch (err) { flash(msg, err.message, 'err'); }
    });
    view.querySelectorAll('[data-img]').forEach((inp) => inp.addEventListener('change', async () => {
      const image = await readImage(inp.files[0], inp.dataset.img === 'logo' ? 600 : 1200);
      if (!image) return flash(msg, 'Use a JPG, PNG or WebP image.', 'err');
      try { await api('/api/business/image', { method: 'POST', body: { kind: inp.dataset.img, image } }); await loadMe(); buildChrome(); businessView(); }
      catch (err) { flash(msg, err.message, 'err'); }
    }));
    const tf = document.getElementById('tf');
    if (tf) tf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/team', { method: 'POST', body: Object.fromEntries(new FormData(tf)) }); businessView(); }
      catch (err) { flash(document.getElementById('t-msg'), err.message, 'err'); }
    });
    view.querySelectorAll('[data-rm]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Remove this team member?')) return;
      await api('/api/team/' + btn.dataset.rm, { method: 'DELETE' }); businessView();
    }));
  }

  // ---------- settings ----------
  async function settingsView(sub) {
    setNav('settings');
    let cfg = await api('/api/config');
    if (cfg.stripe.account && !cfg.stripe.payouts_enabled) {
      try { await api('/api/stripe/refresh', { method: 'POST' }); cfg = await api('/api/config'); } catch { /* shown below */ }
    }
    const s = cfg.settings, st = cfg.stripe, pf = cfg.processing_fee;
    const ro = isOwner() ? '' : 'disabled';
    view.innerHTML = `
      <h1>Settings</h1>
      <section class="card stack">
        <h2>Direct deposit</h2>
        ${!st.platform_ready ? '<p>Online payments aren’t switched on yet. You’ll be notified when they are.</p>' :
          st.payouts_enabled ? `<p class="alert ok">Direct deposit is on. Online payments are paid out to your bank${st.test_mode ? ' (test mode: no real money moves)' : ''}.</p>` :
          st.details_submitted ? '<p class="alert ok">Details submitted. Stripe is verifying them; payouts start as soon as that’s done. Payments you take in the meantime are held and paid out then.</p>' :
          '<p>Connect your bank so online payments can be paid out to you.</p>'}
        ${isOwner() && st.platform_ready ? `<div class="row">${st.account && st.details_submitted ? '<button class="btn" type="button" id="bank">Update bank or tax details</button>' : ''}${!st.details_submitted ? '<button class="btn primary" type="button" id="connect">Set up direct deposit</button>' : ''}</div>` : ''}
        <p class="small muted">Processing Fee on online payments: ${FEE_TEXT(pf.bp)}, deducted before payout. Cash and check payments have no fee. <a href="/legal/payment-terms" target="_blank" rel="noopener">Payment terms</a></p>
        <p class="alert" id="st-msg" hidden></p>
        <div id="payouts"></div>
      </section>
      <form class="card stack" id="sf"><fieldset ${ro} style="border:0;padding:0;margin:0" class="stack">
        <h2>Quotes and deposits</h2>
        <div class="grid2">
          <div><label for="s-dlabel">Deposit name</label><input id="s-dlabel" name="dlabel" value="${esc(s.deposit_label)}"></div>
          <div><label for="s-dep">Deposit amount ($, 0 = no deposit)</label><input id="s-dep" name="dep" inputmode="decimal" value="${dollars(s.deposit_cents)}"></div>
          <div><label for="s-tax">Default sales tax % (taxable lines)</label><input id="s-tax" name="tax" inputmode="decimal" value="${s.tax_rate_bp / 100}"></div>
        </div>
        <div><label for="s-terms">Default terms on proposals</label><textarea id="s-terms" name="terms" rows="4">${esc(s.terms)}</textarea></div>
        <p class="alert" id="s-msg" hidden></p>
        ${ro ? '' : '<button class="btn primary" type="submit">Save settings</button>'}
      </fieldset></form>
      <section class="card stack">
        <h2>Text alerts</h2>
        <p>${cfg.sms_alerts ? 'On. You get a text for each new request, signature and payment.' : 'Off. Add a “Text new requests to” number on the Business page; Agilities turns on texting for the platform.'}</p>
      </section>
      <form class="card stack" id="pw"><h2>Change password</h2>
        <div class="grid2"><div><label for="pw-c">Current password</label><input id="pw-c" name="current" type="password" autocomplete="current-password"></div><div><label for="pw-n">New password</label><input id="pw-n" name="password" type="password" minlength="10" autocomplete="new-password"></div></div>
        <p class="alert" id="pw-msg" hidden></p><button class="btn" type="submit">Change password</button></form>
      <p class="small muted"><a href="/legal/terms" target="_blank" rel="noopener">Terms</a> · <a href="/legal/privacy" target="_blank" rel="noopener">Privacy</a> · <a href="/legal/payment-terms" target="_blank" rel="noopener">Payment terms</a></p>
      <button class="btn ghost" type="button" id="logout">Log out</button>`;
    const c = document.getElementById('connect');
    if (c) c.addEventListener('click', async () => {
      c.disabled = true; c.textContent = 'Opening Stripe…';
      try { const { url } = await api('/api/stripe/connect', { method: 'POST' }); location.href = url; }
      catch (err) { flash(document.getElementById('st-msg'), err.message, 'err'); c.disabled = false; c.textContent = 'Set up direct deposit'; }
    });
    const bank = document.getElementById('bank');
    if (bank) bank.addEventListener('click', async () => {
      try { const { url } = await api('/api/stripe/dashboard', { method: 'POST' }); window.open(url, '_blank', 'noopener'); }
      catch (err) { flash(document.getElementById('st-msg'), err.message, 'err'); }
    });
    api('/api/payments').then((rows) => {
      const online = rows.filter((p) => p.method === 'card');
      if (!online.length) return;
      document.getElementById('payouts').innerHTML = `<h3 style="margin-top:8px">Recent online payments</h3><table class="items"><thead><tr><th>Date</th><th class="num">Paid</th><th class="num">Processing Fee</th><th class="num">Payout</th></tr></thead><tbody>${online.slice(0, 20).map((p) => `<tr><td>${esc((p.paid_at || '').slice(0, 10))}<div class="small muted">${esc(p.description)}</div></td><td class="num">${money(p.amount_cents)}</td><td class="num">${money(p.stripe_fee_cents + p.fee_cents)}</td><td class="num">${money(p.payout_cents)}${p.transfer_status === 'sent' ? '' : `<div class="small muted">${esc(p.transfer_status || 'pending')}</div>`}</td></tr>`).join('')}</tbody></table>`;
    }).catch(() => {});
    const f = document.getElementById('sf'), el = f.elements;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/settings', { method: 'PUT', body: { deposit_label: el.dlabel.value, deposit_cents: toCents(el.dep.value), tax_rate_bp: toCents(el.tax.value), terms: el.terms.value } }); flash(document.getElementById('s-msg'), 'Saved.'); }
      catch (err) { flash(document.getElementById('s-msg'), err.message, 'err'); }
    });
    const pw = document.getElementById('pw');
    pw.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/password/change', { method: 'POST', body: Object.fromEntries(new FormData(pw)) }); pw.reset(); flash(document.getElementById('pw-msg'), 'Password changed.'); }
      catch (err) { flash(document.getElementById('pw-msg'), err.message, 'err'); }
    });
    document.getElementById('logout').addEventListener('click', logout);
  }

  // ---------- Agilities super admin ----------
  async function superView() {
    setNav('super');
    const d = await api('/api/super/overview');
    const t = d.totals;
    const stripeTag = (r) => r.stripe_payouts_enabled ? '<span class="tag paid">Payouts on</span>' : r.stripe_details_submitted ? '<span class="tag">Verifying</span>' : '<span class="tag void">No bank yet</span>';
    view.innerHTML = `
      <div class="row between"><h1>Businesses</h1><a class="btn ghost sm" href="/api/super/fees.csv">Download Processing Fees (CSV)</a></div>
      <div class="grid2">
        <section class="card"><p class="muted small">Platform share (3%) this month</p><p class="big-num">${money(t.fee_month_cents)}</p></section>
        <section class="card"><p class="muted small">Platform share all time</p><p class="big-num">${money(t.fee_cents)}</p><p class="small muted">Stripe fees passed through: ${money(t.stripe_fee_cents)}</p></section>
        <section class="card"><p class="muted small">Online payment volume</p><p class="big-num">${money(t.online_cents)}</p><p class="small muted">Paid out to businesses: ${money(t.payout_cents)}</p></section>
        <section class="card"><p class="muted small">Businesses</p><p class="big-num">${t.active} <span class="small muted">active of ${t.businesses}</span></p>${d.leads_new ? `<p class="small"><a href="#/leads">${d.leads_new} new lead${d.leads_new > 1 ? 's' : ''}</a></p>` : ''}</section>
      </div>
      ${!d.platform.stripe_ready ? '<p class="alert err">Stripe isn’t configured on the server yet (STRIPE_SECRET_KEY). Businesses can’t take online payments until it is.</p>' : d.platform.test_mode ? '<p class="alert ok">Stripe is in test mode.</p>' : ''}
      ${t.payouts_waiting ? `<p class="alert err">${t.payouts_waiting} payout${t.payouts_waiting > 1 ? 's are' : ' is'} waiting or failed. Open the business to retry.</p>` : ''}
      <form class="card stack" id="nb">
        <h2>Add a business</h2>
        <p class="small muted">Creates the account and gives you a setup link to send the owner. Owners can also sign up themselves at <a href="/signup">${esc(location.origin)}/signup</a>.</p>
        <div class="grid2"><div><label for="nb-biz">Business name</label><input id="nb-biz" name="business_name" required></div><div><label for="nb-name">Owner name</label><input id="nb-name" name="owner_name"></div><div><label for="nb-email">Owner email</label><input id="nb-email" name="owner_email" type="email" required></div><div><label for="nb-phone">Owner mobile</label><input id="nb-phone" name="phone" type="tel"></div></div>
        <p class="alert" id="nb-msg" hidden></p>
        <button class="btn primary" type="submit">Create business</button>
      </form>
      <div class="list">${d.tenants.map((r) => `
        <a class="item" href="#/super/${r.id}">
          <div class="grow stack" style="gap:4px">
            <div class="row" style="gap:8px"><span class="item-title">${esc(r.name)}</span>${r.status === 'active' ? '' : '<span class="tag new">Suspended</span>'}${stripeTag(r)}${r.fee_bp != null ? '<span class="tag">Custom fee</span>' : ''}${r.payouts_waiting ? '<span class="tag new">Payout waiting</span>' : ''}</div>
            <div class="small muted">${esc(r.owner_email || '')} · ${r.requests} requests · last login ${r.last_login_at ? when(r.last_login_at) : 'never'}</div>
          </div>
          <div class="stack" style="gap:2px;align-items:flex-end"><strong>${money(r.fee_cents)}</strong><span class="small muted">platform share · ${money(r.online_cents)} online</span></div>
        </a>`).join('') || '<p class="empty">No businesses yet.</p>'}</div>`;
    const f = document.getElementById('nb');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/super/tenants', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
        view.insertAdjacentHTML('afterbegin', `<section class="card stack"><p class="alert ok">${esc(r.tenant.name)} created.</p><p>Send the owner this link to set their password and accept the agreements (valid 7 days):</p><textarea readonly rows="2">${esc(r.setup_link)}</textarea><button class="btn sm" type="button" data-copy="${esc(r.setup_link)}">Copy link</button></section>`);
        view.querySelector('[data-copy]').addEventListener('click', (ev) => copy(r.setup_link, ev.target));
        f.reset();
      } catch (err) { flash(document.getElementById('nb-msg'), err.message, 'err'); }
    });
  }

  async function superTenantView(id) {
    setNav('super');
    const d = await api('/api/super/tenants/' + id);
    const t = d.tenant;
    view.innerHTML = `
      <a href="#/super" class="small">← Businesses</a>
      <div class="row between"><h1>${esc(t.name)}</h1><button class="btn primary" type="button" id="open">Open their dashboard</button></div>
      <p class="small"><a href="${esc(d.site_url)}" target="_blank" rel="noopener">${esc(d.site_url)}</a>${t.custom_domain ? ` · ${esc(t.custom_domain)}` : ''}</p>
      <p class="alert" id="st-msg" hidden></p>
      <div class="grid2">
        <form class="card stack" id="tf">
          <h2>Account</h2>
          <div><label for="t-status">Status</label><select id="t-status" name="status"><option value="active" ${t.status === 'active' ? 'selected' : ''}>Active</option><option value="suspended" ${t.status === 'suspended' ? 'selected' : ''}>Suspended</option></select></div>
          <div><label for="t-fee">Platform share % of the Processing Fee (blank = platform default)</label><input id="t-fee" name="fee" inputmode="decimal" value="${d.fee_bp == null ? '' : d.fee_bp / 100}"><p class="small muted">Processing Fee = Stripe’s actual fee + this %.</p></div>
          <div><label for="t-acct">Payout account (Stripe Express)</label><input id="t-acct" name="acct" value="${esc(t.stripe_account_id || '')}" placeholder="acct_…"><p class="small muted">${t.stripe_payouts_enabled ? 'Payouts on.' : t.stripe_details_submitted ? 'Submitted, Stripe is verifying.' : t.stripe_account_id ? 'Started, not finished.' : 'Not connected yet. The owner sets it up at sign-up.'}</p></div>
          <button class="btn primary" type="submit">Save</button>
        </form>
        <section class="card stack">
          <h2>People</h2>
          ${d.users.map((u) => `<div class="row between"><div><strong>${esc(u.name || u.email)}</strong> <span class="tag">${esc(u.role)}</span><div class="small muted">${esc(u.email)} · last in ${u.last_login_at ? when(u.last_login_at) : 'never'}</div></div><button class="btn ghost sm" type="button" data-reset="${u.id}">Reset link</button></div>`).join('')}
          <h2 style="margin-top:12px">Agreements</h2>
          ${d.agreements.length ? `<ul class="small" style="margin:0;padding-left:18px">${d.agreements.map((a) => `<li>${esc(a.doc)} v${esc(a.version)} · ${esc(a.email || '')} · ${esc(a.accepted_at)} · ${esc(a.ip || '')}</li>`).join('')}</ul>` : '<p class="small muted">Not accepted yet.</p>'}
        </section>
      </div>
      <section class="card stack">
        <h2>Payments</h2>
        ${d.payments.length ? `<div style="overflow-x:auto"><table class="items"><thead><tr><th>Date</th><th>For</th><th>Method</th><th class="num">Paid</th><th class="num">Stripe fee</th><th class="num">Platform</th><th class="num">Payout</th><th>Payout status</th></tr></thead><tbody>${d.payments.map((p) => `<tr><td>${esc((p.paid_at || p.created_at).slice(0, 10))}${p.status === 'paid' ? '' : ' <span class="tag">' + esc(p.status) + '</span>'}</td><td>${esc(p.description)}</td><td>${esc(p.method)}</td><td class="num">${money(p.amount_cents)}</td><td class="num">${money(p.stripe_fee_cents)}</td><td class="num">${money(p.fee_cents)}</td><td class="num">${money(p.payout_cents)}</td><td>${p.method === 'card' && p.status === 'paid' ? `${esc(p.transfer_status || 'pending')}${p.transfer_error ? `<div class="small muted">${esc(p.transfer_error)}</div>` : ''}${p.transfer_status !== 'sent' ? ` <button class="btn ghost sm" type="button" data-settle="${p.id}">Retry</button>` : ''}` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No payments yet.</p>'}
      </section>`;
    const msg = document.getElementById('st-msg');
    document.getElementById('open').addEventListener('click', async () => { await api('/api/super/view-as', { method: 'POST', body: { tenant_id: t.id } }); await loadMe(); location.hash = '#/requests'; route(); });
    const f = document.getElementById('tf'), el = f.elements;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/super/tenants/' + id, { method: 'PATCH', body: { status: el.status.value, fee_bp: el.fee.value.trim() === '' ? null : toCents(el.fee.value), stripe_account_id: el.acct.value } });
        await superTenantView(id); flash(document.getElementById('st-msg'), 'Saved.');
      } catch (err) { flash(msg, err.message, 'err'); }
    });
    view.querySelectorAll('[data-settle]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await api(`/api/super/payments/${b.dataset.settle}/settle`, { method: 'POST' }); await superTenantView(id); flash(document.getElementById('st-msg'), r.transfer_status === 'sent' ? 'Payout sent.' : `Still ${r.transfer_status}: ${r.transfer_error || ''}`, r.transfer_status === 'sent' ? 'ok' : 'err'); }
      catch (err) { flash(msg, err.message, 'err'); b.disabled = false; }
    }));
    view.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      const r = await api(`/api/super/users/${b.dataset.reset}/reset-link`, { method: 'POST' });
      await copy(r.link); flash(msg, `Reset link for ${r.email} copied. It works for 7 days.`);
    }));
  }

  async function platformView() {
    setNav('platform');
    const d = await api('/api/super/overview');
    const p = d.platform;
    view.innerHTML = `
      <h1>Platform</h1>
      <form class="card stack" id="pf">
        <h2>Processing Fee</h2>
        <p class="small muted">Every online payment is charged on the platform Stripe account. Before payout, the platform keeps Stripe’s actual fee plus this %. Businesses see the total as “Processing Fee”; customers pay only the amount due.</p>
        <div style="max-width:260px"><label for="p-fee">Platform share %</label><input id="p-fee" name="fee" inputmode="decimal" value="${p.fee_bp / 100}"></div>
        <p class="alert" id="p-msg" hidden></p>
        <button class="btn primary" type="submit">Save</button>
      </form>
      <section class="card stack">
        <h2>Services</h2>
        <dl class="facts"><dt>Stripe</dt><dd>${p.stripe_ready ? (p.test_mode ? 'Key set (test mode)' : 'Key set (live)') : 'Not configured'}</dd><dt>Text alerts</dt><dd>${p.sms ? 'On (Twilio)' : 'Off'}</dd><dt>Email</dt><dd>${p.email ? 'On (password resets)' : 'Off: send reset links by hand from a business page'}</dd></dl>
      </section>
      <section class="card stack">
        <h2>Check Stripe connection</h2>
        <p class="small muted">Asks Stripe to confirm the key on the server works.</p>
        <div><button class="btn" type="button" id="stripe-check">Check Stripe connection</button></div>
        <p class="alert" id="sc-msg" hidden></p>
      </section>
      <section class="card stack"><h2>Legal</h2><p class="small"><a href="/legal/terms" target="_blank" rel="noopener">Business Terms</a> · <a href="/legal/privacy" target="_blank" rel="noopener">Privacy</a> · <a href="/legal/payment-terms" target="_blank" rel="noopener">Payment terms</a> · <a href="/legal/customer-terms" target="_blank" rel="noopener">Customer terms</a></p></section>
      <button class="btn ghost" type="button" id="logout">Log out</button>`;
    const f = document.getElementById('pf');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/super/settings', { method: 'PUT', body: { fee_bp: toCents(f.elements.fee.value) } }); flash(document.getElementById('p-msg'), 'Saved.'); }
      catch (err) { flash(document.getElementById('p-msg'), err.message, 'err'); }
    });
    const sc = document.getElementById('stripe-check');
    sc.addEventListener('click', async () => {
      sc.disabled = true; sc.textContent = 'Checking…';
      const r = await api('/api/super/stripe-check', { method: 'POST' }).catch((e) => ({ ok: false, error: e.message }));
      const m = document.getElementById('sc-msg');
      m.className = 'alert ' + (r.ok ? 'ok' : 'err');
      m.textContent = r.ok ? `Connected to Stripe account ${r.name ? '“' + r.name + '” ' : ''}(${r.account_id}) in ${r.test_mode ? 'TEST mode, no real money moves' : 'LIVE mode'}.` : r.error;
      m.hidden = false;
      sc.disabled = false; sc.textContent = 'Check Stripe connection';
    });
    document.getElementById('logout').addEventListener('click', logout);
  }

  async function leadsView() {
    setNav('leads');
    const rows = await api('/api/super/leads');
    const LS = { new: 'New', contacted: 'Contacted', signed_up: 'Signed up', closed: 'Closed' };
    view.innerHTML = `
      <h1>Leads</h1>
      <p class="muted">Repair business owners who asked to talk on the ${PLATFORM} website. Send them to <a href="/signup">${esc(location.origin)}/signup</a>, or create their business from Businesses.</p>
      <div class="list">${rows.map((l) => `
        <div style="padding:14px 16px;border-bottom:1px solid var(--line)" class="stack">
          <div class="row between"><div><span class="item-title">${esc(l.name)}</span> ${l.business_name ? `<span class="small muted">· ${esc(l.business_name)}</span>` : ''} <span class="tag ${l.status === 'new' ? 'new' : ''}">${LS[l.status] || esc(l.status)}</span><div class="small muted">${esc(l.location || '')}${l.certifications ? ' · ' + esc(l.certifications) : ''} · ${when(l.created_at)}</div></div>
            <select data-lead="${l.id}" aria-label="Status for ${esc(l.name)}" style="width:auto;min-width:150px">${Object.entries(LS).map(([k, v]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          ${l.message ? `<p class="small" style="white-space:pre-wrap">${esc(l.message)}</p>` : ''}
          <div class="row">${l.phone ? `<a class="btn sm" href="${telHref(l.phone)}">Call ${esc(l.phone)}</a><a class="btn ghost sm" href="${smsHref(l.phone, `Hi ${l.name}, this is ${PLATFORM}. Thanks for reaching out! Here's the link to get started: ${location.origin}/signup`)}">Text</a>` : ''}${l.email ? `<a class="btn ghost sm" href="mailto:${esc(l.email)}?subject=${encodeURIComponent(PLATFORM + ': getting your RV repair business set up')}">Email</a>` : ''}</div>
        </div>`).join('') || '<p class="empty">No leads yet.</p>'}</div>`;
    view.querySelectorAll('[data-lead]').forEach((sel) => sel.addEventListener('change', () => api('/api/super/leads/' + sel.dataset.lead, { method: 'PATCH', body: { status: sel.value } })));
  }

  // ---------- router ----------
  async function loadMe() { me = await api('/api/me', { quiet: true }).catch(() => ({ authed: false })); if (!me.authed) me = null; return me; }
  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [a, b] = h.split('/');
    if (a === 'reset' && b) return showAuth('reset', b);
    if (!me) await loadMe();
    if (!me) return showAuth(['signup', 'forgot'].includes(a) ? a : 'login');
    if (me.needs_agreements) return agreementsView();
    if (me.needs_payout_setup) return onboardingView(a === 'onboarding' ? b : '');
    if (me.tenant && me.tenant.status !== 'active' && !isSuper()) { showChrome(false); view.innerHTML = '<section class="card login stack"><h1>Account suspended</h1><p>Contact Agilities support to restore access.</p><button class="btn ghost" type="button" id="lo">Log out</button></section>'; document.getElementById('lo').addEventListener('click', logout); return; }
    showChrome(true); buildChrome();
    try {
      if (!me.tenant) {
        if (a === 'super' && b) await superTenantView(b);
        else if (a === 'platform') await platformView();
        else if (a === 'leads') await leadsView();
        else await superView();
      } else if (a === 'requests' && b === 'new') newRequestView();
      else if (a === 'requests' && b) await requestView(b);
      else if (a === 'quotes' && b) await quoteView(b);
      else if (a === 'quotes') await quotesView();
      else if (a === 'products') await productsView();
      else if (a === 'business') await businessView();
      else if (a === 'settings') await settingsView(b);
      else await requestsView();
      window.scrollTo(0, 0);
    } catch (err) {
      if (err.message !== 'Please log in.') view.innerHTML = `<p class="alert err">${esc(err.message)}</p><a href="#/">Back</a>`;
    }
  }
  window.addEventListener('hashchange', route);
  route();

  // Check for new requests every 30 seconds.
  setInterval(async () => {
    if (!me || !me.tenant || document.getElementById('topbar').hidden) return;
    try {
      const d = await api('/api/requests?filter=new', { quiet: true });
      if (d.counts.new > newCount && 'Notification' in window && Notification.permission === 'granted') new Notification('New request', { body: d.rows[0] ? `${d.rows[0].name || 'Customer'}: ${(d.rows[0].location || '').slice(0, 80)}` : '' });
      setNewCount(d.counts.new);
    } catch { /* offline */ }
  }, 30000);
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => { if (me && me.tenant) Notification.requestPermission(); }, { once: true });
  }
})();
