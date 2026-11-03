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
  const isAffiliateUser = () => me && me.user.role === 'affiliate'; // a referral partner with no business
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
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.data = data; throw e; }
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
  // alpha: keep PNG/WebP transparency (logos, tiles); job photos always become JPEG to stay small.
  function readImage(file, max = 1600, alpha = true) {
    return new Promise((resolve) => {
      if (!file) return resolve(null);
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve(c.toDataURL(alpha && /^image\/(png|webp)$/.test(file.type) ? 'image/png' : 'image/jpeg', 0.85));
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
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>',
    share: '<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>',
    grid: '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>',
  };
  const svg = (k) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  function buildChrome() {
    const affMode = isAffiliateUser();
    const tenantMode = Boolean(me.tenant);
    const items = affMode ? [['affiliate', 'Referrals', 'share'], ['account', 'Account', 'settings']]
      : tenantMode
        ? [['requests', 'Requests', 'requests'], ['schedule', 'Schedule', 'calendar'], ['quotes', 'Quotes', 'quotes'], ['business', 'Business', 'business'], ['settings', 'Settings', 'settings']]
        : [['super', 'Businesses', 'grid'], ['leads', 'Leads', 'requests'], ['affiliates', 'Affiliates', 'share'], ['platform', 'Platform', 'settings']];
    const badge = (k) => (k === 'requests' ? '<span class="badge" data-newcount hidden></span>' : '');
    document.getElementById('topnav').innerHTML = items.map(([k, l]) => `<a href="#/${k}" data-nav="${k}">${l} ${badge(k)}</a>`).join('');
    const bn = document.getElementById('bottomnav');
    bn.style.gridTemplateColumns = `repeat(${items.length}, 1fr)`;
    bn.innerHTML = items.map(([k, l, ic]) => `<a href="#/${k}" data-nav="${k}">${svg(ic)}${l}${badge(k)}</a>`).join('');
    const logo = me.tenant && me.tenant.logo ? `<img src="/media/${esc(me.tenant.slug)}/${esc(me.tenant.logo)}" alt="" style="height:34px;border-radius:4px;background:#fff">` : '';
    document.getElementById('brand').innerHTML = `${logo}<span>${esc(tenantMode ? me.tenant.name : PLATFORM)}<small>${tenantMode ? PLATFORM + ' dashboard' : affMode ? 'Referral program' : 'Agilities admin'}</small></span>`;
    document.getElementById('brand').setAttribute('href', tenantMode ? '#/requests' : affMode ? '#/affiliate' : '#/super');
    const top = document.getElementById('topbar');
    top.style.background = tenantMode ? (me.tenant.primary_color || '') : '#1F1C17';
    const va = document.getElementById('viewas');
    va.hidden = !me.viewing_as;
    if (me.viewing_as) {
      va.innerHTML = `<span>Agilities admin, viewing <strong>${esc(me.tenant.name)}</strong></span><button type="button" class="btn sm gold" id="exit-viewas">Back to all businesses</button>`;
      document.getElementById('exit-viewas').addEventListener('click', async () => { await api('/api/super/view-as', { method: 'POST', body: { tenant_id: 0 } }); location.hash = '#/super'; await loadMe(); route(); });
    }
    document.title = affMode ? `${PLATFORM} referrals` : bizName();
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
          <p class="muted">Your branded website, job inbox, onsite quotes, e-signatures and online payments to your own Stripe account. No monthly fee.</p>
          <div><label for="a-biz">Business name</label><input id="a-biz" name="business_name" required autocomplete="organization"></div>
          <div><label for="a-name">Your name</label><input id="a-name" name="name" required autocomplete="name"></div>
          <div><label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>
          <div><label for="a-phone">Mobile phone (for request alerts)</label><input id="a-phone" name="phone" type="tel" autocomplete="tel"></div>
          <div><label for="a-pw">Password (10+ characters)</label><input id="a-pw" name="password" type="password" minlength="10" required autocomplete="new-password"></div>
          <div><label for="a-ref">Referral code (optional)</label><input id="a-ref" name="referral_code" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false"><p class="small muted" id="a-ref-note" hidden></p></div>
          <label class="check"><input type="checkbox" name="agree" required> <span>I agree to the ${LEGAL}, including the Processing Fee on online payments (Stripe’s fee, billed by Stripe, plus ${PLATFORM}’s 3%). My business is the seller and merchant of record for its own sales.</span></label>
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
    if (mode === 'signup') prefillReferral();
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
    const legacy = me.tenant && me.tenant.stripe_account_id && me.tenant.stripe_account_type !== 'v2_merchant';
    view.innerHTML = `
      <section class="card login stack" style="max-width:540px">
        ${brandHead}
        <h1>${legacy ? 'Move payments to your own Stripe account' : 'Connect your Stripe account'}</h1>
        ${legacy ? '<p class="alert ok">Customers now pay your business directly, so your business is the seller of record for its own sales. Connect your own Stripe account to keep taking online payments. Payments you already received still pay out to your old account.</p>' : ''}
        <p>Your customers pay <strong>your business</strong> directly through your own Stripe account, and Stripe pays out to your bank. Your business name appears on their card statement, and you handle your own refunds, disputes and sales tax from your Stripe Dashboard. It takes about 10 minutes.</p>
        <p class="small"><strong>Have ready:</strong> your legal or business name, EIN or SSN, business address, bank routing and account numbers, and a photo ID.</p>
        <p class="small muted">Processing Fee on each online payment: Stripe’s fee (billed to you by Stripe) plus ${PLATFORM}’s 3%. Cash and check payments have no fee. See the <a href="/legal/payment-terms" target="_blank" rel="noopener">Payment Processing and Fee Terms</a>.</p>
        ${sub === 'return' ? '<p class="alert err">Stripe still needs a few details. Pick up where you left off.</p>' : ''}
        <p class="alert err" id="ob-err" hidden></p>
        <button class="btn primary block" type="button" id="ob-go">Connect with Stripe</button>
        <button class="linkbtn" type="button" id="ob-out">Log out</button>
      </section>`;
    const go = document.getElementById('ob-go');
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = 'Opening Stripe…';
      try { const { url } = await api('/api/stripe/connect', { method: 'POST' }); location.href = url; }
      catch (err) { flash(document.getElementById('ob-err'), err.message, 'err'); go.disabled = false; go.textContent = 'Connect with Stripe'; }
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
    installTip();
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
        <a class="btn ghost" href="#/schedule/new/request/${r.id}">Schedule this job</a>
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
            ${!online ? '<p class="small muted">Online payments start once your Stripe account can take card payments and you’ve approved your <a href="#/terms">customer Terms &amp; Conditions</a>.</p>' : ''}
            ${depPending.map((p) => payLinkBox(location.origin + '/pay/' + p.token, r.phone)).join('')}`}
          </section>` : ''}
          <section class="card stack">
            <div class="row between"><h2>Quotes</h2><div class="row"><a class="btn" href="#/quotes/photo/${r.id}">Quote from photos</a><button class="btn primary" id="rq-quote" type="button">Build a quote</button></div></div>
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
      <div class="row between"><h1>Quotes</h1><div class="row"><a class="btn ghost sm" href="#/customers">Customers</a><a class="btn sm" href="#/quotes/photo">+ From photos</a><button class="btn sm" id="q-inv" type="button">+ New invoice</button><button class="btn primary sm" id="q-new" type="button">+ New quote</button></div></div>
      <div class="list">${rows.length ? rows.map((q) => `
        <a class="item" href="#/quotes/${q.id}">
          <div class="grow"><div class="item-title">${esc(q.customer_name || 'No name')}</div><div class="small muted">${q.kind === 'invoice' ? '<span class="tag">Invoice</span> ' : ''}${esc(q.title)} · #${q.id} · ${when(q.created_at)}</div></div>
          <div class="stack" style="gap:4px;align-items:flex-end"><strong>${money(q.totals.total)}</strong><span class="tag ${q.status}">${QSTATUS[q.status]}</span></div>
        </a>`).join('') : '<p class="empty">No quotes yet. Tap “From photos” to snap the problem and get a draft, or open a request and tap “Build a quote”.</p>'}</div>`;
    document.getElementById('q-new').addEventListener('click', async () => { const q = await api('/api/quotes', { method: 'POST', body: {} }); location.hash = '#/quotes/' + q.id; });
    document.getElementById('q-inv').addEventListener('click', async () => { const q = await api('/api/invoices', { method: 'POST', body: {} }); location.hash = '#/quotes/' + q.id; });
  }

  async function quoteView(id) {
    setNav('quotes');
    const [q, products] = await Promise.all([api('/api/quotes/' + id), api('/api/products')]);
    const locked = Boolean(q.signed_at) || q.status === 'paid' || q.status === 'void';
    const items = q.items.map((it) => ({ ...it }));
    const active = products.filter((p) => p.active);
    const inv = q.kind === 'invoice', noun = inv ? 'invoice' : 'proposal';

    view.innerHTML = `
      <a href="${q.request_id ? '#/requests/' + q.request_id : '#/quotes'}" class="small">← ${q.request_id ? 'Request #' + q.request_id : 'Quotes'}</a>
      <div class="row between"><h1>${inv ? 'Invoice' : 'Quote'} #${q.id}</h1><span class="tag ${q.status}">${QSTATUS[q.status]}</span></div>
      ${q.status !== 'void' ? `<div class="row"><a class="btn ghost sm" href="#/schedule/new/quote/${q.id}">Schedule this job</a></div>` : ''}
      <p class="alert" id="q-msg" hidden></p>
      ${inv && !locked ? '<p class="small muted">No signature needed. Your customer pays from the invoice page, which shows your Terms &amp; Conditions. Or record cash or a check below.</p>' : ''}
      ${q.signed_at ? `<p class="alert ok">Signed by ${esc(q.signer_name)} on ${esc(new Date(q.signed_at.replace(' ', 'T') + 'Z').toLocaleString())}. Signed quotes can’t be edited.</p>` : ''}
      ${aiCard(q, locked)}
      <form id="qf" class="stack">
        <fieldset ${locked ? 'disabled' : ''} style="border:0;padding:0;margin:0" class="stack">
        <section class="card stack">
          <h2>Customer</h2>
          <div class="grid2">
            <div><label for="q-title">${inv ? 'Invoice title' : 'Proposal title'}</label><input id="q-title" name="title" value="${esc(q.title)}"></div>
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
          ${locked ? `<a class="btn primary" href="${esc(q.proposal_url)}" target="_blank" rel="noopener">Open ${noun}</a>` : `<button class="btn" type="submit">Save</button><button class="btn primary" type="button" id="q-show">Save and show ${noun}</button>`}
          <a class="btn ghost" href="${smsHref(q.customer_phone, bizName() + (inv ? ': here is your invoice: ' : ': here is your proposal to review and sign: ') + q.proposal_url)}">Text link</a>
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
          <div class="field"><label class="small" for="ln-p${i}">Price each${!it.unit_cents && !locked ? ' <span class="tag new">Set a price</span>' : ''}</label><input id="ln-p${i}" data-k="price" inputmode="decimal" value="${dollars(it.unit_cents)}" ${!it.unit_cents && !locked ? 'aria-invalid="true"' : ''}></div>
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
      body.photos = [...view.querySelectorAll('[data-photo]')].map((cb) => ({ file: cb.dataset.photo, show: cb.checked }));
      return api('/api/quotes/' + id, { method: 'PUT', body });
    }
    f.addEventListener('submit', async (e) => { e.preventDefault(); try { await save(); await quoteView(id); flash(document.getElementById('q-msg'), 'Saved.'); } catch (err) { flash(msg, err.message, 'err'); } });
    const show = document.getElementById('q-show');
    if (show) show.addEventListener('click', async () => {
      if (items.some((it) => it.name.trim() && !it.unit_cents) && !confirm(`Some lines are $0. Show the ${noun} anyway?`)) return;
      const w = window.open('', '_blank');
      try { const saved = await save(); if (w) w.location = saved.proposal_url; else location.href = saved.proposal_url; quoteView(id); }
      catch (err) { if (w) w.close(); flash(msg, err.message, 'err'); }
    });
    view.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));
    renderLines();

    const pay = document.getElementById('q-pay');
    const paidList = q.payments.filter((p) => p.status === 'paid');
    // Payments that don't match what was owed (paid after a void, paid twice, too much or too little).
    const attention = paidList.filter((p) => p.note).map((p) => `<p class="alert err"><strong>Needs your attention:</strong> ${money(p.amount_cents)} ${p.method === 'card' ? 'paid online' : `paid by ${esc(p.method)}`} ${esc(when(p.paid_at))}. ${esc(p.note)}</p>`).join('');
    pay.innerHTML = `
      <h2>Payment</h2>
      ${attention}
      ${q.status === 'paid' ? `<p class="alert ok">Paid in full. ${paidList.map((p) => `${money(p.amount_cents)} by ${esc(p.method)}`).join(', ')}.</p>${paidList.filter((p) => p.method === 'card').map(payoutLine).join('')}` :
        q.status === 'void' ? `<p class="muted">This ${inv ? 'invoice' : 'quote'} is void.</p>` :
        q.signed_at || inv ? `<p>${q.paid_cents ? `Already paid: ${money(q.paid_cents)}. ` : ''}Balance due: <strong>${money(q.due_cents)}</strong>. ${q.online.card_payments ? `The customer can pay online on the ${noun} page, or you can` : 'Online payments aren’t connected yet, so'} record cash or a check here.</p>
        <div class="row"><button class="btn ghost" type="button" data-paid="cash">Got cash</button><button class="btn ghost" type="button" data-paid="check">Got a check</button></div>` :
        '<p class="muted">The customer signs the proposal first, then pays.</p>'}
      ${q.status !== 'paid' ? `<div class="row" style="border-top:1px solid var(--line);padding-top:12px">${q.status === 'void' ? (q.signed_at ? '' : `<button class="linkbtn" type="button" data-st="draft">Restore ${inv ? 'invoice' : 'quote'}</button>`) : `<button class="linkbtn" type="button" data-st="void">Void this ${inv ? 'invoice' : 'quote'}</button>`}</div>` : ''}`;
    pay.querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm(`Record ${money(q.due_cents)} paid by ${b.dataset.paid}?`)) return;
      try { await api(`/api/quotes/${id}/payments`, { method: 'POST', body: { method: b.dataset.paid } }); quoteView(id); } catch (err) { flash(msg, err.message, 'err'); }
    }));
    pay.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.st === 'void' && !confirm(`Void this ${inv ? 'invoice' : 'quote'}? The customer link will stop working.`)) return;
      try { await api(`/api/quotes/${id}/status`, { method: 'POST', body: { status: b.dataset.st } }); quoteView(id); } catch (err) { flash(msg, err.message, 'err'); }
    }));
  }

  // Photos and the AI draft notes on a quote (notes are for the technician; photos can show on the proposal).
  function aiCard(q, locked) {
    const ai = q.ai_draft;
    if (!q.photos.length && !ai) return '';
    const list = (title, xs, cls = '') => (xs && xs.length ? `<div class="${cls}"><h3>${title}</h3><ul class="small" style="margin:4px 0 0;padding-left:20px">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
    const status = !ai ? '' : ai.error === 'not_configured' ? '<p class="small muted">Photos saved. Automatic drafting isn’t switched on yet, so add the lines yourself.</p>'
      : ai.error ? `<p class="alert err">Couldn’t draft from the photos (${esc(ai.error)}). Your photos are saved; add the lines yourself.</p>`
      : `<p class="small">Drafted from your photos. Check every line and price before you send it.${ai.needs_price && ai.needs_price.length ? ` <strong>${ai.needs_price.length} line${ai.needs_price.length === 1 ? '' : 's'} aren’t on your price list and need a price.</strong>` : ''}${ai.estimates && ai.estimates.length ? ' Labor hours are an estimate.' : ''}</p>`;
    return `<section class="card stack">
      <h2>Photos${ai && !ai.error ? ' and draft notes' : ''}</h2>
      ${status}
      ${ai && ai.safety && ai.safety.length ? `<div class="alert err"><strong>Safety:</strong> ${ai.safety.map(esc).join(' ')}</div>` : ''}
      ${q.photos.length ? `<div class="row" style="gap:12px;align-items:flex-start">${q.photos.map((ph) => `<figure style="margin:0;width:140px"><a href="/api/uploads/${esc(ph.file)}" target="_blank" rel="noopener"><img src="/api/uploads/${esc(ph.file)}" alt="Job photo" style="width:140px;height:105px;object-fit:cover;border-radius:6px;display:block"></a><label class="check small" style="margin-top:4px"><input type="checkbox" data-photo="${esc(ph.file)}" form="qf" ${ph.show ? 'checked' : ''} ${locked ? 'disabled' : ''}> Show on proposal</label></figure>`).join('')}</div>` : ''}
      ${ai && !ai.error ? `<div class="grid2">${list('What the photos show', ai.findings)}${list('Check before sending', ai.questions)}</div>` : ''}
      ${ai && ai.note ? `<p class="small muted">Your note: ${esc(ai.note)}</p>` : ''}
    </section>`;
  }

  // Snap the problem, get a draft proposal.
  async function photoQuoteView(requestId) {
    setNav('quotes');
    const r = requestId ? await api('/api/requests/' + requestId).catch(() => null) : null;
    const req = r && (r.request || r);
    const photos = [];
    view.innerHTML = `
      <a href="${requestId ? '#/requests/' + esc(requestId) : '#/quotes'}" class="small">← ${requestId ? 'Request #' + esc(requestId) : 'Quotes'}</a>
      <h1>Quote from photos</h1>
      <section class="card stack">
        <p>Take up to 4 photos of the problem: the damage up close, then the area around it, plus any model or serial plate. You’ll get a draft proposal using your price list, and you edit everything before the customer sees it.</p>
        <div><button class="btn primary" type="button" id="pq-pick">Take or choose photos</button><input id="pq-files" type="file" accept="image/*" multiple hidden></div>
        <div class="row" id="pq-thumbs" style="gap:10px"></div>
        <div><label for="pq-rig">Year, make and model</label><input id="pq-rig" maxlength="200" value="${esc(req?.rig || '')}" placeholder="2019 Jayco Jay Flight 264BH"></div>
        <div><label for="pq-note">What’s going on? (optional)</label><textarea id="pq-note" rows="3" maxlength="1000" placeholder="Customer says the awning won’t retract; the arm is bent at the elbow.">${esc(req?.issue || '')}</textarea></div>
        <p class="alert" id="pq-msg" hidden></p>
        <div><button class="btn primary" type="button" id="pq-go" disabled>Draft the proposal</button></div>
      </section>`;
    const thumbs = document.getElementById('pq-thumbs'), go = document.getElementById('pq-go'), msg = document.getElementById('pq-msg');
    const draw = () => {
      thumbs.innerHTML = photos.map((d, i) => `<figure style="margin:0;position:relative"><img src="${d}" alt="Photo ${i + 1}" style="width:110px;height:82px;object-fit:cover;border-radius:6px;display:block"><button type="button" class="btn ghost sm" data-rm="${i}" aria-label="Remove photo ${i + 1}" style="margin-top:4px">Remove</button></figure>`).join('');
      go.disabled = !photos.length;
    };
    document.getElementById('pq-pick').addEventListener('click', () => document.getElementById('pq-files').click());
    document.getElementById('pq-files').addEventListener('change', async (e) => {
      for (const f of [...e.target.files]) {
        if (photos.length >= 4) { flash(msg, 'Up to 4 photos. Remove one to add another.', 'err'); break; }
        const d = await readImage(f, 1568, false);
        if (d) photos.push(d); else flash(msg, 'That file isn’t a photo we can read. Use JPG or PNG.', 'err');
      }
      e.target.value = ''; draw();
    });
    thumbs.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { photos.splice(Number(b.dataset.rm), 1); draw(); } });
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = 'Drafting… this takes about 20 seconds';
      try {
        const q = await api('/api/quotes/from-photos', { method: 'POST', body: { request_id: requestId ? Number(requestId) : null, photos, rig: document.getElementById('pq-rig').value, note: document.getElementById('pq-note').value } });
        location.hash = '#/quotes/' + q.id;
      } catch (err) { flash(msg, err.message, 'err'); go.disabled = false; go.textContent = 'Draft the proposal'; }
    });
  }

  // Everyone who signed a proposal, and what they agreed to receive.
  async function customersView() {
    setNav('quotes');
    const rows = await api('/api/customers');
    const yes = (on, at) => (on ? `<span class="tag" style="background:#DDF3E6;color:#14532D">Yes</span>${at ? `<div class="small muted">${when(at)}</div>` : ''}` : '<span class="small muted">No</span>');
    view.innerHTML = `
      <a href="#/quotes" class="small">← Quotes</a>
      <div class="row between"><h1>Customers</h1><div class="row">${isOwner() ? '<a class="btn primary sm" href="#/emails">Email subscribers</a>' : ''}${rows.length ? '<a class="btn sm" href="/api/customers.csv">Download CSV</a>' : ''}</div></div>
      <p class="small muted">Customers are added when they sign a proposal. Email updates are on unless they uncheck the box; texts only if they check that box. Every email you send them must include an unsubscribe link, and texts must honor STOP.</p>
      <div class="table-wrap" style="overflow-x:auto"><table class="items" style="min-width:640px">
        <thead><tr><th scope="col">Name</th><th scope="col">Phone</th><th scope="col">Email</th><th scope="col">Email updates</th><th scope="col">Texts</th><th scope="col">From</th></tr></thead>
        <tbody>${rows.map((c) => `<tr><td>${esc(c.name || '')}</td><td>${esc(c.phone || '')}</td><td>${esc(c.email || '')}</td><td>${yes(c.email_opt_in, c.email_consent_at)}</td><td>${yes(c.sms_opt_in, c.sms_consent_at)}</td><td class="small">${esc(c.source || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No customers yet.</td></tr>'}</tbody>
      </table></div>`;
  }

  function payoutLine(p) {
    if (p.method !== 'card') return '';
    if (!p.transfer_status || (p.transfer_status === 'pending' && !p.payout_cents)) return '<p class="small muted">Payout details appear once Stripe settles the payment.</p>';
    const st = p.transfer_status === 'direct' ? 'in your Stripe balance' : p.transfer_status === 'sent' ? 'sent to your bank' : p.transfer_status === 'failed' ? 'delayed: support has been notified' : 'pending';
    return `<p class="small">Processing Fee ${money(p.stripe_fee_cents + p.fee_cents)} · You receive ${money(p.payout_cents)} ${st}</p>`;
  }

  // ---------- products ----------
  async function productsView() {
    setNav('business');
    const rows = await api('/api/products');
    const flags = (p) => `${p.active ? '' : '<span class="tag void">Hidden</span>'} ${p.on_site ? '<span class="tag">On website</span>' : ''} ${p.bookable ? '<span class="tag winterize">Bookable</span>' : ''} ${p.taxable ? '<span class="tag">Taxable</span>' : ''} ${p.image ? '<span class="tag">Tile picture</span>' : ''} ${p.details && p.on_site ? '<span class="tag">Own page</span>' : ''}`;
    view.innerHTML = `
      <a href="#/business" class="small">← Business</a>
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
        <details ${p.details || p.image ? 'open' : ''}><summary class="small" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Website extras: tile picture, order, its own page</summary>
          <div class="stack" style="margin-top:8px">
            <div class="row" style="align-items:center">${p.image ? `<img src="/media/${esc(me.tenant.slug)}/${esc(p.image)}" alt="" style="width:88px;height:88px;object-fit:contain;background:#1B1C1F;border-radius:8px">` : ''}
              <button class="btn sm" type="button" data-img-pick>${p.image ? 'Replace tile picture' : 'Add tile picture'}</button>${p.image ? '<button class="btn ghost sm" type="button" data-img-rm>Remove picture</button>' : ''}<input type="file" accept="image/*" hidden data-img-file></div>
            <p class="small muted">Square pictures work best. They show as tiles under the banner in the Bold look.</p>
            <div style="max-width:200px"><label for="e-s${p.id}">Order on website</label><input id="e-s${p.id}" name="sort" inputmode="numeric" value="${p.sort || 0}"><p class="small muted">Lower numbers show first.</p></div>
            <div><label for="e-x${p.id}">Write-up for its own page (optional)</label><textarea id="e-x${p.id}" name="details" rows="6" maxlength="8000" placeholder="What’s included, common problems you fix, what to expect. Start a line with “- ” for a bullet or “## ” for a heading.">${esc(p.details || '')}</textarea>
            <p class="small muted">With a write-up and “Show on website” on, this service gets its own page that Google can find.</p></div>
          </div></details>
        <div class="row"><button class="btn primary sm" type="submit">Save</button><button class="btn ghost sm" type="button" data-cancel>Cancel</button></div></form>`;
      const pickBtn = box.querySelector('[data-img-pick]'), fileIn = box.querySelector('[data-img-file]'), rmBtn = box.querySelector('[data-img-rm]');
      pickBtn.addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', async () => {
        const image = await readImage(fileIn.files[0], 600);
        if (!image) return;
        try { await api(`/api/products/${p.id}/image`, { method: 'POST', body: { image } }); productsView(); } catch (err) { alert(err.message); }
      });
      if (rmBtn) rmBtn.addEventListener('click', async () => { try { await api(`/api/products/${p.id}/image`, { method: 'POST', body: { image: null } }); productsView(); } catch (err) { alert(err.message); } });
      const ef = box.querySelector('form'), x = ef.elements;
      ef.querySelector('[data-cancel]').addEventListener('click', productsView);
      ef.addEventListener('submit', async (e) => {
        e.preventDefault();
        await api('/api/products/' + p.id, { method: 'PATCH', body: { name: x.name.value, description: x.description.value, price_cents: toCents(x.price.value), taxable: x.taxable.checked, on_site: x.on_site.checked, bookable: x.bookable.checked, active: x.active.checked, sort: Number(x.sort.value) || 0, details: x.details.value } });
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
        <h2>Get found on Google</h2>
        <p>Add the cities you serve, your hours, certifications, FAQs, videos and customer checklists. Each city gets its own page, and your site tells Google exactly where you work.</p>
        <div><a class="btn primary" href="#/website">Edit website sections</a></div>
      </section>
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
    if (isOwner()) affiliateCard();
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

    ownerBusinessExtras();
  }

  // ---------- website sections and local search ----------
  async function websiteView() {
    setNav('business');
    const st = await api('/api/website');
    const owner = isOwner();
    const P = st.profile;
    const stateOpts = (v) => `<option value="">State</option>${st.states.map((x) => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('')}`;
    const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
    const done = st.checklist.filter((c) => c.done).length;
    const rm = '<button class="btn ghost sm" type="button" data-remove>Remove</button>';
    const rows = {
      city: (c = {}, url = '') => {
        const link = url ? `<a class="small" href="${esc(url)}" target="_blank" rel="noopener">View page</a>` : '<span></span>';
        return `<div class="card stack" data-row="cities" style="box-shadow:none;border:1px solid var(--line)">
          <div class="grid2"><div><label>City</label><input data-f="name" data-k="name" maxlength="80" value="${esc(c.name)}" placeholder="Ogden"></div><div><label>State</label><select data-f="state" data-k="state">${stateOpts(c.state)}</select></div></div>
          <div><label>About your work in this city</label><textarea data-f="intro" data-k="intro" rows="3" maxlength="2000" placeholder="Campgrounds, RV parks and roads you know there, typical arrival time, common repairs…">${esc(c.intro)}</textarea>
          <p class="small muted" data-count></p></div>
          <div class="row between">${link}${rm}</div></div>`;
      },
      cred: (c = {}) => `<div class="grid2" data-row="credentials" style="align-items:end"><div><label>Certification or credential</label><input data-f="title" data-k="title" maxlength="120" value="${esc(c.title)}" placeholder="RVTI Certified Technician, Level 2"></div><div><label>Details (optional)</label><input data-f="detail" maxlength="300" value="${esc(c.detail)}" placeholder="Since 2015 · NRVTA graduate"></div><div>${rm}</div></div>`,
      faq: (f = {}) => `<div class="stack" data-row="faqs" style="border-bottom:1px solid var(--line);padding-bottom:12px"><div><label>Question</label><input data-f="q" maxlength="200" value="${esc(f.q)}" placeholder="Do you come to campgrounds?"></div><div><label>Answer</label><textarea data-f="a" rows="2" maxlength="1500">${esc(f.a)}</textarea></div><div>${rm}</div></div>`,
      hl: (h = {}) => `<div class="grid2" data-row="highlights" style="align-items:end;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr))"><div><label>Icon</label><select data-f="icon">${st.icons.map((k) => `<option value="${k}" ${h.icon === k ? 'selected' : ''}>${({ tools: 'Tools', shield: 'Shield', gear: 'Gear', pin: 'Map pin', clock: 'Clock', star: 'Star', phone: 'Phone', truck: 'Truck' })[k]}</option>`).join('')}</select></div><div><label>Title</label><input data-f="title" data-k="title" maxlength="40" value="${esc(h.title)}" placeholder="On-site service"></div><div><label>Line under it</label><input data-f="text" maxlength="80" value="${esc(h.text)}" placeholder="At your location"></div><div>${rm}</div></div>`,
      video: (v = {}) => `<div class="grid2" data-row="videos" style="align-items:end"><div><label>YouTube link</label><input data-f="url" data-k="url" maxlength="300" value="${v.id ? 'https://youtu.be/' + esc(v.id) : ''}" placeholder="https://youtu.be/…"></div><div><label>Title</label><input data-f="title" maxlength="120" value="${esc(v.title)}" placeholder="Water heater repair at a campground"></div><div>${rm}</div></div>`,
    };
    const hoursRow = ([k, label]) => {
      const h = P.hours.days[k];
      return `<div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));align-items:end" data-day="${k}">
        <div><strong>${label}</strong><label class="check small"><input type="checkbox" data-closed ${h ? '' : 'checked'}> Closed</label></div>
        <div><label for="h-${k}-o">Opens</label><input id="h-${k}-o" type="time" data-open value="${h ? h.open : '08:00'}" data-k="hours.${k}"></div>
        <div><label for="h-${k}-c">Closes</label><input id="h-${k}-c" type="time" data-close value="${h ? h.close : '17:00'}"></div></div>`;
    };
    const linkField = (k, label, hint) => `<div><label for="l-${k}">${label}</label><input id="l-${k}" data-link="${k}" data-k="links.${k}" maxlength="400" value="${esc(P.links[k] || '')}" placeholder="https://"><p class="small muted">${hint}</p></div>`;

    view.innerHTML = `
      <p><a href="#/business">‹ Business and website</a></p>
      <h1>Website sections and Google search</h1>
      <section class="card stack">
        <div class="row between"><h2>Local search checklist</h2><strong>${done} of ${st.checklist.length} done</strong></div>
        <ul class="stack" style="list-style:none;padding:0;margin:0;gap:10px">${st.checklist.map((c) => `<li class="row" style="gap:10px;align-items:flex-start;flex-wrap:nowrap"><span aria-hidden="true" style="flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-content:center;font-size:13px;font-weight:700;${c.done ? 'background:#1E7B4A;color:#fff' : 'border:2px solid var(--line)'}">${c.done ? '✓' : ''}</span><span><strong>${esc(c.label)}</strong>${c.done ? ' <span class="sr-only">(done)</span>' : ''}<br><span class="small muted">${esc(c.why)}</span></span></li>`).join('')}</ul>
        <p class="small muted">Your phone, About text and services are on the <a href="#/business">Business page</a> and <a href="#/products">Products</a>. Use the same business name and phone number here as on your Google Business Profile.</p>
        <div><a class="btn ghost" href="${esc(st.site_url)}" target="_blank" rel="noopener">View your website</a></div>
      </section>
      <form class="stack" id="wf"><fieldset ${owner ? '' : 'disabled'} style="border:0;padding:0;margin:0" class="stack">
        <section class="card stack">
          <h2>Look</h2>
          <div class="row" role="radiogroup" aria-label="Site look">
            <label class="check"><input type="radio" name="theme" value="classic" ${P.theme !== 'bold' ? 'checked' : ''}> <span><strong>Classic</strong><br><span class="small muted">Light, with the request form beside your headline.</span></span></label>
            <label class="check"><input type="radio" name="theme" value="bold" ${P.theme === 'bold' ? 'checked' : ''}> <span><strong>Bold</strong><br><span class="small muted">Dark menu bar, a big banner picture, service tiles with pictures, and a highlights bar.</span></span></label>
          </div>
          <h3>Banner picture (Bold look)</h3>
          <p class="small muted">A wide picture across the top, about 1536 × 515 pixels. Add a tighter, squarer crop for phones if the wide one gets too small.</p>
          <div id="banner"></div>
          <div><label for="w-balt">Describe the banner for people who can’t see it</label><input id="w-balt" maxlength="200" value="${esc(P.banner.alt)}" placeholder="${esc(st.business.name)} logo over an RV in the mountains"></div>
          <h3>Highlights bar (Bold look)</h3>
          <p class="small muted">Up to 4 short selling points under the service tiles. Service tile pictures are set on each product in <a href="#/products">Products</a>.</p>
          <div class="stack" id="hls">${P.highlights.map((h) => rows.hl(h)).join('')}</div>
          <div><button class="btn ghost" type="button" data-add="hl">+ Add a highlight</button></div>
        </section>
        <section class="card stack">
          <h2>Where you work</h2>
          <div><label for="w-phrase">What you do, in the words customers search</label><input id="w-phrase" data-k="service_phrase" maxlength="60" value="${esc(P.service_phrase)}" placeholder="Mobile RV repair"><p class="small muted">Used in page titles, like “Mobile RV repair in Ogden, UT”.</p></div>
          <div class="grid2">
            <div><label for="w-city">Base city</label><input id="w-city" data-k="base_city" maxlength="80" value="${esc(P.base_city)}" placeholder="Morgan"></div>
            <div><label for="w-state">State</label><select id="w-state" data-k="base_state">${stateOpts(P.base_state)}</select></div>
            <div><label for="w-radius">How far you travel (miles)</label><input id="w-radius" data-k="radius_miles" inputmode="numeric" value="${P.radius_miles || ''}" placeholder="60"></div>
          </div>
          <h3>Cities you serve</h3>
          <p class="small muted">Up to ${st.limits.cities}. Each gets its own page. Write a few sentences for each one; pages with at least ${st.city_intro_min} characters of your own words are offered to Google, so they don’t look like copies of each other.</p>
          <div class="stack" id="cities">${P.cities.map((c, i) => rows.city(c, st.city_urls[i])).join('')}</div>
          <div><button class="btn ghost" type="button" data-add="city">+ Add a city</button></div>
        </section>
        <section class="card stack">
          <h2>Hours</h2>
          <label class="check"><input type="checkbox" id="w-247" ${P.hours.always_open ? 'checked' : ''}> Open 24 hours, 7 days a week</label>
          <div class="stack" id="days" ${P.hours.always_open ? 'hidden' : ''}>${DAYS.map(hoursRow).join('')}</div>
          <div><label for="w-hnote">Note (optional)</label><input id="w-hnote" maxlength="200" value="${esc(P.hours.note)}" placeholder="Emergency calls answered after hours"></div>
        </section>
        <section class="card stack">
          <h2>Certifications and experience</h2>
          <div class="stack" id="creds">${P.credentials.map((c) => rows.cred(c)).join('')}</div>
          <div><button class="btn ghost" type="button" data-add="cred">+ Add a credential</button></div>
        </section>
        <section class="card stack">
          <h2>Questions customers ask (FAQ)</h2>
          <p class="small muted">Answer what people ask on the phone: pricing, how fast you come, which RVs you work on, whether you come to campgrounds.</p>
          <div class="stack" id="faqs">${P.faqs.map((f) => rows.faq(f)).join('')}</div>
          <div><button class="btn ghost" type="button" data-add="faq">+ Add a question</button></div>
        </section>
        <section class="card stack">
          <h2>Videos</h2>
          <p class="small muted">Paste links to your YouTube videos. Short repair walk-throughs work well.</p>
          <div class="stack" id="videos">${P.videos.map((v) => rows.video(v)).join('')}</div>
          <div><button class="btn ghost" type="button" data-add="video">+ Add a video</button></div>
        </section>
        <section class="card stack">
          <h2>Google and social links</h2>
          ${linkField('google_profile', 'Google Business Profile link', 'Search your business name on Google, click your listing, then Share and copy the link.')}
          ${linkField('google_review', 'Google review link', 'On your Business Profile, click “Ask for reviews” and copy the link. Adds a “Review us on Google” button.')}
          ${linkField('youtube', 'YouTube channel', '')}
          <div class="grid2">${linkField('facebook', 'Facebook page', '')}${linkField('instagram', 'Instagram', '')}</div>
        </section>
        <section class="card stack">
          <h2>Google Search Console</h2>
          <p class="small">Shows which searches bring people to your site. In <a href="https://search.google.com/search-console" target="_blank" rel="noopener">Search Console</a>, add your site as a <strong>URL prefix</strong> using the address <code>${esc(st.site_url)}</code>, choose <strong>HTML tag</strong>, and paste the tag here.</p>
          <div><label for="w-sc">Verification tag</label><input id="w-sc" data-k="search_console" maxlength="300" value="${esc(P.search_console)}" placeholder='<meta name="google-site-verification" content="…">'></div>
        </section>
        <section class="card stack">
          <h2>Checklists and guides (PDFs)</h2>
          <p class="small muted">Files customers can download and print from your site. Up to ${st.limits.resources}, 10 MB each.</p>
          <div class="stack" id="docs"></div>
          ${owner ? `<div class="stack" style="border-top:1px solid var(--line);padding-top:14px"><h3>Add a PDF</h3><div class="grid2"><div><label for="d-title">Title</label><input id="d-title" maxlength="120" placeholder="Black and grey tank checklist"></div><div><label for="d-desc">Short description (optional)</label><input id="d-desc" maxlength="300"></div></div><div><label for="d-file">PDF file</label><input id="d-file" type="file" accept="application/pdf"></div><div><button class="btn" type="button" id="d-up">Upload PDF</button></div><p class="alert" id="d-msg" hidden></p></div>` : ''}
        </section>
        <p class="alert" id="w-msg" hidden></p>
        ${owner ? '<div class="sticky-actions row"><button class="btn primary" type="submit">Save</button></div>' : '<p class="muted small">Only the business owner can change these.</p>'}
      </fieldset></form>`;

    // Repeated rows are built from templates; give each label its own field.
    let uid = 0;
    const linkLabels = (root) => root.querySelectorAll('label:not([for]):not(.check)').forEach((l) => {
      const inp = l.nextElementSibling;
      if (inp && /^(INPUT|SELECT|TEXTAREA)$/.test(inp.tagName)) { if (!inp.id) inp.id = 'wf-' + (++uid); l.htmlFor = inp.id; }
    });
    linkLabels(view);
    const lists = { city: 'cities', cred: 'creds', faq: 'faqs', video: 'videos', hl: 'hls' };
    const countCity = (row) => {
      const n = row.querySelector('[data-f=intro]').value.trim().length;
      row.querySelector('[data-count]').textContent = n >= st.city_intro_min ? `${n} characters. Offered to Google.` : `${n} of ${st.city_intro_min} characters. Not offered to Google yet.`;
    };
    const f = document.getElementById('wf'), msg = document.getElementById('w-msg');
    // Uploads and deletes redraw only this list, so unsaved edits elsewhere on the page stay put.
    const renderDocs = (files, urls) => {
      const box = document.getElementById('docs');
      box.innerHTML = files.map((r) => `<div class="grid2" data-doc="${esc(r.file)}" style="align-items:end"><div><label>Title</label><input data-f="title" maxlength="120" value="${esc(r.title)}"></div><div><label>Short description</label><input data-f="description" maxlength="300" value="${esc(r.description)}"></div><div class="row"><a class="btn ghost sm" href="${esc(urls[r.file])}" target="_blank" rel="noopener">Open</a>${owner ? `<button class="btn ghost sm" type="button" data-del="${esc(r.file)}">Delete</button>` : ''}</div></div>`).join('') || '<p class="muted small">No files yet.</p>';
      linkLabels(box);
    };
    renderDocs(P.resources, st.file_urls);
    // Banner uploads redraw only this box, so unsaved edits elsewhere stay put.
    const renderBanner = (urls) => {
      const box = document.getElementById('banner');
      const one = (kind, label) => `<div class="stack" style="gap:6px"><strong>${label}</strong>${urls[kind] ? `<img src="${esc(urls[kind])}" alt="" style="max-width:100%;max-height:160px;object-fit:contain;border-radius:6px;background:#111">` : '<p class="small muted">None yet.</p>'}
        ${owner ? `<div class="row"><button class="btn sm" type="button" data-bpick="${kind}">${urls[kind] ? 'Replace' : 'Upload'}</button>${urls[kind] ? `<button class="btn ghost sm" type="button" data-bdel="${kind}">Remove</button>` : ''}<input type="file" accept="image/*" hidden data-bfile="${kind}"></div>` : ''}</div>`;
      box.innerHTML = `<div class="grid2">${one('desktop', 'Wide (computers)')}${one('mobile', 'Phones (optional)')}</div><p class="alert" id="b-msg" hidden></p>`;
    };
    renderBanner(st.banner_urls);
    document.getElementById('banner').addEventListener('click', async (e) => {
      const pick = e.target.closest('[data-bpick]'); const del = e.target.closest('[data-bdel]');
      if (pick) document.querySelector(`[data-bfile="${pick.dataset.bpick}"]`).click();
      if (del) { try { const ns = await api('/api/website/banner/' + del.dataset.bdel, { method: 'DELETE' }); renderBanner(ns.banner_urls); } catch (err) { flash(document.getElementById('b-msg'), err.message, 'err'); } }
    });
    document.getElementById('banner').addEventListener('change', async (e) => {
      const inp = e.target.closest('[data-bfile]'); if (!inp || !inp.files[0]) return;
      const image = await readImage(inp.files[0], inp.dataset.bfile === 'desktop' ? 2400 : 1200);
      if (!image) return flash(document.getElementById('b-msg'), 'Use a JPG, PNG or WebP image.', 'err');
      try { const ns = await api('/api/website/banner', { method: 'POST', body: { kind: inp.dataset.bfile, image } }); renderBanner(ns.banner_urls); }
      catch (err) { flash(document.getElementById('b-msg'), err.message, 'err'); }
    });
    view.querySelectorAll('[data-row=cities]').forEach(countCity);
    f.addEventListener('input', (e) => { const r = e.target.closest('[data-row=cities]'); if (r) countCity(r); });
    f.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Delete for good?'; return; }
        try { const ns = await api('/api/website/resources/' + encodeURIComponent(del.dataset.del), { method: 'DELETE' }); renderDocs(ns.profile.resources, ns.file_urls); }
        catch (err) { flash(msg, err.message, 'err'); }
        return;
      }
      const add = e.target.closest('[data-add]');
      if (add) { const box = document.getElementById(lists[add.dataset.add]); box.insertAdjacentHTML('beforeend', rows[add.dataset.add]()); const r = box.lastElementChild; linkLabels(r); if (add.dataset.add === 'city') countCity(r); r.querySelector('input,select,textarea').focus(); }
      const rmb = e.target.closest('[data-remove]');
      if (rmb) rmb.closest('[data-row]').remove();
    });
    document.getElementById('w-247').addEventListener('change', (e) => { document.getElementById('days').hidden = e.target.checked; });

    const collect = (name) => [...view.querySelectorAll(`[data-row=${name}]`)].map((r) => Object.fromEntries([...r.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i.value])));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      view.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
      const days = {};
      view.querySelectorAll('[data-day]').forEach((d) => { if (!d.querySelector('[data-closed]').checked) days[d.dataset.day] = { open: d.querySelector('[data-open]').value, close: d.querySelector('[data-close]').value }; });
      const body = {
        service_phrase: document.getElementById('w-phrase').value, base_city: document.getElementById('w-city').value, base_state: document.getElementById('w-state').value, radius_miles: document.getElementById('w-radius').value.trim(),
        cities: collect('cities'), credentials: collect('credentials'), faqs: collect('faqs'), videos: collect('videos'), highlights: collect('highlights'),
        theme: (view.querySelector('input[name=theme]:checked') || {}).value || 'classic', banner: { alt: document.getElementById('w-balt').value },
        hours: { always_open: document.getElementById('w-247').checked, note: document.getElementById('w-hnote').value, days },
        links: Object.fromEntries([...view.querySelectorAll('[data-link]')].map((i) => [i.dataset.link, i.value])),
        search_console: document.getElementById('w-sc').value,
        resources: [...view.querySelectorAll('[data-doc]')].map((d) => ({ file: d.dataset.doc, title: d.querySelector('[data-f=title]').value, description: d.querySelector('[data-f=description]').value })),
      };
      try { await api('/api/website', { method: 'PUT', body }); await websiteView(); flash(document.getElementById('w-msg'), 'Saved. Your website is updated.'); }
      catch (err) {
        const fe = err.data && err.data.field_errors;
        if (!fe) return flash(msg, err.message, 'err');
        const names = { cities: 'City', credentials: 'Credential', faqs: 'Question', videos: 'Video', highlights: 'Highlight' };
        const lines = Object.entries(fe).map(([k, v]) => {
          const [sec, idx, field] = k.split('.');
          if (names[sec] && /^\d+$/.test(idx || '')) {
            const row = view.querySelectorAll(`[data-row=${sec}]`)[Number(idx)];
            const inp = row && (row.querySelector(`[data-k="${field}"]`) || row.querySelector('[data-f]'));
            if (inp) inp.setAttribute('aria-invalid', 'true');
            return `${names[sec]} ${Number(idx) + 1}: ${v}`;
          }
          const inp = view.querySelector(`[data-k="${k}"]`); if (inp) inp.setAttribute('aria-invalid', 'true');
          return v;
        });
        flash(msg, 'Please fix: ' + lines.join(' '), 'err');
        const first = view.querySelector('[aria-invalid]'); if (first) first.focus();
      }
    });

    const up = document.getElementById('d-up');
    if (up) up.addEventListener('click', async () => {
      const dm = document.getElementById('d-msg'), file = document.getElementById('d-file').files[0], title = document.getElementById('d-title').value.trim();
      if (!title) return flash(dm, 'Give the file a title customers will recognize.', 'err');
      if (!file || file.type !== 'application/pdf') return flash(dm, 'Choose a PDF file.', 'err');
      if (file.size > 10_000_000) return flash(dm, 'That PDF is larger than 10 MB. Save a smaller copy and try again.', 'err');
      const data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(null); r.readAsDataURL(file); });
      up.disabled = true; up.textContent = 'Uploading…';
      try {
        const ns = await api('/api/website/resources', { method: 'POST', body: { title, description: document.getElementById('d-desc').value, file: data } });
        renderDocs(ns.profile.resources, ns.file_urls);
        ['d-title', 'd-desc', 'd-file'].forEach((id) => { document.getElementById(id).value = ''; });
        flash(dm, 'Uploaded. It’s on your website now.');
      } catch (err) { flash(dm, err.message, 'err'); }
      up.disabled = false; up.textContent = 'Upload PDF';
    });
  }

  // ---------- affiliates (referral revenue share) ----------
  // Dates are kept in UTC on the server (holds and click days count in UTC), so they're shown in UTC too.
  const affDate = (s) => (s ? new Date(String(s).replace(' ', 'T') + (/Z$/.test(s) ? '' : 'Z')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const smoney = (c) => (c < 0 ? '-' : '') + money(Math.abs(c || 0));
  const signedCents = (v) => { const n = Math.round(parseFloat(String(v).replace(/[^0-9.-]/g, '')) * 100); return Number.isFinite(n) ? n : 0; };
  const shareLine = (a, lead = 'You earn') => `${lead} ${pct(a.share_bp)} of the fee ${PLATFORM} keeps on card payments from each business you refer, ${a.months ? `for ${a.months} month${a.months === 1 ? '' : 's'} after it signs up` : `for as long as it uses ${PLATFORM}`}.`;
  const affStat = (label, value, sub = '') => `<section class="card"><p class="muted small">${label}</p><p class="big-num">${value}</p>${sub ? `<p class="small muted">${sub}</p>` : ''}</section>`;
  // A table that becomes stacked rows on phones. cols: [label, className?]; rows: arrays of cell HTML.
  const affTable = (cols, rows, empty) => rows.length
    ? `<table class="items stack-sm"><thead><tr>${cols.map(([l, c]) => `<th scope="col"${c ? ` class="${c}"` : ''}>${l}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((cell, i) => `<td data-label="${esc(cols[i][0])}"${cols[i][1] ? ` class="${cols[i][1]}"` : ''}><div>${cell}</div></td>`).join('')}</tr>`).join('')}</tbody></table>`
    : `<p class="small muted">${empty}</p>`;
  const REF_STATE = { taking_payments: '<span class="tag paid">Taking payments</span>', setting_up: '<span class="tag">Setting up</span>', inactive: '<span class="tag void">Not active</span>' };
  const PAY_METHOD = { ach: 'ACH', check: 'check', stripe: 'Stripe', other: 'other' };
  const ledgerWhat = (l) => ({
    earnings: `Your share of ${PLATFORM}’s fees`,
    earning: `Your share of ${PLATFORM}’s fee`,
    reversal: `Taken back: ${(l.note || 'correction').toLowerCase()}`,
    adjustment: `Adjustment${l.note ? ': ' + l.note : ''}`,
    payout: `Paid to you by ${PAY_METHOD[l.method || l.payout_method] || 'payout'}${l.reference ? ` (${l.reference})` : ''}`,
  }[l.type] || l.type);
  const ledgerStatus = (l) => (l.type === 'payout' ? '<span class="tag">Paid out</span>'
    : l.status === 'paid' ? '<span class="tag">Paid</span>'
      : l.status === 'partly_paid' ? '<span class="tag">Partly paid</span>'
        : l.status === 'available' ? '<span class="tag paid">Available</span>'
          : l.status === 'partly_available' ? '<span class="tag paid">Partly available</span>'
            : `<span class="tag">Pending</span>${l.available_at ? `<div class="small muted">until ${esc(affDate(l.available_at))}</div>` : ''}`);
  const monthLabel = (m) => new Date(m + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  // Sign-up form: fill in the referral code from the link cookie or ?ref.
  async function prefillReferral() {
    const box = document.getElementById('a-ref'), note = document.getElementById('a-ref-note');
    if (!box) return;
    box.addEventListener('input', () => { note.hidden = true; });
    const q = new URLSearchParams(location.search).get('ref') || '';
    const d = await api('/api/public/referral' + (q ? '?code=' + encodeURIComponent(q) : ''), { quiet: true }).catch(() => null);
    if (!d || !d.code || box.value) return;
    box.value = d.code;
    note.textContent = `Referred by ${d.name}`; note.hidden = false;
  }

  // Business page: a card for businesses in the referral program.
  async function affiliateCard() {
    const d = await api('/api/affiliate', { quiet: true }).catch(() => null);
    const h1 = view.querySelector('h1');
    if (!d || !d.affiliate || !h1 || !/^#\/business\b/.test(location.hash)) return;
    h1.insertAdjacentHTML('afterend', `<section class="card stack"><h2>Refer businesses, earn a share</h2><p>${esc(shareLine(d.affiliate, 'Earn'))}</p><div><a class="btn primary" href="#/affiliate">${d.affiliate.link ? 'Open your referral page' : 'Get your referral link'}</a></div></section>`);
  }

  function affTermsCard(A, first) {
    const body = isSuper() ? '<p class="small muted">Only the business owner can accept these terms.</p>' : `
      <label class="check"><input type="checkbox" id="aff-agree"> <span>I have read and agree to the <a href="${esc(A.terms.url)}" target="_blank" rel="noopener">Affiliate Program Terms</a>${A.kind === 'business' ? ' for my business' : ''}.</span></label>
      <p class="alert err" id="aff-terms-err" hidden></p>
      <div><button class="btn primary" type="button" id="aff-accept">${first ? 'Accept and get my link' : 'Accept the new terms'}</button></div>`;
    return `<section class="card stack">
      <h2>${first ? 'Before you start' : 'We updated the Affiliate Program Terms'}</h2>
      ${first ? `<p>${esc(shareLine(A))}</p>
      <ul class="stack small" style="margin:0;padding-left:20px;gap:4px">
        <li>New earnings are held for ${A.hold_days} days in case of refunds.</li>
        <li>We pay monthly once you have ${money(A.min_payout_cents)} or more and we have your W-9 and payout details.</li>
        <li>When you share your link, tell people you earn a share.</li>
        <li>No spam texts or emails, and no ads on the ${PLATFORM} name.</li>
      </ul>` : '<p>Please read and accept them to keep earning.</p>'}
      ${body}
    </section>`;
  }
  function wireTermsCard() {
    const btn = document.getElementById('aff-accept');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const err = document.getElementById('aff-terms-err');
      if (!document.getElementById('aff-agree').checked) return flash(err, 'Check the box to accept the terms.', 'err');
      btn.disabled = true;
      try { await api('/api/affiliate/terms', { method: 'POST', body: { agree: true } }); await affiliateView(); }
      catch (e) { flash(err, e.message, 'err'); btn.disabled = false; }
    });
  }

  // ---------- W-9 and payout forms (invitation page and the affiliate's details page) ----------
  let W9F = null; // the form's choices and wording, from the server
  const w9Form = async () => (W9F = W9F || await api('/api/public/w9-form', { quiet: true }));
  const fval = (f, n) => {
    const x = f.elements.namedItem(n);
    if (!x) return '';
    if (typeof RadioNodeList !== 'undefined' && x instanceof RadioNodeList) return x.value;
    return x.type === 'checkbox' ? x.checked : x.value;
  };
  const W9_KEYS = ['legal_name', 'business_name', 'tax_class', 'llc_class', 'other_class', 'foreign_owners', 'exempt_payee_code', 'fatca_code', 'address', 'city', 'state', 'zip', 'tin_type', 'tin', 'tin_confirm', 'backup_withholding', 'signature', 'certify'];
  const readW9 = (f) => Object.fromEntries(W9_KEYS.map((k) => [k, fval(f, k)]));
  const readPayout = (f) => {
    const method = fval(f, 'payout_method');
    return { method, bank: method === 'ach' ? { holder: fval(f, 'holder'), routing: fval(f, 'routing'), account: fval(f, 'account'), account_confirm: fval(f, 'account_confirm'), type: fval(f, 'acct_type') } : null };
  };
  const todayLong = () => new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  // IRS Form W-9, line by line, with the form's own certification wording.
  function w9Fields(F, pre = {}) {
    const opt = (v, l, cur) => `<option value="${esc(v)}"${String(cur ?? '') === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
    return `
      <p class="small muted">IRS Form W-9 (${esc(F.revision)}) for ${esc(F.requester)}. We use it to report what we pay you, as the law requires. Your tax ID number is encrypted; afterward only its last 4 digits are shown.</p>
      <div><label for="w-name">1. Name of entity/individual, as shown on your income tax return</label><input id="w-name" name="legal_name" required maxlength="120" autocomplete="name" value="${esc(pre.legal_name || '')}"><p class="small muted">A sole proprietor, or a single-member LLC that’s a disregarded entity, enters the owner’s own name.</p></div>
      <div><label for="w-biz">2. Business name/disregarded entity name, if different (optional)</label><input id="w-biz" name="business_name" maxlength="120" autocomplete="organization" value="${esc(pre.business_name || '')}"></div>
      <fieldset class="plain stack" style="gap:6px"><legend>3a. Federal tax classification (choose one)</legend>
        ${Object.entries(F.classes).map(([k, l]) => `<label class="check"><input type="radio" name="tax_class" value="${k}" required> <span>${esc(l)}</span></label>`).join('')}
        <div data-show="llc" hidden><label for="w-llc">How the LLC is taxed</label><select id="w-llc" name="llc_class"><option value="">Choose…</option>${Object.entries(F.llc_classes).map(([k, l]) => opt(k, `${k} = ${l}`, '')).join('')}</select><p class="small muted">A single-member LLC that’s a disregarded entity chooses Individual/sole proprietor instead.</p></div>
        <div data-show="other" hidden><label for="w-other">Describe “Other”</label><input id="w-other" name="other_class" maxlength="80"></div>
      </fieldset>
      <label class="check" data-show="flow" hidden><input type="checkbox" name="foreign_owners"> <span>3b. I have foreign partners, owners, or beneficiaries. This only applies when you give the form to a partnership, trust or estate you own part of, so most affiliates leave it unchecked.</span></label>
      <details><summary class="small" style="cursor:pointer;min-height:44px;display:flex;align-items:center">4. Exemptions (most people leave these blank)</summary>
        <div class="grid2">
          <div><label for="w-exempt">Exempt payee code (if any)</label><select id="w-exempt" name="exempt_payee_code"><option value="">None</option>${F.exempt_payee_codes.map((c) => opt(c, c, '')).join('')}</select></div>
          <div><label for="w-fatca">Exemption from FATCA reporting code (if any)</label><select id="w-fatca" name="fatca_code"><option value="">None</option>${F.fatca_codes.map((c) => opt(c, c, '')).join('')}</select></div>
        </div>
      </details>
      <div><label for="w-addr">5. Address (number, street, and apt. or suite no.)</label><input id="w-addr" name="address" required maxlength="160" autocomplete="street-address"></div>
      <div class="grid3">
        <div><label for="w-city">6. City</label><input id="w-city" name="city" required maxlength="80" autocomplete="address-level2"></div>
        <div><label for="w-state">State</label><select id="w-state" name="state" required autocomplete="address-level1"><option value="">State</option>${F.states.map((c) => opt(c, c, '')).join('')}</select></div>
        <div><label for="w-zip">ZIP code</label><input id="w-zip" name="zip" required inputmode="numeric" maxlength="10" autocomplete="postal-code"></div>
      </div>
      <fieldset class="plain stack" style="gap:6px"><legend>Part I. Taxpayer Identification Number (TIN)</legend>
        <div class="row" style="gap:6px 18px;flex-wrap:wrap"><label class="check"><input type="radio" name="tin_type" value="ssn" required> <span>Social security number (or ITIN)</span></label><label class="check"><input type="radio" name="tin_type" value="ein"> <span>Employer identification number</span></label></div>
        <div class="grid2">
          <div><label for="w-tin">Number</label><input id="w-tin" name="tin" required inputmode="numeric" maxlength="11" autocomplete="off" spellcheck="false"></div>
          <div><label for="w-tin2">Type it again</label><input id="w-tin2" name="tin_confirm" required inputmode="numeric" maxlength="11" autocomplete="off" spellcheck="false"></div>
        </div>
        <p class="small muted">A sole proprietor can give an SSN or an EIN. Corporations, partnerships and LLCs taxed as one give an EIN.</p>
      </fieldset>
      <fieldset class="w9-cert stack"><legend>Part II. Certification</legend>
        <p><strong>${esc(F.certification.lead)}</strong></p>
        <ol>${F.certification.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
        <details><summary class="small" style="cursor:pointer">What “U.S. person” means</summary><p class="small">${esc(F.certification.usPerson)} If you aren’t a U.S. person, don’t use this form; email support@gethitchpoint.com.</p></details>
        <label class="check"><input type="checkbox" name="backup_withholding"> <span>The IRS has notified me that I’m currently subject to backup withholding because I failed to report all interest and dividends on my tax return. This crosses out item 2. Most people leave it unchecked.</span></label>
        <div><label for="w-sig">Signature of U.S. person: type your full name</label><input id="w-sig" name="signature" required maxlength="120" autocomplete="name"></div>
        <label class="check"><input type="checkbox" name="certify" required> <span>I’m signing this Form W-9 electronically. Under penalties of perjury, I certify the statements above. Date: ${esc(todayLong())}.</span></label>
      </fieldset>`;
  }
  function payoutFields() {
    return `
      <fieldset class="plain stack" style="gap:6px"><legend>How do you want to be paid?</legend>
        <label class="check"><input type="radio" name="payout_method" value="ach" required> <span>Direct deposit (ACH) to my bank account</span></label>
        <label class="check"><input type="radio" name="payout_method" value="check"> <span>A paper check mailed to the address on my W-9</span></label>
      </fieldset>
      <div class="stack" data-show="ach" hidden>
        <div><label for="b-holder">Name on the bank account</label><input id="b-holder" name="holder" maxlength="120" autocomplete="off"></div>
        <div class="grid2">
          <div><label for="b-routing">Routing number (9 digits)</label><input id="b-routing" name="routing" inputmode="numeric" maxlength="9" autocomplete="off"></div>
          <div><label for="b-type">Account type</label><select id="b-type" name="acct_type"><option value="checking">Checking</option><option value="savings">Savings</option></select></div>
          <div><label for="b-acct">Account number</label><input id="b-acct" name="account" inputmode="numeric" maxlength="17" autocomplete="off"></div>
          <div><label for="b-acct2">Account number again</label><input id="b-acct2" name="account_confirm" inputmode="numeric" maxlength="17" autocomplete="off"></div>
        </div>
        <p class="small muted">Both numbers are at the bottom of a check or in your bank’s app. They’re encrypted; afterward only the last 4 digits of the account are shown.</p>
      </div>`;
  }
  // Show the parts of the form that apply (LLC class, "Other", line 3b, bank fields). Hidden parts are
  // disabled, so they aren't required or sent.
  function wireTaxForms(f) {
    const toggle = (key, on) => f.querySelectorAll(`[data-show="${key}"]`).forEach((n) => {
      n.hidden = !on;
      n.querySelectorAll('input, select').forEach((i) => { i.disabled = !on; });
    });
    const sync = () => {
      const c = fval(f, 'tax_class'), llc = fval(f, 'llc_class');
      toggle('llc', c === 'llc'); toggle('other', c === 'other');
      toggle('flow', c === 'partnership' || c === 'trust_estate' || (c === 'llc' && llc === 'P'));
      const L = f.elements.namedItem('llc_class'); if (L) L.required = c === 'llc';
      const O = f.elements.namedItem('other_class'); if (O) O.required = c === 'other';
      const item2 = f.querySelectorAll('.w9-cert ol li')[1]; if (item2) item2.classList.toggle('struck', Boolean(fval(f, 'backup_withholding')));
      const ach = fval(f, 'payout_method') === 'ach';
      toggle('ach', ach);
      ['holder', 'routing', 'account', 'account_confirm'].forEach((n) => { const x = f.elements.namedItem(n); if (x) x.required = ach; });
    };
    f.addEventListener('change', sync);
    sync();
  }
  // Checks the browser can do before sending: required fields, and the typed-twice numbers match.
  function checkFields(scope, f) {
    const same = (a, b, msg) => { const A = f.elements.namedItem(a), B = f.elements.namedItem(b); if (A && B && scope.contains(B) && !B.disabled) B.setCustomValidity(B.value.replace(/\D/g, '') === A.value.replace(/\D/g, '') ? '' : msg); };
    same('tin', 'tin_confirm', 'The two numbers don’t match.');
    same('account', 'account_confirm', 'The two account numbers don’t match.');
    for (const el of scope.querySelectorAll('input, select, textarea')) {
      el.removeAttribute('aria-invalid');
      if (!el.disabled && !el.checkValidity()) { el.setAttribute('aria-invalid', 'true'); el.reportValidity(); return false; }
    }
    return true;
  }
  // Puts a server message on the field it's about. Returns that field (or null).
  function markField(f, e, box) {
    f.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    const item = e.data && e.data.field ? f.elements.namedItem(e.data.field) : null;
    const node = item && (typeof RadioNodeList !== 'undefined' && item instanceof RadioNodeList ? item[0] : item);
    if (node) node.setAttribute('aria-invalid', 'true');
    flash(box, e.message, 'err');
    return node || null;
  }

  // The page an invitation email links to: set up a login (or confirm a business login), sign the
  // W-9, choose how to be paid, accept the Affiliate Program Terms, and get the referral link.
  async function joinView(token) {
    showChrome(false);
    view.innerHTML = '<p class="muted" style="padding:16px">Loading…</p>';
    let d, F;
    try { [d, F] = await Promise.all([api('/api/public/affiliate-invites/lookup', { method: 'POST', body: { token }, quiet: true }), w9Form()]); }
    catch (e) { view.innerHTML = `<section class="card login stack">${brandHead}<h1>This invitation can’t be used</h1><p>${esc(e.message)}</p><p class="small">Already joined? <a href="#/login">Log in</a></p></section>`; return; }
    const span = d.months ? `for ${d.months} month${d.months === 1 ? '' : 's'} after each one signs up` : `for as long as each one uses ${PLATFORM}`;
    const head = `${brandHead}<h1>Join the ${PLATFORM} referral program</h1><p>Earn <strong>${esc(pct(d.share_bp))}</strong> of the fee ${PLATFORM} keeps on card payments from each mobile RV repair business you refer, ${esc(span)}.</p>`;
    if (!d.tax_ready || d.account === 'blocked') {
      view.innerHTML = `<section class="card login stack" style="max-width:640px">${head}<p class="alert err">${d.account === 'blocked' ? `This email already has a ${PLATFORM} login that can’t be used for the referral program. Email support@gethitchpoint.com for help.` : 'We can’t take tax forms just yet. Please try this link again in a day or two.'}</p></section>`;
      return;
    }
    const biz = d.account === 'business';
    const STEPS = ['About you', 'Tax form', 'Payouts', 'Agree'];
    const other = me && me.user && me.user.email.toLowerCase() !== d.email.toLowerCase();
    view.innerHTML = `
      <section class="card stack join">
        ${head}
        <ul class="small stack" style="margin:0;padding-left:20px;gap:4px">
          <li>New earnings wait ${d.hold_days} days in case of refunds, then become available.</li>
          <li>We pay monthly once you have ${money(d.min_payout_cents)} or more, by direct deposit or check.</li>
          <li>When you share your link, you tell people you earn a share.</li>
        </ul>
        <p class="small muted">Invitation for <strong>${esc(d.email)}</strong>. It works until ${esc(affDate(d.expires_at))}. Have your Social Security number or EIN ready, and your bank’s routing and account numbers for direct deposit.${other ? ` You’re logged in as ${esc(me.user.email)}; finishing logs you in as ${esc(d.email)}.` : ''}</p>
        <ol class="join-steps" aria-label="Steps">${STEPS.map((x, i) => `<li>${i + 1}. ${x}</li>`).join('')}</ol>
        <form class="stack" id="jf" novalidate>
          <section class="stack" data-step="0">
            <h2>About you</h2>
            ${biz ? `<p>This email already has a ${PLATFORM} login for <strong>${esc(d.business_name)}</strong>, so your business will be the affiliate.</p>` : `
            <div><label for="j-name">Your name, or your group’s or company’s name</label><input id="j-name" name="name" required maxlength="120" autocomplete="name"><p class="small muted">Businesses you refer see this name.</p></div>
            <div><label for="j-phone">Phone (optional, for payout questions)</label><input id="j-phone" name="phone" type="tel" maxlength="40" autocomplete="tel"></div>`}
            <div><label for="j-aud">Where will you share your link? (optional)</label><textarea id="j-aud" name="audience" rows="2" maxlength="500" placeholder="For example: my RV owners group, our campground newsletter, techs I know"></textarea></div>
            <div><label for="j-code">Your link</label><div class="aff-link"><span class="small muted" style="align-self:center;overflow-wrap:anywhere">${esc(d.link_base)}</span><input id="j-code" name="code" required maxlength="40" autocapitalize="none" spellcheck="false" value="${esc(d.suggested_code)}" style="flex:1 1 140px"></div><p class="small muted" id="j-code-note">Lowercase letters, numbers and dashes. Businesses can also type it as a referral code when they sign up.</p></div>
            <div><label for="j-pw">${biz ? `Your ${PLATFORM} password` : 'Choose a password (10 or more characters)'}</label><input id="j-pw" name="password" type="password" required ${biz ? '' : 'minlength="10"'} autocomplete="${biz ? 'current-password' : 'new-password'}"><p class="small muted">${biz ? 'The one you use to log in to your business dashboard.' : `You’ll log in with ${esc(d.email)} and this password to see your clicks and earnings.`}</p></div>
          </section>
          <section class="stack" data-step="1" hidden><h2>Tax form (W-9)</h2>${w9Fields(F)}</section>
          <section class="stack" data-step="2" hidden><h2>How we pay you</h2>${payoutFields()}</section>
          <section class="stack" data-step="3" hidden>
            <h2>Check and agree</h2>
            <dl class="kv" id="j-review"></dl>
            <label class="check"><input type="checkbox" name="agree" required> <span>I have read and agree to the <a href="${esc(d.terms_url)}" target="_blank" rel="noopener">Affiliate Program Terms</a>${biz ? ' for my business' : ''}.</span></label>
          </section>
          <p class="alert err" id="j-err" hidden></p>
          <div class="row between"><button class="btn ghost" type="button" id="j-back" hidden>Back</button><span></span><button class="btn primary" type="submit" id="j-next">Next</button></div>
        </form>
      </section>`;
    const f = document.getElementById('jf'), err = document.getElementById('j-err');
    const sections = [...f.querySelectorAll('[data-step]')];
    const dots = [...document.querySelectorAll('.join-steps li')];
    wireTaxForms(f);
    let step = 0;
    const review = () => {
      const w = readW9(f), p = readPayout(f), last4 = String(w.tin).replace(/\D/g, '').slice(-4);
      const row = (k, v) => `<dt>${k}</dt><dd>${esc(v)}</dd>`;
      document.getElementById('j-review').innerHTML = row('Affiliate', biz ? d.business_name : fval(f, 'name'))
        + row('Your link', d.link_base + fval(f, 'code'))
        + row('W-9 name', w.legal_name + (w.business_name ? ` (${w.business_name})` : ''))
        + row('Tax ID', `${w.tin_type === 'ein' ? 'EIN' : 'SSN'} ending in ${last4}`)
        + row('Address', `${w.address}, ${w.city}, ${w.state} ${w.zip}`)
        + row('Paid by', p.method === 'ach' ? `Direct deposit to the account ending in ${String(p.bank.account).replace(/\D/g, '').slice(-4)}` : 'Check mailed to the address above');
    };
    const show = (n) => {
      step = n;
      sections.forEach((x, i) => { x.hidden = i !== n; });
      dots.forEach((li, i) => { li.classList.toggle('done', i < n); if (i === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
      document.getElementById('j-back').hidden = n === 0;
      document.getElementById('j-next').textContent = n === sections.length - 1 ? 'Join and get my link' : 'Next';
      if (n === sections.length - 1) review();
      err.hidden = true;
      f.closest('.join').scrollIntoView({ block: 'start' });
    };
    show(0);
    document.getElementById('j-back').addEventListener('click', () => show(Math.max(0, step - 1)));
    const codeBox = f.elements.namedItem('code'), codeNote = document.getElementById('j-code-note');
    codeBox.addEventListener('change', async () => {
      const r = await api('/api/public/affiliate-invites/lookup', { method: 'POST', body: { token, code: codeBox.value }, quiet: true }).catch(() => null);
      const c = r && r.code_check;
      if (!c) return;
      codeBox.setCustomValidity(c.ok ? '' : c.message);
      codeNote.textContent = c.ok ? `Your link will be ${d.link_base}${c.code}` : c.message;
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!checkFields(sections[step], f)) return;
      if (step < sections.length - 1) return show(step + 1);
      const btn = document.getElementById('j-next');
      btn.disabled = true; btn.textContent = 'Joining…';
      try {
        const body = { name: fval(f, 'name'), phone: fval(f, 'phone'), audience: fval(f, 'audience'), code: fval(f, 'code'), password: fval(f, 'password'), agree: fval(f, 'agree'), w9: readW9(f), payout: readPayout(f) };
        const r = await api('/api/public/affiliate-invites/accept', { method: 'POST', body: { token, ...body }, quiet: true });
        me = null;
        const line = shareText(biz ? 'business' : 'person');
        view.innerHTML = `
          <section class="card login stack" style="max-width:640px">
            ${brandHead}
            <h1>You’re in</h1>
            <p>Here’s your referral link. Share it with mobile RV repair businesses.</p>
            <div class="aff-link"><input readonly id="j-link" value="${esc(r.link)}" aria-label="Your referral link"><button class="btn primary" type="button" id="j-copy">Copy link</button></div>
            <p class="small muted">Businesses can also type your code, <code>${esc(r.code)}</code>, when they sign up.</p>
            <h2>Tell people you earn a share</h2>
            <blockquote class="aff-quote">${esc(line)}</blockquote>
            <div><button class="btn ghost sm" type="button" id="j-copy-line">Copy this line with your link</button></div>
            <p class="small muted">We got your W-9 and payout details. We also emailed you your link.</p>
            <a class="btn primary block" href="#/affiliate" id="j-open">See your clicks and earnings</a>
          </section>`;
        document.getElementById('j-copy').addEventListener('click', (ev) => copy(r.link, ev.currentTarget));
        document.getElementById('j-copy-line').addEventListener('click', (ev) => copy(`${line} ${r.link}`, ev.currentTarget));
        document.getElementById('j-open').addEventListener('click', async (ev) => { ev.preventDefault(); await loadMe(); location.hash = '#/affiliate'; route(); });
      } catch (ex) {
        btn.disabled = false; btn.textContent = 'Join and get my link';
        const node = markField(f, ex, err);
        const sec = node && node.closest('[data-step]');
        if (sec) { show(sections.indexOf(sec)); flash(err, ex.message, 'err'); node.focus(); }
      }
    });
  }

  // The affiliate's tax form and payout details (and, for a person or group, its login).
  async function affiliateDetailsView() {
    const person = isAffiliateUser();
    setNav(person ? 'account' : 'business');
    const [d, F] = await Promise.all([api('/api/affiliate'), w9Form()]);
    const A = d.affiliate;
    const back = person ? '' : '<a href="#/affiliate" class="small">← Referral page</a>';
    if (!A) { view.innerHTML = `${back}<h1>Tax form and payouts</h1><p class="muted">You’re not in the referral program.</p>`; return; }
    const T = A.tax, W = T.w9;
    const pwField = (id) => `<div><label for="${id}">Your password</label><input id="${id}" name="password" type="password" required autocomplete="current-password"><p class="small muted">To protect your tax and bank details, enter the password you log in with.</p></div>`;
    view.innerHTML = `
      ${back}
      <h1>${person ? 'Account' : 'Tax form and payouts'}</h1>
      ${!T.ready ? '<p class="alert err">We can’t take tax forms or bank details just yet. Please check back soon.</p>' : ''}
      ${isSuper() ? '<p class="alert err">Only the affiliate can change these. As an admin, open the affiliate from the Affiliates page.</p>' : ''}
      <p class="alert ok" id="det-msg" hidden></p>
      <section class="card stack">
        <h2>Tax form (W-9)</h2>
        ${W ? `<dl class="kv"><dt>Name</dt><dd>${esc(W.legal_name)}</dd>${W.business_name ? `<dt>Business</dt><dd>${esc(W.business_name)}</dd>` : ''}<dt>Classification</dt><dd>${esc(W.classification)}</dd><dt>Tax ID</dt><dd>${esc(W.tin)}</dd><dt>City</dt><dd>${esc(W.city)}, ${esc(W.state)}</dd><dt>Signed</dt><dd>${esc(affDate(W.signed_at))}</dd></dl>`
          : T.w9_on_paper ? '<p>We have a paper W-9 from you. If your name, address or tax ID changed, fill out a new one here.</p>' : '<p>We need a W-9 before we can pay you. It takes about 5 minutes.</p>'}
        ${W && W.backup_withholding ? '<p class="alert err">You told us the IRS has you on backup withholding, so we may have to hold back part of each payout for the IRS.</p>' : ''}
        ${T.ready && !isSuper() ? `<div><button class="btn ${W ? 'ghost' : 'primary'}" type="button" data-open="w9f">${W || T.w9_on_paper ? 'Fill out a new W-9' : 'Fill out the W-9'}</button></div>
        <form class="stack" id="w9f" hidden novalidate>${w9Fields(F, W ? { legal_name: W.legal_name, business_name: W.business_name } : {})}${pwField('w9-pw')}
          <p class="alert err" id="w9-err" hidden></p>
          <div class="row" style="gap:8px"><button class="btn primary" type="submit">Sign and send W-9</button><button class="btn ghost" type="button" data-close="w9f">Cancel</button></div>
        </form>` : ''}
      </section>
      <section class="card stack">
        <h2>How we pay you</h2>
        <p>${T.payout ? (T.payout.method === 'ach' ? `Direct deposit to the account ending in <strong>${esc(T.payout.last4)}</strong>.` : 'A paper check mailed to the address on your W-9.') : 'Tell us how you want to be paid.'}</p>
        ${T.ready && !isSuper() ? `<div><button class="btn ${T.payout ? 'ghost' : 'primary'}" type="button" data-open="payf">${T.payout ? 'Change how you’re paid' : 'Choose how you’re paid'}</button></div>
        <form class="stack" id="payf" hidden novalidate>${payoutFields()}${pwField('pay-pw')}
          <p class="alert err" id="pay-err" hidden></p>
          <div class="row" style="gap:8px"><button class="btn primary" type="submit">Save payout details</button><button class="btn ghost" type="button" data-close="payf">Cancel</button></div>
        </form>` : ''}
        <p class="small muted">We email you whenever your payout details change.</p>
      </section>
      ${person ? `<section class="card stack">
        <h2>Login</h2>
        <p>Email: <strong>${esc(me.user.email)}</strong></p>
        <form class="stack" id="pw">
          <div class="grid2"><div><label for="pw-cur">Current password</label><input id="pw-cur" name="current" type="password" required autocomplete="current-password"></div><div><label for="pw-new">New password (10 or more characters)</label><input id="pw-new" name="password" type="password" minlength="10" required autocomplete="new-password"></div></div>
          <p class="alert" id="pw-msg" hidden></p>
          <div class="row" style="gap:8px"><button class="btn sm" type="submit">Change password</button><button class="btn ghost sm" type="button" id="logout">Log out</button></div>
        </form>
        <p class="small muted">To change your name, email or phone, or to leave the program, email support@gethitchpoint.com.</p>
      </section>` : ''}`;
    view.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { const f = document.getElementById(b.dataset.open); f.hidden = false; b.hidden = true; (f.querySelector('input:not([type=radio]):not([type=checkbox])') || f.querySelector('input')).focus(); }));
    view.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { document.getElementById(b.dataset.close).hidden = true; view.querySelector(`[data-open="${b.dataset.close}"]`).hidden = false; }));
    const done = async (msg) => { await affiliateDetailsView(); flash(document.getElementById('det-msg'), msg); window.scrollTo(0, 0); };
    const w9f = document.getElementById('w9f');
    if (w9f) {
      wireTaxForms(w9f);
      w9f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!checkFields(w9f, w9f)) return;
        try { await api('/api/affiliate/w9', { method: 'POST', body: { password: fval(w9f, 'password'), w9: readW9(w9f) }, quiet: true }); await done('Thanks. We got your W-9.'); }
        catch (ex) { const n = markField(w9f, ex, document.getElementById('w9-err')); if (n) n.focus(); }
      });
    }
    const payf = document.getElementById('payf');
    if (payf) {
      wireTaxForms(payf);
      payf.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!checkFields(payf, payf)) return;
        try { await api('/api/affiliate/payout', { method: 'POST', body: { password: fval(payf, 'password'), payout: readPayout(payf) }, quiet: true }); await done('Saved. We emailed you a note about the change.'); }
        catch (ex) { const n = markField(payf, ex, document.getElementById('pay-err')); if (n) n.focus(); }
      });
    }
    const pw = document.getElementById('pw');
    if (pw) {
      pw.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('/api/password/change', { method: 'POST', body: Object.fromEntries(new FormData(pw)), quiet: true }); pw.reset(); flash(document.getElementById('pw-msg'), 'Password changed.'); }
        catch (err) { flash(document.getElementById('pw-msg'), err.message, 'err'); }
      });
      document.getElementById('logout').addEventListener('click', logout);
    }
  }

  // What to say when sharing a link: a business uses HitchPoint; a person or group recommends it.
  const shareText = (kind) => (kind === 'person'
    ? `I recommend ${PLATFORM} to mobile RV repair businesses. If you sign up with my link, I earn a share of ${PLATFORM}’s fee. It costs you nothing extra.`
    : `I use ${PLATFORM} to run my business. If you sign up with my link, I earn a share of ${PLATFORM}’s fee. It costs you nothing extra.`);
  // One line on the W-9 and payout details, for the referral page.
  function gettingPaid(A) {
    const T = A.tax || {};
    const w9 = T.w9 ? `W-9 received ${affDate(T.w9.signed_at)}` : T.w9_on_paper || A.w9_on_file ? 'W-9 on file' : 'W-9 needed';
    const pay = T.payout ? (T.payout.method === 'ach' ? `direct deposit to the account ending in ${T.payout.last4}` : 'paper check') : 'payout details needed';
    return { text: `${w9} · ${pay[0].toUpperCase()}${pay.slice(1)}`, needs: !(T.w9 || T.w9_on_paper || A.w9_on_file) || !T.payout };
  }

  // The referral page: a business owner's (Business → Refer businesses) or a person/group affiliate's home.
  async function affiliateView() {
    const person = isAffiliateUser();
    setNav(person ? 'affiliate' : 'business');
    const back = person ? '' : '<a href="#/business" class="small">← Business</a>';
    if (!isOwner() && !person) { view.innerHTML = `${back}<h1>Refer businesses, earn a share</h1><p class="muted">Only the business owner can see this page.</p>`; return; }
    const d = await api('/api/affiliate');
    const A = d.affiliate;
    if (!A) { view.innerHTML = `${back}<h1>Refer businesses, earn a share</h1><section class="card stack"><p>${person ? 'You’re not' : 'Your business isn’t'} in the referral program yet. To ask about joining, email <a href="mailto:support@gethitchpoint.com">support@gethitchpoint.com</a>.</p></section>`; return; }
    if (!A.link) { view.innerHTML = `${back}<h1>Refer businesses, earn a share</h1>${affTermsCard(A, true)}`; return wireTermsCard(); }
    const line = shareText(A.kind);
    const paid = gettingPaid(A);
    const detailsHref = person ? '#/account' : '#/affiliate/details';
    const T = d.totals;
    view.innerHTML = `
      ${back}
      <h1>Refer businesses, earn a share</h1>
      ${A.terms.needs_accept ? affTermsCard(A, false) : ''}
      ${A.status === 'paused' ? '<p class="alert err">Your referral link is paused, so new sign-ups aren’t credited to you right now. Businesses you already referred still earn you a share. Questions? Email support@gethitchpoint.com.</p>' : ''}
      <section class="card stack">
        <h2>Your referral link</h2>
        <div class="aff-link"><input readonly id="aff-url" value="${esc(A.link)}" aria-label="Your referral link"><button class="btn primary" type="button" id="aff-copy">Copy link</button></div>
        <p>${esc(shareLine(A))}</p>
        <p class="small muted">Businesses can also type your code, <code>${esc(A.code)}</code>, when they sign up.</p>
      </section>
      <section class="card stack">
        <h2>Tell people you earn a share</h2>
        <p>When you share your link, say that you get paid if they sign up. The law requires it, and it builds trust. You can copy this line:</p>
        <blockquote class="aff-quote">${esc(line)}</blockquote>
        <div><button class="btn ghost sm" type="button" id="aff-copy-line">Copy this line</button></div>
        <p class="small muted">Only text or email people who asked to hear from you, and don’t buy ads on the ${PLATFORM} name. <a href="${esc(A.terms.url)}" target="_blank" rel="noopener">Affiliate Program Terms</a></p>
      </section>
      <div class="aff-stats">
        ${affStat('Clicks, last 30 days', d.clicks.last_30_days.toLocaleString('en-US'))}
        ${affStat('Clicks, all time', d.clicks.all_time.toLocaleString('en-US'))}
        ${affStat('Pending', smoney(T.pending_cents))}
        ${affStat('Available to be paid', smoney(T.available_cents))}
        ${affStat('Paid to date', smoney(T.paid_cents))}
      </div>
      <p class="small muted">New earnings are pending for ${A.hold_days} days in case of refunds, then become available. We pay monthly once you have ${money(A.min_payout_cents)} or more available.</p>
      <section class="card stack">
        <h2>Getting paid</h2>
        <p>${esc(paid.text)}</p>
        ${paid.needs ? '<p class="small">We need your W-9 and how you want to be paid before your first payout.</p>' : ''}
        <div><a class="btn ${paid.needs ? 'primary' : 'ghost'} sm" href="${detailsHref}">${paid.needs ? 'Add your W-9 and payout details' : 'Tax form and payout details'}</a></div>
      </section>
      <section class="card stack">
        <h2>Businesses you referred</h2>
        ${affTable([['Business'], ['Joined', 'nowrap'], ['Status'], ['You’ve earned', 'num'], ['Share ends', 'nowrap']],
          d.referrals.map((r) => [esc(r.name), esc(affDate(r.joined)), REF_STATE[r.state] || '', smoney(r.earned_cents), r.share_ends ? esc(affDate(r.share_ends)) : 'As long as they stay']),
          'No businesses yet. Share your link to get started.')}
      </section>
      <section class="card stack">
        <div class="row between"><h2>Earnings and payouts</h2>${d.ledger.length ? '<a class="btn ghost sm" href="/api/affiliate/ledger.csv">Download CSV</a>' : ''}</div>
        <p class="small muted">Your earnings from each business are added up by month. You don’t see their individual payments.</p>
        ${affTable([['When', 'nowrap'], ['Business'], ['What it is'], ['Amount', 'num'], ['Status']],
          d.ledger.map((l) => [esc(l.month ? monthLabel(l.month) : affDate(l.date)), esc(l.business || ''), esc(ledgerWhat(l)), smoney(l.amount_cents), ledgerStatus(l)]),
          'Nothing yet. You earn a share when a business you referred takes a card payment.')}
      </section>`;
    wireTermsCard();
    document.getElementById('aff-copy').addEventListener('click', (e) => copy(A.link, e.currentTarget));
    document.getElementById('aff-copy-line').addEventListener('click', (e) => copy(`${line} ${A.link}`, e.currentTarget));
  }

  // Super admin: who referred this business (tenant detail page).
  async function referredByCard(tid) {
    const d = await api(`/api/super/tenants/${tid}/referral`).catch(() => null);
    const grid = view.querySelector('.grid2');
    if (!d || !grid || document.getElementById('ref-card')) return;
    const HOW = { link: 'their referral link', code: 'their code at sign-up', admin: 'an Agilities admin' };
    const from = (d.referred_at || '').slice(0, 10);
    grid.insertAdjacentHTML('afterend', `<section class="card stack" id="ref-card">
      <h2>Referred by</h2>
      ${d.referred_by ? `<p><strong>${esc(d.referred_by.name)}</strong> (code <code>${esc(d.referred_by.code)}</code>). Set by ${HOW[d.how] || 'unknown'}. Payments count from ${esc(affDate(d.referred_at))}.</p>` : '<p class="muted">No one. This business wasn’t referred.</p>'}
      ${d.affiliates.length ? `<form class="stack" id="ref-form">
        <div class="grid2">
          <div><label for="rf-aff">Referrer</label><select id="rf-aff" name="affiliate_id"><option value="">No one</option>${d.affiliates.map((a) => `<option value="${a.id}" ${d.referred_by && d.referred_by.id === a.id ? 'selected' : ''}>${esc(a.name)} (${esc(a.code)})${a.status === 'paused' ? ', paused' : ''}</option>`).join('')}</select></div>
          <div><label for="rf-from">Count payments from</label><input id="rf-from" name="from" type="date" min="${esc((d.joined || '').slice(0, 10))}" max="${todayIso()}" value="${esc(from || todayIso())}"></div>
        </div>
        <p class="small muted">Payments before this day earn the referrer nothing. Changing or removing the referrer takes back what the old referrer earned from this business.</p>
        <p class="alert" id="rf-msg" hidden></p>
        <div><button class="btn sm" type="submit">Save referrer</button></div>
      </form>` : '<p class="small muted">No affiliates yet. Add one on the <a href="#/affiliates">Affiliates</a> page.</p>'}
      ${d.own_affiliate_id ? `<p class="small">This business is an affiliate too. <a href="#/affiliates/${d.own_affiliate_id}">See its referrals and earnings</a>.</p>` : ''}
    </section>`);
    const f = document.getElementById('ref-form');
    if (!f) return;
    const startAff = f.elements.affiliate_id.value, startFrom = f.elements.from.value;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const el = f.elements, affId = el.affiliate_id.value;
      if (!affId && d.referred_by && !confirm(`Remove ${d.referred_by.name} as the referrer? This takes back what they earned from this business.`)) return;
      const changed = affId !== startAff || el.from.value !== startFrom;
      try {
        await api(`/api/super/tenants/${tid}/referral`, { method: 'PUT', body: { affiliate_id: affId || null, from: changed && affId ? el.from.value : '' } });
        document.getElementById('ref-card').remove(); await referredByCard(tid);
        flash(document.getElementById('rf-msg'), 'Saved.');
      } catch (err) { flash(document.getElementById('rf-msg'), err.message, 'err'); }
    });
  }

  // Super admin: all affiliates, or one affiliate's settings, referrals, ledger and payouts.
  // Shows what a share means in dollars as it's typed, so ".25" (0.25%) isn't mistaken for 25%.
  function sharePreview(input) {
    const out = document.createElement('p');
    out.className = 'small muted';
    out.setAttribute('aria-live', 'polite');
    input.insertAdjacentElement('afterend', out);
    const show = () => {
      const v = input.value.trim();
      const n = Number(v.replace(/[%\s]/g, ''));
      if (!v) out.textContent = '';
      else if (!Number.isFinite(n) || n < 0 || n > 100) out.textContent = 'Enter a percentage from 0 to 100, like 25.';
      else out.textContent = `They earn $${n.toFixed(2)} of every $100 ${PLATFORM} keeps in fees.${n > 0 && n < 1 ? ' That’s under 1%. For 25%, type 25, not .25.' : ''}`;
    };
    input.addEventListener('input', show);
    show();
  }

  async function superAffiliatesView(id) {
    setNav('affiliates');
    if (id) return superAffiliateView(id);
    const d = await api('/api/super/affiliates');
    const chips = (a) => `${a.status === 'active' ? '<span class="tag paid">Active</span>' : '<span class="tag new">Paused</span>'}<span class="tag">${a.kind === 'person' ? 'Person or group' : 'Business'}</span>${a.w9 ? `<span class="tag">W-9${a.w9 === 'paper' ? ' (paper)' : ''}</span>` : '<span class="tag void">No W-9</span>'}${a.payout_method ? `<span class="tag">${a.payout_method === 'ach' ? 'ACH' : 'Check'}</span>` : '<span class="tag void">No payout details</span>'}${a.backup_withholding ? '<span class="tag new">Backup withholding</span>' : ''}${!a.terms_accepted_at ? '<span class="tag void">Terms not accepted</span>' : a.terms_current ? '' : '<span class="tag void">Old terms</span>'}`;
    const INV = { pending: (i) => `Waiting · link works until ${esc(affDate(i.expires_at))}${i.sent_count ? '' : ' · not emailed'}`, expired: () => 'Expired', accepted: (i) => `Joined ${esc(affDate(i.accepted_at))}` };
    view.innerHTML = `
      <div class="row between"><h1>Affiliates</h1>
        <div class="row" style="gap:8px"><select id="aff-year" aria-label="Year for the 1099 export" style="width:auto">${d.years.map((y) => `<option>${esc(y)}</option>`).join('')}</select><a class="btn ghost sm" id="aff-1099" href="/api/super/affiliate-payouts.csv?year=${esc(d.years[0])}">Download payouts for 1099s</a></div></div>
      <p class="muted">Affiliates earn a share of ${PLATFORM}’s fee on card payments from businesses they refer. New earnings are pending for 30 days, then available. Pay them by ACH or check, then record the payout on their page.</p>
      ${d.tax_ready ? '' : `<section class="card stack" id="key-setup">
        <h2>First, turn on secure storage for tax forms</h2>
        <p>Affiliates give you their Social Security number or EIN and their bank details. ${PLATFORM} encrypts them with a secret key that’s kept in Render, not in the database. Invitations stay off until the key is set.</p>
        <ol class="small stack" style="gap:6px;padding-left:20px;margin:0">
          <li>Click <strong>Make a key</strong>. It’s made in your browser and isn’t sent anywhere.</li>
          <li>Click <strong>Copy</strong> and save the key in your password manager. If it’s lost, saved tax IDs can’t be read and affiliates would have to fill out their W-9 again.</li>
          <li>In Render, open the <strong>rsqu-admin</strong> service, then <strong>Environment</strong>. Click <strong>+ Add Environment Variable</strong>. Name: <code>DATA_ENCRYPTION_KEY</code>. Value: paste the key. Save, and let Render redeploy.</li>
          <li>When the deploy finishes, reload this page.</li>
        </ol>
        <div class="aff-link"><input readonly id="key-out" class="keybox" placeholder="Click Make a key" aria-label="New encryption key"><button class="btn primary" type="button" id="key-make">Make a key</button><button class="btn ghost" type="button" id="key-copy" disabled>Copy</button></div>
      </section>`}
      <form class="card stack" id="aff-inv" novalidate>
        <h2>Invite an affiliate</h2>
        <p class="small muted">They get an email with a private link (good for 14 days). They set up a login, fill out a W-9 and payout details, accept the Affiliate Program Terms, and get their referral link. Works for people, groups and companies, and for owners of businesses already on ${PLATFORM}.</p>
        <div class="grid2">
          <div><label for="ai-email">Their email</label><input id="ai-email" name="email" type="email" required autocomplete="off" ${d.tax_ready ? '' : 'disabled'}></div>
          <div><label for="ai-share">Their share of ${PLATFORM}’s fee (%)</label><input id="ai-share" name="share" inputmode="decimal" required value="25" ${d.tax_ready ? '' : 'disabled'}></div>
          <div><label for="ai-months">Months per referred business</label><input id="ai-months" name="months" inputmode="numeric" value="12" placeholder="Empty: as long as they stay" ${d.tax_ready ? '' : 'disabled'}></div>
        </div>
        ${d.email_enabled ? '' : '<p class="small">Email isn’t set up yet, so you’ll get a link to send them yourself (text or your own email).</p>'}
        <p class="alert" id="ai-msg" hidden></p>
        <div class="stack" id="ai-link" hidden></div>
        <div><button class="btn primary" type="submit" ${d.tax_ready ? '' : 'disabled'}>Send invitation</button></div>
      </form>
      ${d.invites.length ? `<section class="card stack"><h2>Invitations</h2><div class="stack" style="gap:10px">${d.invites.map((i) => `
        <div class="row between" style="gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px">
          <div class="stack" style="gap:2px;min-width:0"><strong style="overflow-wrap:anywhere">${esc(i.email)}</strong><span class="small muted">${pct(i.share_bp)} ${i.months ? `for ${i.months} months` : 'while they stay'} · ${(INV[i.status] || (() => esc(i.status)))(i)}</span></div>
          <div class="row" style="gap:6px">${i.status === 'accepted' ? (i.affiliate_id ? `<a class="btn ghost sm" href="#/affiliates/${i.affiliate_id}">Open</a>` : '') : `<button class="btn ghost sm" type="button" data-resend="${i.id}">${i.status === 'expired' ? 'Send a new link' : 'Resend'}</button><button class="btn ghost sm" type="button" data-cancel="${i.id}">Cancel</button>`}</div>
        </div>`).join('')}</div><div class="stack" id="inv-link" hidden></div></section>` : ''}
      <details class="card"><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:700">Add a business without an invitation</summary>
      <form class="stack" id="aff-new" style="margin-top:8px">
        <p class="small muted">Makes a business already on ${PLATFORM} an affiliate right away. The owner accepts the terms in their dashboard, and you ask them for a W-9 from their affiliate page.</p>
        <div class="grid2">
          <div><label for="an-biz">Business</label><select id="an-biz" name="tenant_id" required><option value="">Choose a business…</option>${d.businesses.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div>
          <div><label for="an-share">Their share of ${PLATFORM}’s fee (%)</label><input id="an-share" name="share" inputmode="decimal" required placeholder="20"></div>
          <div><label for="an-months">Months per referred business</label><input id="an-months" name="months" inputmode="numeric" placeholder="Empty: as long as they stay"></div>
          <div><label for="an-code">Referral code</label><input id="an-code" name="code" autocapitalize="none" spellcheck="false" placeholder="Empty: their web address name"></div>
        </div>
        <p class="alert" id="an-msg" hidden></p>
        <div><button class="btn primary" type="submit">Make affiliate</button></div>
      </form></details>
      <div class="list">${d.affiliates.map((a) => `
        <a class="item aff-item" href="#/affiliates/${a.id}">
          <div class="grow stack" style="gap:4px">
            <div class="row" style="gap:8px"><span class="item-title">${esc(a.name)}</span>${chips(a)}</div>
            <div class="small muted">Code ${esc(a.code)} · ${pct(a.share_bp)} ${a.months ? `for ${a.months} months` : 'while they stay'} · ${a.referrals} referred · ${a.clicks.clicks_30} clicks in 30 days</div>
          </div>
          <div class="stack aff-sum"><strong>${smoney(a.available_cents)}</strong><span class="small muted">available · ${smoney(a.pending_cents)} pending · ${smoney(a.paid_cents)} paid</span></div>
        </a>`).join('') || '<p class="empty">No affiliates yet.</p>'}</div>`;
    const yr = document.getElementById('aff-year');
    yr.addEventListener('change', () => { document.getElementById('aff-1099').href = '/api/super/affiliate-payouts.csv?year=' + encodeURIComponent(yr.value); });
    // A link to send by hand, shown after an invitation is created or resent.
    const showLink = (box, r) => {
      box.hidden = false;
      box.innerHTML = `<p class="small">${r.emailed ? `We emailed the invitation to <strong>${esc(r.invite.email)}</strong>. You can also send them this link yourself:` : `Email isn’t set up, so send <strong>${esc(r.invite.email)}</strong> this link yourself (by text or your own email). It works once, for 14 days:`}</p>
        <div class="aff-link"><input readonly value="${esc(r.link)}" aria-label="Invitation link"><button class="btn ghost" type="button">Copy link</button></div>`;
      box.querySelector('button').addEventListener('click', (ev) => copy(r.link, ev.currentTarget));
    };
    const keyMake = document.getElementById('key-make');
    if (keyMake) {
      keyMake.addEventListener('click', () => {
        const bytes = crypto.getRandomValues(new Uint8Array(48));
        document.getElementById('key-out').value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        document.getElementById('key-copy').disabled = false;
      });
      document.getElementById('key-copy').addEventListener('click', (ev) => copy(document.getElementById('key-out').value, ev.currentTarget));
    }
    const fi = document.getElementById('aff-inv');
    sharePreview(fi.elements.share);
    fi.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('ai-msg');
      if (!checkFields(fi, fi)) return;
      try {
        const r = await api('/api/super/affiliate-invites', { method: 'POST', body: { email: fi.elements.email.value, share_bp: fi.elements.share.value.trim() === '' ? '' : toCents(fi.elements.share.value), months: fi.elements.months.value.trim() } });
        await superAffiliatesView();
        flash(document.getElementById('ai-msg'), r.emailed ? 'Invitation sent.' : 'Invitation created. Send them the link below.');
        showLink(document.getElementById('ai-link'), r);
      } catch (err) { markField(fi, err, msg); }
    });
    view.querySelectorAll('[data-resend]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await api(`/api/super/affiliate-invites/${b.dataset.resend}/resend`, { method: 'POST' }); await superAffiliatesView(); showLink(document.getElementById('inv-link'), r); }
      catch (err) { b.disabled = false; flash(document.getElementById('ai-msg'), err.message, 'err'); }
    }));
    view.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to cancel it'; return; }
      try { await api(`/api/super/affiliate-invites/${b.dataset.cancel}/cancel`, { method: 'POST' }); await superAffiliatesView(); }
      catch (err) { flash(document.getElementById('ai-msg'), err.message, 'err'); }
    }));
    const f = document.getElementById('aff-new'), el = f.elements;
    sharePreview(el.share);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/super/affiliates', { method: 'POST', body: { tenant_id: Number(el.tenant_id.value), share_bp: el.share.value.trim() === '' ? '' : toCents(el.share.value), months: el.months.value.trim(), code: el.code.value } });
        location.hash = '#/affiliates/' + r.affiliate.id;
      } catch (err) { flash(document.getElementById('an-msg'), err.message, 'err'); }
    });
  }

  // Super admin: an affiliate's W-9 and payout details. Full numbers only on request, and logged.
  function taxAdminCard(d) {
    const a = d.affiliate, T = d.tax, W = T.w9;
    const WHAT = { w9_submitted: 'sent a W-9', w9_viewed: 'viewed the full W-9', payout_changed: 'changed payout details', bank_viewed: 'viewed bank details' };
    return `<section class="card stack" id="tax-admin">
      <h2>Tax form and payout details</h2>
      ${!T.ready ? '<p class="alert err">Secure storage isn’t set up (DATA_ENCRYPTION_KEY), so W-9s and bank details can’t be taken or shown. See the Affiliates page.</p>' : ''}
      <div class="grid2">
        <div class="stack" style="gap:8px">
          <h3 style="margin:0">W-9</h3>
          ${W ? `<dl class="kv"><dt>Line 1 name</dt><dd>${esc(W.legal_name)}</dd>${W.business_name ? `<dt>Line 2</dt><dd>${esc(W.business_name)}</dd>` : ''}<dt>Classification</dt><dd>${esc(W.classification)}</dd><dt>Tax ID</dt><dd>${esc(W.tin)}</dd><dt>City</dt><dd>${esc(W.city)}, ${esc(W.state)}</dd><dt>Signed</dt><dd>${esc(affDate(W.signed_at))}</dd></dl>
            ${W.backup_withholding ? '<p class="alert err">They say the IRS has them on backup withholding. You may need to withhold 24% of each payout and send it to the IRS. Ask your accountant before paying.</p>' : ''}
            <div><a class="btn ghost sm" href="/api/super/affiliates/${a.id}/w9" target="_blank" rel="noopener">View or print the full W-9</a></div>
            ${d.w9_history.length > 1 ? `<p class="small muted">Earlier W-9s: ${d.w9_history.slice(1).map((h) => `<a href="/api/super/affiliates/${a.id}/w9?w=${h.id}" target="_blank" rel="noopener">${esc(affDate(h.signed_at))}</a>`).join(' · ')}</p>` : ''}`
            : T.w9_on_paper ? '<p>Paper W-9 on file. It isn’t stored here.</p>' : '<p>No W-9 yet.</p>'}
        </div>
        <div class="stack" style="gap:8px">
          <h3 style="margin:0">Payouts</h3>
          <p>${T.payout ? (T.payout.method === 'ach' ? `ACH to the ${'account'} ending in <strong>${esc(T.payout.last4)}</strong>` : 'Paper check to the address on their W-9') + `<span class="small muted"> · updated ${esc(affDate(T.payout.updated_at))}</span>` : 'No payout details yet.'}</p>
          ${T.payout && T.payout.method === 'ach' && T.ready ? '<div><button class="btn ghost sm" type="button" id="bank-show">Show bank details</button></div><dl class="kv" id="bank-box" hidden></dl>' : ''}
        </div>
      </div>
      ${T.ready ? `<div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn ${W && T.payout ? 'ghost' : 'primary'} sm" type="button" id="req-details">${W && T.payout ? 'Ask them to update their details' : 'Ask for W-9 and payout details'}</button></div><div class="stack" id="req-out" hidden></div>` : ''}
      <p class="small muted">Opening a full W-9 or bank details is logged.${d.access_log.length ? ` Recent: ${d.access_log.slice(0, 5).map((l) => `${esc(l.user_email || 'someone')} ${WHAT[l.what] || esc(l.what)} ${esc(affDate(l.at))}`).join('; ')}.` : ''}</p>
    </section>`;
  }
  function wireTaxAdmin(id, d) {
    const show = document.getElementById('bank-show');
    if (show) show.addEventListener('click', async () => {
      try {
        const b = await api(`/api/super/affiliates/${id}/bank`, { method: 'POST' });
        const box = document.getElementById('bank-box');
        box.innerHTML = `<dt>Name on account</dt><dd>${esc(b.holder)}</dd><dt>Routing</dt><dd><code>${esc(b.routing)}</code></dd><dt>Account</dt><dd><code>${esc(b.account)}</code></dd><dt>Type</dt><dd>${esc(b.type)}</dd>`;
        box.hidden = false; show.hidden = true;
      } catch (err) { flash(document.getElementById('ad-msg'), err.message, 'err'); }
    });
    const req = document.getElementById('req-details');
    if (req) req.addEventListener('click', async () => {
      req.disabled = true;
      try {
        const r = await api(`/api/super/affiliates/${id}/request-details`, { method: 'POST' });
        const out = document.getElementById('req-out');
        out.hidden = false;
        out.innerHTML = `<p class="small">${r.emailed ? `We emailed ${esc(r.to)}. You can also send them this link:` : `Email isn’t set up, so send ${esc(r.to || 'them')} this link yourself. They log in, then fill out the forms:`}</p><div class="aff-link"><input readonly value="${esc(r.link)}" aria-label="Link to their details page"><button class="btn ghost" type="button">Copy link</button></div>`;
        out.querySelector('button').addEventListener('click', (ev) => copy(r.link, ev.currentTarget));
      } catch (err) { req.disabled = false; flash(document.getElementById('ad-msg'), err.message, 'err'); }
    });
  }

  async function superAffiliateView(id) {
    const d = await api('/api/super/affiliates/' + id);
    const a = d.affiliate;
    const HOW = { link: 'Link', code: 'Code', admin: 'Admin' };
    const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
    view.innerHTML = `
      <a href="#/affiliates" class="small">← Affiliates</a>
      <div class="row between"><h1>${esc(a.name)}</h1>${a.tenant_id ? `<a class="btn ghost sm" href="#/super/${a.tenant_id}">Open business</a>` : ''}</div>
      <p class="small">Link: <a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.link)}</a> · ${a.kind === 'person' ? 'Person or group' : 'Business'} · Email: ${esc(a.email)}${a.phone ? ` · Phone: ${esc(a.phone)}` : ''}</p>
      ${a.audience ? `<p class="small">Where they share their link: ${esc(a.audience)}</p>` : ''}
      ${!a.terms_accepted_at ? `<p class="alert err">They haven’t accepted the Affiliate Program Terms yet, so their link and code don’t work. Ask ${a.kind === 'person' ? 'them to log in and accept on their referral page' : 'the owner to open Business → Refer businesses'}.</p>` : ''}
      <p class="alert" id="ad-msg" hidden></p>
      <div class="aff-stats">
        ${affStat('Pending', smoney(a.pending_cents))}${affStat('Available', smoney(a.available_cents))}${affStat('Paid to date', smoney(a.paid_cents))}
        ${affStat('Clicks, 30 days', a.clicks.clicks_30, `${a.clicks.uniques_30} daily visitors`)}${affStat('Clicks, all time', a.clicks.all_clicks, `${a.referrals} businesses referred`)}
      </div>
      ${taxAdminCard(d)}
      <div class="grid2">
        <form class="card stack" id="ad-form">
          <h2>Settings</h2>
          <div><label for="ad-code">Referral code</label><input id="ad-code" name="code" value="${esc(a.code)}" autocapitalize="none" spellcheck="false"><p class="small muted">Changing the code stops old links and saved codes from working.</p></div>
          <div class="grid2">
            <div><label for="ad-share">Share of ${PLATFORM}’s fee (%)</label><input id="ad-share" name="share" inputmode="decimal" value="${a.share_bp / 100}"></div>
            <div><label for="ad-months">Months per referred business</label><input id="ad-months" name="months" inputmode="numeric" value="${a.months == null ? '' : a.months}" placeholder="Empty: as long as they stay"></div>
          </div>
          <p class="small muted">Changes apply to payments from now on. Earlier earnings keep the share they had.</p>
          <div><label for="ad-status">Status</label><select id="ad-status" name="status">${opt('active', 'Active', a.status)}${opt('paused', 'Paused: link and code stop working for new sign-ups', a.status)}</select></div>
          <label class="check"><input type="checkbox" name="w9" ${a.w9_on_file ? 'checked' : ''} ${d.tax.w9 ? 'disabled' : ''}> <span>${d.tax.w9 ? 'W-9 received online' : 'Paper W-9 on file (a signed copy you keep)'}</span></label>
          <div style="max-width:260px"><label for="ad-w9">W-9 received on</label><input id="ad-w9" name="w9_date" type="date" max="${todayIso()}" value="${esc((a.w9_on_file_at || '').slice(0, 10))}" ${d.tax.w9 ? 'disabled' : ''}></div>
          <p class="small muted">${a.terms_accepted_at ? `Accepted the Affiliate Program Terms (version ${esc(a.terms_version)}) on ${esc(affDate(a.terms_accepted_at))}.` : 'Hasn’t accepted the Affiliate Program Terms.'}</p>
          <div><button class="btn primary" type="submit">Save</button></div>
        </form>
        <section class="card stack">
          <h2>Record a payout</h2>
          ${d.payout_block ? `<p class="alert err">${esc(d.payout_block)}</p>` : `<p>Pay them ${smoney(a.available_cents)} by ACH, check or Stripe first. Then record it here, and those earnings are marked paid.</p>`}
          <form class="stack" id="ad-pay" ${d.payout_block ? 'hidden' : ''}>
            <div class="grid2">
              <div><label for="ap-method">How you paid</label><select id="ap-method" name="method">${d.methods.map((m) => `<option value="${m}">${{ ach: 'ACH', check: 'Check', stripe: 'Stripe', other: 'Other' }[m] || esc(m)}</option>`).join('')}</select></div>
              <div><label for="ap-date">Date paid</label><input id="ap-date" name="paid_on" type="date" max="${todayIso()}" value="${todayIso()}"></div>
            </div>
            <div><label for="ap-ref">Reference</label><input id="ap-ref" name="reference" maxlength="120" placeholder="Check number or transfer ID"></div>
            <div><button class="btn primary" type="submit">Record payout of ${smoney(a.available_cents)}</button></div>
          </form>
          <details><summary class="small" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Add an adjustment</summary>
            <form class="stack" id="ad-adj">
              <div class="grid2"><div><label for="aj-amt">Amount ($)</label><input id="aj-amt" name="amount" inputmode="decimal" placeholder="10.00, or -10.00 to take away"></div><div><label for="aj-note">Note (they see it)</label><input id="aj-note" name="note" maxlength="300"></div></div>
              <div><button class="btn sm" type="submit">Add adjustment</button></div>
            </form>
          </details>
        </section>
      </div>
      <section class="card stack">
        <h2>Businesses they referred</h2>
        ${affTable([['Business'], ['Joined', 'nowrap'], ['How'], ['Counts from', 'nowrap'], ['Status'], ['Earned', 'num'], ['Share ends', 'nowrap']],
          d.referrals.map((r) => [`<a href="#/super/${r.id}">${esc(r.name)}</a>`, esc(affDate(r.joined)), HOW[r.how] || '', esc(affDate(r.referred_at)), REF_STATE[r.state] || '', smoney(r.earned_cents), r.share_ends ? esc(affDate(r.share_ends)) : 'While they stay']),
          'No referrals yet.')}
      </section>
      <section class="card stack">
        <h2>Ledger</h2>
        ${affTable([['Date', 'nowrap'], ['Business'], ['What it is'], ['Share'], ['Amount', 'num'], ['Status']],
          d.ledger.map((l) => [esc(affDate(l.date)), esc(l.business), esc(ledgerWhat(l).replace(/^Your share/, 'Share').replace(/^Paid to you/, 'Paid')) + (l.payment_id ? `<div class="small muted">Payment #${l.payment_id}</div>` : ''), l.share_bp != null ? pct(l.share_bp) : '', smoney(l.amount_cents), ledgerStatus(l)]),
          'No earnings yet.')}
      </section>
      <section class="card stack">
        <h2>Payouts</h2>
        ${affTable([['Date paid', 'nowrap'], ['Amount', 'num'], ['Method'], ['Reference'], ['Recorded by']],
          d.payouts.map((p) => [esc(affDate(p.paid_at)), smoney(p.amount_cents), esc(PAY_METHOD[p.method] || p.method), esc(p.reference || ''), esc(p.created_by || '')]),
          'No payouts yet.')}
        <p class="small muted">Share history: ${d.rates.map((r) => `${pct(r.share_bp)} ${r.months ? `for ${r.months} months` : 'while they stay'} from ${esc(affDate(r.effective_at))}`).join('; ')}</p>
      </section>`;
    const msg = document.getElementById('ad-msg');
    const done = async (text) => { await superAffiliateView(id); flash(document.getElementById('ad-msg'), text); };
    const f = document.getElementById('ad-form'), el = f.elements;
    sharePreview(el.share);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/super/affiliates/' + id, { method: 'PATCH', body: { code: el.code.value, share_bp: el.share.value.trim() === '' ? '' : toCents(el.share.value), months: el.months.value.trim(), status: el.status.value, ...(d.tax.w9 ? {} : { w9_on_file: el.w9.checked, w9_date: el.w9_date.value }) } });
        await done('Saved.');
      } catch (err) { flash(msg, err.message, 'err'); }
    });
    wireTaxAdmin(id, d);
    const pf = document.getElementById('ad-pay');
    pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm(`Record a payout of ${smoney(a.available_cents)} to ${a.name}? Only do this after you’ve sent the money.`)) return;
      // The amount shown on this page: if the balance changed since, the server refuses and asks for a reload.
      try { await api(`/api/super/affiliates/${id}/payouts`, { method: 'POST', body: { amount_cents: a.available_cents, method: pf.elements.method.value, reference: pf.elements.reference.value, paid_on: pf.elements.paid_on.value } }); await done('Payout recorded.'); }
      catch (err) { flash(msg, err.message, 'err'); }
    });
    const af = document.getElementById('ad-adj');
    af.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api(`/api/super/affiliates/${id}/adjustments`, { method: 'POST', body: { amount_cents: signedCents(af.elements.amount.value), note: af.elements.note.value } }); await done('Adjustment added.'); }
      catch (err) { flash(msg, err.message, 'err'); }
    });
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
      ${termsCard(cfg.customer_terms)}
      <section class="card stack">
        <h2>Payments (your Stripe account)</h2>
        ${!st.platform_ready ? '<p>Online payments aren’t switched on yet. You’ll be notified when they are.</p>' :
          st.payouts_enabled ? `<p class="alert ok">Card payments are on. Customers pay your business directly and Stripe pays out to your bank${st.test_mode ? ' (test mode: no real money moves)' : ''}.</p>` :
          st.details_submitted ? '<p class="alert ok">Details submitted. Stripe is verifying them; card payments turn on as soon as that’s done.</p>' :
          '<p>Connect your Stripe account so customers can pay you online.</p>'}
        ${isOwner() && st.platform_ready ? `<div class="row">${st.account && st.details_submitted ? '<button class="btn" type="button" id="bank">Open your Stripe Dashboard</button>' : ''}${!st.details_submitted ? '<button class="btn primary" type="button" id="connect">Connect with Stripe</button>' : ''}</div>` : ''}
        <p class="small muted">Your business is the seller of record: refunds, disputes and payouts are managed in your Stripe Dashboard. Processing Fee on online payments: Stripe’s fee (billed by Stripe) plus ${FEE_TEXT(pf.bp).replace(/^Stripe’s fee \+ /, '')}. Cash and check payments have no fee. <a href="/legal/payment-terms" target="_blank" rel="noopener">Payment terms</a></p>
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
        <div><label for="s-terms">Default job notes on proposals</label><textarea id="s-terms" name="terms" rows="4">${esc(s.terms)}</textarea><p class="small muted">Shown on each proposal as job-specific terms, in addition to your <a href="#/terms">customer Terms &amp; Conditions</a>.</p></div>
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
      catch (err) { flash(document.getElementById('st-msg'), err.message, 'err'); c.disabled = false; c.textContent = 'Connect with Stripe'; }
    });
    const bank = document.getElementById('bank');
    if (bank) bank.addEventListener('click', async () => {
      try { const { url } = await api('/api/stripe/dashboard', { method: 'POST' }); window.open(url, '_blank', 'noopener'); }
      catch (err) { flash(document.getElementById('st-msg'), err.message, 'err'); }
    });
    api('/api/payments').then((rows) => {
      const online = rows.filter((p) => p.method === 'card');
      if (!online.length) return;
      document.getElementById('payouts').innerHTML = `<h3 style="margin-top:8px">Recent online payments</h3><table class="items"><thead><tr><th>Date</th><th class="num">Paid</th><th class="num">Processing Fee</th><th class="num">You receive</th></tr></thead><tbody>${online.slice(0, 20).map((p) => `<tr><td>${esc((p.paid_at || '').slice(0, 10))}<div class="small muted">${esc(p.description)}</div></td><td class="num">${money(p.amount_cents)}</td><td class="num">${money(p.stripe_fee_cents + p.fee_cents)}</td><td class="num">${money(p.payout_cents)}${['sent', 'direct'].includes(p.transfer_status) ? '' : `<div class="small muted">${esc(p.transfer_status || 'pending')}</div>`}</td></tr>`).join('')}</tbody></table>`;
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

    ownerSettingsCards(cfg);
  }

  // ---------- customer Terms & Conditions (the business is the seller of record) ----------
  // Same safe Markdown subset the server renders: everything is escaped first.
  function mdToHtml(md) {
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const out = [];
    for (const block of String(md || '').replace(/\r\n/g, '\n').split(/\n{2,}/)) {
      let para = []; let list = [];
      const fp = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
      const fl = () => { if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = []; };
      for (const line of block.split('\n').filter((l) => l.trim())) {
        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        if (h) { fp(); fl(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); }
        else if (/^\s*-{3,}\s*$/.test(line)) { fp(); fl(); out.push('<hr>'); }
        else if (/^\s*[-*]\s+/.test(line)) { fp(); list.push(line.replace(/^\s*[-*]\s+/, '')); }
        else { fl(); para.push(line); }
      }
      fp(); fl();
    }
    return out.join('');
  }

  function termsCard(ct) {
    if (!ct) return '';
    const msg = ct.approved_version
      ? ct.needs_review
        ? `<p class="alert err">Your business details changed since you approved version ${ct.approved_version}. Customers still see version ${ct.approved_version} until you review and approve the update.</p>`
        : `<p class="alert ok">Approved: version ${ct.approved_version}. Customers accept it when they sign a proposal or pay online.</p>`
      : `<p class="alert err">Not approved yet. Online payments turn on after you complete your business details and approve your customer terms.</p>`;
    return `<section class="card stack"><h2>Customer Terms &amp; Conditions</h2>${msg}<div><a class="btn ${ct.approved_version && !ct.needs_review ? '' : 'primary'}" href="#/terms">${ct.approved_version ? 'Review your terms' : 'Set up and approve'}</a></div></section>`;
  }

  async function termsView() {
    setNav('settings');
    const [lp, ct] = await Promise.all([api('/api/legal-profile'), api('/api/customer-terms')]);
    const pr = lp.profile; const ro = isOwner() ? '' : 'disabled';
    const opt = (obj, cur, blank) => (blank ? `<option value="">${blank}</option>` : '') + Object.entries(obj).map(([k, v]) => `<option value="${esc(k)}" ${cur === k ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const f = (id, label, val, extra = '') => `<div><label for="lp-${id}">${label}</label><input id="lp-${id}" name="${id}" value="${esc(val ?? '')}" ${extra}></div>`;
    const usd = (c) => (c ? dollars(c) : '');
    const ck = (id, label) => `<label class="check"><input type="checkbox" name="${id}" ${pr[id] ? 'checked' : ''}> <span>${label}</span></label>`;
    const missingContact = [!lp.phone && 'phone', !lp.email && 'email'].filter(Boolean);
    view.innerHTML = `
      <a href="#/settings" class="small">← Settings</a>
      <h1>Customer Terms &amp; Conditions</h1>
      <p class="muted">Your business is the seller of record for its own sales, so your customers agree to <strong>your</strong> terms when they sign a proposal or pay online. Fill in your details once; they’re used in your terms, proposals and payment pages. Then review the draft and give final approval.</p>
      ${missingContact.length ? `<p class="alert err">Add your business ${missingContact.join(' and ')} on the <a href="#/business">Business page</a>; they appear in your terms as your contact for notices.</p>` : ''}
      <form class="card stack" id="lp"><fieldset ${ro} style="border:0;padding:0;margin:0" class="stack">
        <h2>1. Business details (one time)</h2>
        <div class="grid2">
          ${f('legalName', 'Legal business name *', pr.legalName, 'maxlength="120" placeholder="As registered, including LLC or Inc."')}
          ${f('licenseNumber', 'License number', pr.licenseNumber, 'maxlength="60"')}
          ${f('addressLine1', 'Street address *', pr.addressLine1, 'maxlength="120"')}
          ${f('addressLine2', 'Address line 2', pr.addressLine2, 'maxlength="120"')}
          ${f('city', 'City *', pr.city, 'maxlength="80"')}
          <div><label for="lp-state">State *</label><select id="lp-state" name="state">${opt(lp.options.states, pr.state, 'Choose…')}</select></div>
          ${f('postalCode', 'ZIP code *', pr.postalCode, 'inputmode="numeric" maxlength="10"')}
          ${f('licenseAuthority', 'Licensing authority', pr.licenseAuthority, 'maxlength="120"')}
          ${f('insuranceCarrier', 'Insurance carrier', pr.insuranceCarrier, 'maxlength="120"')}
        </div>
        ${ck('insured', 'We carry general liability insurance')}
        <h3>Sales tax</h3>
        <div class="grid2">
          ${f('tax', 'Sales tax rate % *', lp.tax_rate_bp / 100, 'inputmode="decimal"')}
        </div>
        ${ck('taxConfirmed', 'I confirmed this is the right rate for my location (enter 0 if I don’t collect sales tax). It’s the default on new quotes; I collect and remit the tax.')}
        <h3>Payment and service policies</h3>
        <div class="grid2">
          <div><label for="lp-balanceDue">Balance due</label><select id="lp-balanceDue" name="balanceDue">${opt(lp.options.balance_due, pr.balanceDue)}</select></div>
          ${f('warrantyDays', 'Workmanship guarantee (days) *', pr.warrantyDays, 'inputmode="numeric"')}
          ${f('lateFeePercent', 'Late fee (% per month, 0 = none)', pr.lateFeePercent, 'inputmode="decimal"')}
          ${f('returnedPaymentFee', 'Returned payment fee ($)', usd(pr.returnedPaymentFeeCents), 'inputmode="decimal"')}
          ${f('cancellationNoticeHours', 'Cancellation notice (hours)', pr.cancellationNoticeHours, 'inputmode="numeric"')}
          ${f('cancellationFee', 'Late cancellation fee ($)', usd(pr.cancellationFeeCents), 'inputmode="decimal"')}
          ${f('estimateValidDays', 'Estimates valid for (days)', pr.estimateValidDays, 'inputmode="numeric"')}
          ${f('hourlyRate', 'Hourly labor rate ($, optional)', usd(pr.hourlyRateCents), 'inputmode="decimal"')}
        </div>
        ${ck('marketingPhotos', 'We may use non-identifying photos of finished work in our marketing')}
        <h3>Legal</h3>
        <div class="grid2">
          <div><label for="lp-governingState">Governing law state</label><select id="lp-governingState" name="governingState">${opt(lp.options.states, pr.governingState === pr.state ? '' : pr.governingState, 'Same as business address')}</select></div>
          ${f('venueCounty', 'County for legal venue *', pr.venueCounty, 'maxlength="60"')}
        </div>
        <p class="alert" id="lp-msg" hidden></p>
        ${ro ? '' : '<button class="btn primary" type="submit">Save details</button>'}
      </fieldset></form>
      <section class="card stack" id="tc"></section>`;

    const form = document.getElementById('lp');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const el = form.elements; const num = (v) => (String(v).trim() === '' ? '' : Number(v));
      const profile = {
        legalName: el.legalName.value, addressLine1: el.addressLine1.value, addressLine2: el.addressLine2.value, city: el.city.value, state: el.state.value, postalCode: el.postalCode.value,
        licenseNumber: el.licenseNumber.value, licenseAuthority: el.licenseAuthority.value, insured: el.insured.checked, insuranceCarrier: el.insuranceCarrier.value,
        taxConfirmed: el.taxConfirmed.checked, balanceDue: el.balanceDue.value, warrantyDays: num(el.warrantyDays.value), lateFeePercent: num(el.lateFeePercent.value),
        returnedPaymentFeeCents: toCents(el.returnedPaymentFee.value), cancellationNoticeHours: num(el.cancellationNoticeHours.value), cancellationFeeCents: toCents(el.cancellationFee.value),
        estimateValidDays: num(el.estimateValidDays.value), hourlyRateCents: toCents(el.hourlyRate.value), marketingPhotos: el.marketingPhotos.checked,
        governingState: el.governingState.value, venueCounty: el.venueCounty.value,
      };
      try {
        await api('/api/legal-profile', { method: 'PUT', body: { profile, tax_rate_bp: toCents(el.tax.value) } });
        flash(document.getElementById('lp-msg'), 'Saved. Review the updated draft below.');
        renderTerms(await api('/api/customer-terms'));
      } catch (err) {
        const fe = err.data && err.data.field_errors;
        flash(document.getElementById('lp-msg'), fe ? 'Please fix: ' + Object.values(fe).join(' ') : err.message, 'err');
      }
    });
    renderTerms(ct);
  }

  function renderTerms(ct) {
    const box = document.getElementById('tc');
    if (!ct.profile_complete) { box.innerHTML = '<h2>2. Review and approve</h2><p class="muted">Save your business details above (everything marked *) to generate your draft.</p>'; return; }
    const a = ct.approved;
    const base = a && !ct.needs_review ? a.markdown : ct.draft;
    const status = !a ? '<p class="alert err">Not approved yet. Online payments turn on after you approve.</p>'
      : ct.needs_review ? `<p class="alert err">Your details or the template changed since version ${a.version}. Customers still see version ${a.version} until you approve this update.${a.source === 'customized' ? ' Your last version had your own edits; re-apply any you still need.' : ''}</p>`
      : `<p class="alert ok">Version ${a.version} approved by ${esc(a.approver_name)}, ${esc(a.approver_title)} on ${when(a.approved_at)}.</p>`;
    box.innerHTML = `
      <h2>2. Review and give final approval</h2>
      ${status}
      <p class="small"><strong>This is a starting template, not legal advice.</strong> ${esc(ct.platform_name)} provides it for convenience and isn’t a party to your terms. Laws on warranties, refunds, cancellations, late fees and liens vary by state; have your attorney review it. You give the final approval.</p>
      <div class="terms-box" id="tc-view">${mdToHtml(base)}</div>
      <textarea id="tc-edit" rows="18" hidden aria-label="Edit the wording">${esc(base)}</textarea>
      <div class="row"><button class="btn ghost sm" type="button" id="tc-toggle">Edit wording</button><button class="btn ghost sm" type="button" id="tc-reset">Reset to template</button>${a ? `<a class="btn ghost sm" href="${esc(ct.public_url)}" target="_blank" rel="noopener">View public page</a>` : ''}</div>
      ${ct.can_approve ? `
      <form class="stack" id="tc-form">
        <h3>Final approval (business owner)</h3>
        <div class="grid2"><div><label for="tc-name">Your full name</label><input id="tc-name" name="name" required autocomplete="name"></div><div><label for="tc-title">Your title</label><input id="tc-title" name="title" required placeholder="Owner"></div></div>
        <label class="check"><input type="checkbox" name="authorized"> <span>I am an owner or officer of ${esc(ct.legal_name)} and am authorized to approve these terms on its behalf.</span></label>
        <label class="check"><input type="checkbox" name="reviewed"> <span>I have reviewed these terms, have had the opportunity to have them reviewed by an attorney, and approve them as ${esc(ct.legal_name)}’s terms with its customers.</span></label>
        <label class="check"><input type="checkbox" name="seller_of_record"> <span>${esc(ct.legal_name)} is the seller and merchant of record for its sales and is solely responsible for these terms, its services, refunds, disputes, and collecting and remitting sales tax. ${esc(ct.platform_name)} is not a party to these terms and doesn’t provide legal or tax advice.</span></label>
        <p class="small muted">Your name, title, these statements, the exact wording, the time and your IP address are recorded with the approved version.</p>
        <p class="alert" id="tc-msg" hidden></p>
        <button class="btn primary" type="submit" id="tc-approve">${a ? 'Approve as new version' : 'Approve these terms'}</button>
      </form>` : '<p class="small muted">Only the business owner can give final approval.</p>'}`;
    const view2 = document.getElementById('tc-view'), edit = document.getElementById('tc-edit');
    document.getElementById('tc-toggle').addEventListener('click', (e) => {
      const editing = view2.hidden; // switching back to preview
      if (editing) view2.innerHTML = mdToHtml(edit.value);
      view2.hidden = !editing; edit.hidden = editing; e.currentTarget.textContent = editing ? 'Edit wording' : 'Preview';
    });
    document.getElementById('tc-reset').addEventListener('click', () => {
      if (edit.value !== ct.draft && !confirm('Discard your edits and go back to the template draft?')) return;
      edit.value = ct.draft; view2.innerHTML = mdToHtml(ct.draft);
    });
    const tf = document.getElementById('tc-form');
    if (tf) tf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const el = tf.elements;
      if (!el.authorized.checked || !el.reviewed.checked || !el.seller_of_record.checked) return flash(document.getElementById('tc-msg'), 'Check all three statements to approve.', 'err');
      if (a && !ct.needs_review && edit.value === a.markdown) return flash(document.getElementById('tc-msg'), 'Nothing has changed since your approved version.', 'err');
      const btn = document.getElementById('tc-approve'); btn.disabled = true;
      try {
        const r = await api('/api/customer-terms/approve', { method: 'POST', body: { markdown: edit.value, name: el.name.value, title: el.title.value, authorized: true, reviewed: true, seller_of_record: true } });
        renderTerms(await api('/api/customer-terms'));
        flash(document.getElementById('tc-msg') || box, `Version ${r.version} approved. Customers will accept it from now on.`);
      } catch (err) { flash(document.getElementById('tc-msg'), err.message, 'err'); btn.disabled = false; }
    });
  }

  // ---------- Agilities super admin ----------
  async function superView() {
    setNav('super');
    const d = await api('/api/super/overview');
    const t = d.totals;
    const stripeTag = (r) => (r.stripe_account_id && r.stripe_account_type !== 'v2_merchant' ? '<span class="tag new">Legacy payouts</span>' : r.stripe_payouts_enabled ? '<span class="tag paid">Payments on</span>' : r.stripe_details_submitted ? '<span class="tag">Verifying</span>' : '<span class="tag void">No Stripe yet</span>')
      + (r.terms_version ? '' : '<span class="tag void">Terms not approved</span>');
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
        <div style="max-width:420px"><label for="nb-ref">Referral code (optional)</label><input id="nb-ref" name="referral_code" autocapitalize="none" spellcheck="false" placeholder="The affiliate who brought them in"></div>
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
          <div><label for="t-fee">Platform share % (application fee; blank = platform default)</label><input id="t-fee" name="fee" inputmode="decimal" value="${d.fee_bp == null ? '' : d.fee_bp / 100}"><p class="small muted">Processing Fee = Stripe’s fee (billed to the business by Stripe) + this %.</p></div>
          <div><label for="t-acct">Business’s own Stripe account</label><input id="t-acct" name="acct" value="${esc(t.stripe_account_id || '')}" placeholder="acct_…"><p class="small muted">${t.stripe_account_id && t.stripe_account_type !== 'v2_merchant' ? 'Legacy Express payout account: the owner is asked to connect their own Stripe account at next log-in.' : t.stripe_payouts_enabled ? 'Card payments on. The business is merchant of record.' : t.stripe_details_submitted ? 'Submitted, Stripe is verifying.' : t.stripe_account_id ? 'Started, not finished.' : 'Not connected yet. The owner sets it up at sign-up.'}</p></div>
          <button class="btn primary" type="submit">Save</button>
        </form>
        <section class="card stack">
          <h2>People</h2>
          ${d.users.map((u) => `<div class="row between"><div><strong>${esc(u.name || u.email)}</strong> <span class="tag">${esc(u.role)}</span><div class="small muted">${esc(u.email)} · last in ${u.last_login_at ? when(u.last_login_at) : 'never'}</div></div><button class="btn ghost sm" type="button" data-reset="${u.id}">Reset link</button></div>`).join('')}
          <h2 style="margin-top:12px">Agreements</h2>
          ${d.agreements.length ? `<ul class="small" style="margin:0;padding-left:18px">${d.agreements.map((a) => `<li>${esc(a.doc)} v${esc(a.version)} · ${esc(a.email || '')} · ${esc(a.accepted_at)} · ${esc(a.ip || '')}</li>`).join('')}</ul>` : '<p class="small muted">Not accepted yet.</p>'}
          <h2 style="margin-top:12px">Customer Terms &amp; Conditions</h2>
          ${d.customer_terms.length ? `<ul class="small" style="margin:0;padding-left:18px">${d.customer_terms.map((c) => `<li>v${c.version} (${esc(c.source)}) approved by ${esc(c.approver_name)}, ${esc(c.approver_title)} · ${esc(c.approved_at)} · ${esc(c.ip || '')}</li>`).join('')}</ul><p class="small"><a href="${esc(d.terms_url)}" target="_blank" rel="noopener">Public terms page</a></p>` : '<p class="small muted">Not approved by the owner yet. Online payments stay off until they are.</p>'}
        </section>
      </div>
      <section class="card stack">
        <h2>Payments</h2>
        ${d.payments.length ? `<div style="overflow-x:auto"><table class="items"><thead><tr><th>Date</th><th>For</th><th>Method</th><th class="num">Paid</th><th class="num">Stripe fee</th><th class="num">Platform</th><th class="num">To business</th><th>Status</th></tr></thead><tbody>${d.payments.map((p) => `<tr><td>${esc((p.paid_at || p.created_at).slice(0, 10))}${p.status === 'paid' ? '' : ' <span class="tag">' + esc(p.status) + '</span>'}</td><td>${esc(p.description)}</td><td>${esc(p.method)}</td><td class="num">${money(p.amount_cents)}</td><td class="num">${money(p.stripe_fee_cents)}</td><td class="num">${money(p.fee_cents)}</td><td class="num">${money(p.payout_cents)}</td><td>${p.method === 'card' && p.status === 'paid' ? `${esc(p.transfer_status || 'pending')}${p.transfer_error ? `<div class="small muted">${esc(p.transfer_error)}</div>` : ''}${!['sent', 'direct'].includes(p.transfer_status) ? ` <button class="btn ghost sm" type="button" data-settle="${p.id}">Retry</button>` : ''}` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No payments yet.</p>'}
      </section>`;
    referredByCard(t.id);
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
      try { const r = await api(`/api/super/payments/${b.dataset.settle}/settle`, { method: 'POST' }); await superTenantView(id); const done = ['sent', 'direct'].includes(r.transfer_status); flash(document.getElementById('st-msg'), done ? 'Done.' : `Still ${r.transfer_status}: ${r.transfer_error || ''}`, done ? 'ok' : 'err'); }
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
        <p class="small muted">Every online payment is a direct charge on the business’s own Stripe account (the business is merchant of record). Stripe bills its fee to the business; the platform collects this % as an application fee. Businesses see the total as “Processing Fee”; customers pay only the amount due.</p>
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

  // ---------- owner features: time zone ----------
  // Adds the time zone picker to the Business page. It saves with the page's Save button.
  async function ownerBusinessExtras() {
    const f = document.getElementById('bf');
    const area = document.getElementById('b-area');
    if (!f || !area) return;
    productsCard();
    let st;
    try { st = await api('/api/owner-settings'); } catch { return; }
    area.parentElement.insertAdjacentHTML('afterend', `<div style="max-width:420px"><label for="b-tz">Time zone</label>
      <select id="b-tz">${st.timezones.map(([v, l]) => `<option value="${esc(v)}" ${st.timezone === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <p class="small muted">Used for receipts, reminders and texting hours.</p></div>`);
    f.addEventListener('submit', async () => {
      const tz = document.getElementById('b-tz').value;
      if (tz === st.timezone || !isOwner()) return;
      try { st = await api('/api/owner-settings', { method: 'PUT', body: { timezone: tz } }); }
      catch (err) { flash(document.getElementById('b-msg'), err.message, 'err'); }
    });
  }

  // ---------- owner features: settings cards ----------
  async function ownerSettingsCards(cfg) {
    let st;
    try { st = await api('/api/owner-settings'); } catch { return; }
    reviewCard(st);
    payLaterCard(st, cfg);
    exportCard();
  }

  // ---------- owner features: review requests ----------
  const delayLabel = (h) => (h < 24 ? `${h} hours after they pay` : h === 24 ? '1 day after they pay' : `${h / 24} days after they pay`);
  function reviewCard(st) {
    const anchor = document.getElementById('sf');
    if (!anchor) return;
    const r = st.review, ro = isOwner() ? '' : 'disabled';
    anchor.insertAdjacentHTML('afterend', `<section class="card stack" id="rv">
      <h2>Google review requests</h2>
      ${!r.link ? `<p>Add your Google review link first. Open <a href="#/website">Website sections</a> and paste it under “Google and social links”.</p>` : `
      ${r.address_ok ? '' : '<p class="alert err">Add your mailing address in <a href="#/terms">Customer Terms details</a> to send review emails.</p>'}
      <fieldset ${ro} class="stack" style="border:0;padding:0;margin:0">
        <label class="check"><input type="checkbox" id="rv-on" ${r.enabled ? 'checked' : ''}> <span>Ask customers for a Google review after they pay</span></label>
        <div style="max-width:320px"><label for="rv-delay">When to ask</label><select id="rv-delay">${r.delays.map((h) => `<option value="${h}" ${r.delay_hours === h ? 'selected' : ''}>${delayLabel(h)}</option>`).join('')}</select></div>
        <div><label for="rv-text">Your message</label><textarea id="rv-text" rows="3" maxlength="500">${esc(r.message)}</textarea>
          <button class="linkbtn" type="button" id="rv-reset">Use the suggested message</button></div>
        <p class="small muted">We add your review link and phone number. Customers who agreed to emails get an email. Customers who agreed to texts also get a text, between 8am and 8pm. Nobody gets more than one request every ${r.repeat_days} days. Your receipts also show a “Leave us a Google review” button.</p>
        <p class="alert" id="rv-alert" hidden></p>
        ${ro ? '' : '<div><button class="btn primary" type="button" id="rv-save">Save review settings</button></div>'}
      </fieldset>`}
    </section>`);
    const save = document.getElementById('rv-save');
    if (!save) return;
    document.getElementById('rv-reset').addEventListener('click', () => { document.getElementById('rv-text').value = r.default_message; });
    save.addEventListener('click', async () => {
      const el = document.getElementById('rv-alert');
      try {
        await api('/api/owner-settings', { method: 'PUT', body: { review_requests: document.getElementById('rv-on').checked, review_delay_hours: Number(document.getElementById('rv-delay').value), review_message: document.getElementById('rv-text').value } });
        flash(el, 'Saved.');
      } catch (err) { flash(el, err.message, 'err'); }
    });
  }

  // ---------- owner features: scheduling ----------
  const JSTATUS = { scheduled: 'Scheduled', en_route: 'On the way', done: 'Done', canceled: 'Canceled' };
  const DURATIONS = [[30, '30 minutes'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'], [360, '6 hours'], [480, 'All day (8 hours)']];
  const dayAdd = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
  const dayLabel = (d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  let schedMode = 'week';

  async function scheduleView(mode, date) {
    setNav('schedule');
    mode = mode === 'day' || mode === 'week' ? mode : schedMode;
    schedMode = mode;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : '';
    const data = await api(`/api/jobs?days=${mode === 'day' ? 1 : 7}${mode === 'week' ? '&snap=week' : ''}${day ? '&from=' + day : ''}`);
    const step = mode === 'day' ? 1 : 7;
    const days = Array.from({ length: data.days }, (_, i) => dayAdd(data.from, i));
    const tzName = (TZ_NAMES[data.tz] || data.tz).replace(/ \(.*\)$/, '');
    const range = mode === 'day' ? dayLabel(data.from, { weekday: 'long', month: 'long', day: 'numeric' }) : `${dayLabel(days[0], { month: 'short', day: 'numeric' })} to ${dayLabel(days[6], { month: 'short', day: 'numeric' })}`;
    const jobItem = (j) => `
      <a class="item sched-item ${j.status}" href="#/schedule/job/${j.id}">
        <div class="sched-time"><strong>${esc(j.start_label)}</strong><span class="small muted">${esc(j.end_label)}</span></div>
        <div class="grow stack" style="gap:2px">
          <span class="item-title">${esc(j.customer_name || 'Customer')}</span>
          ${j.address ? `<span class="small">${esc(j.address.split('\n')[0]).slice(0, 120)}</span>` : ''}
          <span class="small muted">${j.assignee_name || j.assignee_email ? esc(j.assignee_name || j.assignee_email) + ' · ' : ''}${JSTATUS[j.status]}</span>
        </div>
      </a>`;
    view.innerHTML = `
      <div class="row between"><h1>Schedule</h1><a class="btn primary sm" href="#/schedule/new">+ New appointment</a></div>
      <div class="row between">
        <div class="tabs" role="group" aria-label="Show"><button type="button" data-mode="day" aria-pressed="${mode === 'day'}">Day</button><button type="button" data-mode="week" aria-pressed="${mode === 'week'}">Week</button></div>
        <div class="row" style="gap:6px">
          <a class="btn ghost sm" href="#/schedule/${mode}/${dayAdd(data.from, -step)}" aria-label="Previous ${mode}">‹ Back</a>
          <a class="btn ghost sm" href="#/schedule/${mode}/${data.today}">Today</a>
          <a class="btn ghost sm" href="#/schedule/${mode}/${dayAdd(data.from, step)}" aria-label="Next ${mode}">Next ›</a>
        </div>
      </div>
      <p class="small muted">${esc(range)} · ${esc(tzName)}</p>
      <div class="stack sched">${days.map((d) => {
        const jobs = data.jobs.filter((j) => j.date === d);
        const isToday = d === data.today;
        return `<section class="sched-day${isToday ? ' today' : ''}" ${isToday ? 'aria-current="date"' : ''}>
          ${mode === 'week' ? `<h2 class="sched-date"><a href="#/schedule/day/${d}">${esc(dayLabel(d))}</a>${isToday ? ' <span class="tag new">Today</span>' : ''}</h2>` : isToday ? '<p><span class="tag new">Today</span></p>' : ''}
          ${jobs.length ? `<div class="list">${jobs.map(jobItem).join('')}</div>` : `<p class="small muted sched-none">No appointments.${mode === 'day' ? ` <a href="#/schedule/new/date/${d}">Add one</a>` : ''}</p>`}
        </section>`;
      }).join('')}</div>
      <section class="card stack" id="cal-card">
        <h2>See your schedule in your phone’s calendar</h2>
        <p class="small">Add your appointments to Google Calendar or Apple Calendar. They update on their own about once an hour.</p>
        <div><button class="btn" type="button" id="cal-show">Get my calendar link</button></div>
        <div id="cal-box" class="stack" hidden></div>
      </section>`;
    view.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/schedule/${b.dataset.mode}/${mode === 'week' && b.dataset.mode === 'day' && days.includes(data.today) ? data.today : data.from}`; }));
    document.getElementById('cal-show').addEventListener('click', () => calendarBox());
  }
  const TZ_NAMES = { 'America/New_York': 'Eastern time', 'America/Chicago': 'Central time', 'America/Denver': 'Mountain time', 'America/Phoenix': 'Arizona time (no daylight saving)', 'America/Los_Angeles': 'Pacific time', 'America/Anchorage': 'Alaska time', 'Pacific/Honolulu': 'Hawaii time' };

  async function calendarBox(reset) {
    const box = document.getElementById('cal-box');
    let c;
    try { c = await api('/api/calendar' + (reset ? '/reset' : ''), reset ? { method: 'POST' } : {}); }
    catch (err) { box.hidden = false; box.innerHTML = `<p class="alert err">${esc(err.message)}</p>`; return; }
    const webcal = c.url.replace(/^https?:/, 'webcal:');
    document.getElementById('cal-show').hidden = true;
    box.hidden = false;
    box.innerHTML = `
      <p class="small">${c.owner ? 'Shows every appointment.' : 'Shows the appointments assigned to you.'} Anyone with this link can see your schedule, so keep it private.</p>
      <div><label for="cal-url">Your private calendar link</label><input id="cal-url" readonly value="${esc(c.url)}"></div>
      <div class="row">
        <a class="btn sm" href="${esc('https://calendar.google.com/calendar/render?cid=' + encodeURIComponent(webcal))}" target="_blank" rel="noopener">Add to Google Calendar</a>
        <a class="btn sm" href="${esc(webcal)}">Add to Apple Calendar</a>
        <button class="btn ghost sm" type="button" data-copy="${esc(c.url)}">Copy link</button>
      </div>
      <p class="small muted">Shared it by mistake? <button class="linkbtn" type="button" id="cal-reset">Make a new link</button> The old one stops working.</p>`;
    box.querySelector('[data-copy]').addEventListener('click', (e) => copy(c.url, e.target));
    document.getElementById('cal-reset').addEventListener('click', () => { if (confirm('Make a new link? Calendars using the old link stop updating, so you’ll need to add the new one.')) calendarBox(true); });
  }

  // New appointment (blank, or from a request or quote), or edit one.
  async function jobFormView(id, srcType, srcId) {
    setNav('schedule');
    const editing = Boolean(id);
    const src = srcType === 'request' ? `request_id=${encodeURIComponent(srcId)}` : srcType === 'quote' ? `quote_id=${encodeURIComponent(srcId)}` : '';
    const j = editing ? await api('/api/jobs/' + id) : await api('/api/jobs/new' + (src ? '?' + src : ''));
    const date = editing ? j.date : srcType === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(srcId || '') ? srcId : j.today;
    const back = editing ? `#/schedule/job/${j.id}` : j.quote_id ? `#/quotes/${j.quote_id}` : j.request_id ? `#/requests/${j.request_id}` : '#/schedule';
    const dur = editing ? j.duration_min : 60;
    view.innerHTML = `
      <a href="${back}" class="small">← ${editing ? 'Appointment' : j.quote_id ? 'Quote #' + j.quote_id : j.request_id ? 'Request #' + j.request_id : 'Schedule'}</a>
      <h1>${editing ? 'Change appointment' : 'New appointment'}</h1>
      <form class="stack" id="jf">
        <section class="card stack">
          <h2>When</h2>
          <div class="grid3">
            <div><label for="jf-date">Date</label><input id="jf-date" name="date" type="date" required value="${esc(date)}"></div>
            <div><label for="jf-time">Start time</label><input id="jf-time" name="time" type="time" step="900" required value="${esc(editing ? j.time : '09:00')}"></div>
            <div><label for="jf-dur">How long</label><select id="jf-dur" name="duration_min">${DURATIONS.map(([v, l]) => `<option value="${v}" ${v === dur ? 'selected' : ''}>${l}</option>`).join('')}${DURATIONS.some(([v]) => v === dur) ? '' : `<option value="${dur}" selected>${dur} minutes</option>`}</select></div>
          </div>
          <div style="max-width:420px"><label for="jf-user">Who’s going</label><select id="jf-user" name="user_id"><option value="">Not assigned</option>${j.team.map((u) => `<option value="${u.id}" ${editing && j.user_id === u.id ? 'selected' : !editing && u.id === me.user.id ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('')}</select></div>
        </section>
        <section class="card stack">
          <h2>Customer</h2>
          <div class="grid2">
            <div><label for="jf-name">Name</label><input id="jf-name" name="customer_name" autocomplete="off" value="${esc(j.customer_name)}"></div>
            <div><label for="jf-phone">Mobile phone</label><input id="jf-phone" name="customer_phone" type="tel" autocomplete="off" value="${esc(j.customer_phone)}"></div>
            <div><label for="jf-email">Email</label><input id="jf-email" name="customer_email" type="email" autocomplete="off" value="${esc(j.customer_email)}"></div>
          </div>
          <div><label for="jf-addr">Address or location</label><textarea id="jf-addr" name="address" rows="2">${esc(j.address)}</textarea></div>
          <div><label for="jf-notes">Notes for the tech</label><textarea id="jf-notes" name="notes" rows="3">${esc(j.notes)}</textarea></div>
        </section>
        <label class="check"><input type="checkbox" name="notify" checked> <span>${editing ? 'If the time changes, text and email the customer the new time and a new reminder' : 'Text and email the customer a confirmation now, and a reminder the day before at 9am'}</span></label>
        <p class="small muted">These are appointment messages, so customers get them even if they didn’t sign up for offers. Texts only go out 8am to 8pm. Customers who replied STOP don’t get texts.</p>
        <p class="alert err" id="jf-err" hidden></p>
        <div class="sticky-actions row"><button class="btn primary" type="submit">${editing ? 'Save changes' : 'Book appointment'}</button><a class="btn ghost" href="${back}">Cancel</a></div>
      </form>`;
    const f = document.getElementById('jf');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.notify = f.elements.notify.checked;
      body.duration_min = Number(body.duration_min);
      body.user_id = body.user_id ? Number(body.user_id) : null;
      if (!editing) { body.request_id = j.request_id; body.quote_id = j.quote_id; }
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      try { const saved = await api(editing ? '/api/jobs/' + id : '/api/jobs', { method: editing ? 'PUT' : 'POST', body }); location.hash = '#/schedule/job/' + saved.id; }
      catch (err) { flash(document.getElementById('jf-err'), err.message, 'err'); btn.disabled = false; }
    });
  }

  async function jobView(id) {
    setNav('schedule');
    const j = await api('/api/jobs/' + id);
    const open = j.status === 'scheduled' || j.status === 'en_route';
    const KIND = { job_confirm: 'Confirmation', job_reminder: 'Reminder', job_on_way: '“On my way”' };
    const CH = { email: 'email', sms: 'text' };
    const mstate = (m) => (m.status === 'sent' ? `Sent ${esc(m.when_label)}` : m.status === 'pending' ? (m.soon ? 'Going out now' : `Goes out ${esc(m.when_label)}`) : m.status === 'canceled' ? (m.error === 'business suspended' ? 'Not sent: your account was suspended' : 'Not sent: the time changed') : m.status === 'skipped' ? `Not sent: ${esc(m.error || '')}` : m.status === 'failed' ? 'Didn’t go through' : 'Sending');
    const canText = j.customer_phone && !j.stopped;
    view.innerHTML = `
      <a href="#/schedule/day/${esc(j.date)}" class="small">← Schedule</a>
      <div class="row between"><h1>${esc(j.customer_name || 'Customer')}</h1><span class="tag ${j.status === 'done' ? 'paid' : j.status === 'canceled' ? 'void' : j.status === 'en_route' ? 'new' : ''}">${JSTATUS[j.status]}</span></div>
      <p class="big-num" style="font-size:24px">${esc(j.when_label)} to ${esc(j.end_label)}</p>
      <div class="row">
        ${j.customer_phone ? `<a class="btn primary" href="${telHref(j.customer_phone)}">Call ${esc(j.customer_phone)}</a><a class="btn" href="${smsHref(j.customer_phone)}">Text</a>` : ''}
        ${j.address ? `<a class="btn ghost" href="${mapHref(j.address)}" target="_blank" rel="noopener">Map</a>` : ''}
      </div>
      <p class="alert" id="jv-msg" hidden></p>
      ${open ? `<section class="card stack">
        <h2>On my way</h2>
        ${!j.customer_phone ? '<p class="small">Add the customer’s mobile number to text them.</p>' : j.stopped ? '<p class="small">This customer replied STOP to texts. Give them a call instead.</p>' : !j.sms_enabled ? '<p class="small">Texting isn’t set up yet. Give the customer a call instead.</p>' : `
        <div class="row" style="align-items:flex-end">
          <div style="width:150px"><label for="omw-min">Minutes away</label><input id="omw-min" inputmode="numeric" maxlength="3" value="30"></div>
          <button class="btn primary" type="button" id="omw-send" ${j.in_text_hours ? '' : 'disabled'}>Text “On my way”</button>
        </div>
        <p class="small muted" id="omw-preview"></p>
        ${j.in_text_hours ? '' : '<p class="small">It’s outside texting hours (8am to 8pm). Give the customer a call instead.</p>'}`}
      </section>` : ''}
      <section class="card stack">
        <h2>Details</h2>
        <dl class="facts">
          ${j.address ? `<dt>Where</dt><dd>${esc(j.address)}</dd>` : ''}
          ${j.customer_phone ? `<dt>Phone</dt><dd>${esc(j.customer_phone)}</dd>` : ''}
          ${j.customer_email ? `<dt>Email</dt><dd>${esc(j.customer_email)}</dd>` : ''}
          <dt>Who’s going</dt><dd>${esc(j.assignee_name || j.assignee_email || 'Not assigned')}</dd>
          ${j.notes ? `<dt>Notes</dt><dd>${esc(j.notes)}</dd>` : ''}
          ${j.request ? `<dt>Request</dt><dd><a href="#/requests/${j.request.id}">#${j.request.id}${j.request.name ? ' · ' + esc(j.request.name) : ''}</a></dd>` : ''}
          ${j.quote ? `<dt>${j.quote.kind === 'invoice' ? 'Invoice' : 'Quote'}</dt><dd><a href="#/quotes/${j.quote.id}">#${j.quote.id} · ${esc(j.quote.title)}</a></dd>` : ''}
        </dl>
      </section>
      <section class="card stack">
        <h2>Messages to the customer</h2>
        ${j.messages.length ? `<ul class="small" style="margin:0;padding-left:20px">${j.messages.map((m) => `<li>${KIND[m.kind] || esc(m.kind)} ${CH[m.channel]}: ${mstate(m)}</li>`).join('')}</ul>` : '<p class="small muted">None. Add a phone number or email to send a confirmation and reminder.</p>'}
      </section>
      ${open ? `<div class="row">
        <a class="btn" href="#/schedule/edit/${j.id}">Change time or details</a>
        <button class="btn" type="button" data-js="done">Mark done</button>
        <button class="linkbtn" type="button" data-js="canceled">Cancel appointment</button>
      </div>` : ''}`;
    const msg = document.getElementById('jv-msg');
    const mins = document.getElementById('omw-min'), prev = document.getElementById('omw-preview');
    const preview = () => { prev.textContent = `Sends: “${bizName()} is on the way, about ${Number(mins.value) || '?'} minutes.” with your phone number.`; };
    if (mins) { mins.addEventListener('input', preview); preview(); }
    const send = document.getElementById('omw-send');
    if (send) send.addEventListener('click', async () => {
      send.disabled = true;
      try { await api(`/api/jobs/${id}/on-my-way`, { method: 'POST', body: { minutes: Number(mins.value) } }); await jobView(id); flash(document.getElementById('jv-msg'), 'Text sent.'); }
      catch (err) { flash(msg, err.message, 'err'); send.disabled = false; }
    });
    view.querySelectorAll('[data-js]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.js === 'canceled' && !confirm('Cancel this appointment? Its reminder won’t go out. We don’t tell the customer, so give them a call.')) return;
      try { await api(`/api/jobs/${id}/status`, { method: 'POST', body: { status: b.dataset.js } }); jobView(id); } catch (err) { flash(msg, err.message, 'err'); }
    }));
  }

  // Products moved off the phone menu: a card on the Business page links to them.
  function productsCard() {
    const first = view.querySelector('section.card');
    if (first) first.insertAdjacentHTML('afterend', `<section class="card stack"><h2>Products and services</h2><p>Your prices for quotes, and the services on your website.</p><div><a class="btn" href="#/products">Edit products and services</a></div></section>`);
  }

  // ---------- owner features: subscriber emails ----------
  async function campaignsView() {
    setNav('quotes');
    const st = await api('/api/campaigns');
    const n = st.subscribers;
    const blocked = !st.address.ok || !st.email_enabled || Boolean(st.next_allowed_label) || !n;
    view.innerHTML = `
      <a href="#/customers" class="small">← Customers</a>
      <h1>Email your subscribers</h1>
      <p class="muted">Send an update or an offer to customers who agreed to emails from you. ${n === 1 ? '1 person is' : n + ' people are'} signed up.</p>
      ${!st.address.ok ? '<p class="alert err">Add your business mailing address first. The law requires it in every email like this. <a href="#/terms">Add your address</a></p>' : ''}
      ${!st.email_enabled ? '<p class="alert err">Email isn’t set up on the platform yet. Contact support.</p>' : ''}
      ${st.next_allowed_label ? `<p class="alert">You can send one email a day. Your next one can go out ${esc(st.next_allowed_label)}.</p>` : ''}
      ${!n ? '<p class="alert">Nobody has signed up yet. Customers can sign up when they sign a proposal or pay an invoice.</p>' : ''}
      <form class="card stack" id="cf">
        <div><label for="cf-subj">Subject</label><input id="cf-subj" maxlength="150" placeholder="Book your spring check-up"></div>
        <div><label for="cf-body">Message</label><textarea id="cf-body" rows="10" maxlength="10000" placeholder="Hi there,&#10;&#10;Spring is a good time to check your roof seals and batteries. Book this month and get 10% off.&#10;&#10;Mike"></textarea></div>
        <p class="small muted">We add your business name, your mailing address${st.address.ok ? ` (${esc(st.address.line)})` : ''} and an unsubscribe link at the bottom. Replies go to your business email. Texts to subscribers aren’t available, because each state has its own rules for marketing texts.</p>
        <p class="alert" id="cf-msg" hidden></p>
        <div class="row"><button class="btn" type="button" id="cf-test" ${!st.address.ok || !st.email_enabled ? 'disabled' : ''}>Send me a test</button><button class="btn primary" type="submit" ${blocked ? 'disabled' : ''}>Send to ${n === 1 ? '1 subscriber' : n + ' subscribers'}</button></div>
      </form>
      <section class="card stack">
        <h2>Emails you sent</h2>
        ${st.campaigns.length ? `<div class="table-wrap" style="overflow-x:auto"><table class="items" style="min-width:520px"><thead><tr><th scope="col">Sent</th><th scope="col">Subject</th><th scope="col" class="num">People</th><th scope="col" class="num">Delivered</th><th scope="col" class="num">Not sent</th></tr></thead>
          <tbody>${st.campaigns.map((c) => `<tr><td class="small">${esc(c.when_label)}${c.status === 'sending' ? '<div class="small muted">Still sending</div>' : ''}</td><td>${esc(c.subject)}</td><td class="num">${c.recipients}</td><td class="num">${c.sent}</td><td class="num">${c.skipped + c.failed}</td></tr>`).join('')}</tbody></table></div>
          <p class="small muted">“Not sent” means the person unsubscribed before it went out, or their email didn’t go through.</p>` : '<p class="small muted">Nothing sent yet.</p>'}
      </section>`;
    const f = document.getElementById('cf'), msg = document.getElementById('cf-msg');
    const body = () => ({ subject: document.getElementById('cf-subj').value, body: document.getElementById('cf-body').value });
    document.getElementById('cf-test').addEventListener('click', async (e) => {
      try { const r = await api('/api/campaigns/test', { method: 'POST', body: body() }); flash(msg, `Test sent to ${r.to}.`); }
      catch (err) { flash(msg, err.message, 'err'); }
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm(`Send this email to ${n === 1 ? '1 person' : n + ' people'}? You can send one email a day.`)) return;
      try { await api('/api/campaigns', { method: 'POST', body: body() }); await campaignsView(); flash(document.getElementById('cf-msg'), 'Sending now. It can take a few minutes to reach everyone.'); }
      catch (err) { flash(msg, err.message, 'err'); }
    });
  }

  // ---------- owner features: pay over time ----------
  // Affirm and Klarna come from the business's own Stripe settings (Checkout shows what's turned on there).
  function payLaterCard(st, cfg) {
    const anchor = document.getElementById('st-msg');
    if (!anchor || !cfg.stripe.platform_ready) return;
    anchor.insertAdjacentHTML('beforebegin', `<div class="stack pot" id="pot">
      <h3>Offer pay over time</h3>
      <p class="small">Let customers split bigger jobs into payments with Affirm or Klarna. You get the full amount up front, and Affirm or Klarna collects from the customer.</p>
      <ol class="small" style="margin:0;padding-left:22px"><li>Open your Stripe Dashboard.</li><li>Go to Settings, then Payment methods.</li><li>Turn on Affirm and Klarna.</li></ol>
      <p class="small muted">Stripe charges a higher fee for these than for cards. Customers see them at checkout when the amount qualifies.</p>
      <label class="check small"><input type="checkbox" id="pot-on" ${st.pay_over_time ? 'checked' : ''} ${isOwner() ? '' : 'disabled'}> <span>I turned these on. Show “Pay over time available at checkout” on proposals and invoices of $50 or more.</span></label>
    </div>`);
    document.getElementById('pot-on').addEventListener('change', async (e) => {
      try { await api('/api/owner-settings', { method: 'PUT', body: { pay_over_time: e.target.checked } }); flash(document.getElementById('st-msg'), 'Saved.'); }
      catch (err) { e.target.checked = !e.target.checked; flash(document.getElementById('st-msg'), err.message, 'err'); }
    });
  }

  // ---------- owner features: accounting export ----------
  function exportCard() {
    const anchor = document.getElementById('rv') || document.getElementById('sf');
    if (!anchor || !isOwner()) return;
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    anchor.insertAdjacentHTML('afterend', `<section class="card stack" id="qb">
      <h2>Download for QuickBooks</h2>
      <p class="small">A spreadsheet of the payments you received, ready to import into QuickBooks or send to your bookkeeper. It lists the date, customer, what it was for, the amount, how they paid, processing fees, what you kept, and the receipt number.</p>
      <div class="grid2" style="max-width:520px">
        <div><label for="qb-from">From</label><input id="qb-from" type="date" value="${today.slice(0, 8)}01"></div>
        <div><label for="qb-to">To</label><input id="qb-to" type="date" value="${today}"></div>
      </div>
      <div><a class="btn" id="qb-go" href="#">Download for QuickBooks</a></div>
      <p class="small muted">Dates follow your business time zone. Card payments that Stripe is still settling show their fees in the next download.</p>
    </section>`);
    const go = document.getElementById('qb-go');
    const href = () => { go.href = `/api/exports/quickbooks.csv?from=${encodeURIComponent(document.getElementById('qb-from').value)}&to=${encodeURIComponent(document.getElementById('qb-to').value)}`; };
    ['qb-from', 'qb-to'].forEach((id) => document.getElementById(id).addEventListener('change', href));
    href();
  }

  // ---------- owner features: install on phone ----------
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(() => {}));
  let installPrompt = null; // Chrome on Android offers its own "Install" prompt; we show it from the tip
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  const tipKey = 'hp-install-tip';
  function installTip() {
    try { if (localStorage.getItem(tipKey) === 'hidden') return; } catch { /* storage blocked: show it */ }
    const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (installed || !window.matchMedia('(max-width: 720px)').matches) return;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const how = installPrompt ? '' : ios ? ' In Safari, tap the Share button, then “Add to Home Screen”.' : ' Open your browser menu, then tap “Add to Home screen” or “Install app”.';
    const head = view.querySelector('.row.between');
    if (!head || document.getElementById('install-tip')) return;
    head.insertAdjacentHTML('afterend', `<section class="card install-tip" id="install-tip" aria-label="Tip">
      <img src="/static/brand/icon-192.png" alt="" width="44" height="44">
      <div class="grow stack" style="gap:6px"><strong>Add HitchPoint to your home screen</strong><p class="small">Open your jobs in one tap, like an app.${how}</p>
        ${installPrompt ? '<div><button class="btn primary sm" type="button" id="it-add">Add to home screen</button></div>' : ''}</div>
      <button class="linkbtn small" type="button" id="it-x" aria-label="Hide this tip">Not now</button>
    </section>`);
    const hide = () => { try { localStorage.setItem(tipKey, 'hidden'); } catch { /* fine */ } document.getElementById('install-tip')?.remove(); };
    document.getElementById('it-x').addEventListener('click', hide);
    document.getElementById('it-add')?.addEventListener('click', async () => {
      installPrompt.prompt();
      const choice = await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      if (choice && choice.outcome === 'accepted') hide();
    });
  }

  // ---------- router ----------
  async function loadMe() { me = await api('/api/me', { quiet: true }).catch(() => ({ authed: false })); if (!me.authed) me = null; return me; }
  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [a, b, c] = h.split('/');
    if (a === 'reset' && b) return showAuth('reset', b);
    if (a === 'join' && b) { if (!me) await loadMe(); return joinView(b); } // affiliate invitation link
    if (!me) await loadMe();
    if (!me) return showAuth(['signup', 'forgot'].includes(a) ? a : 'login');
    if (me.needs_agreements) return agreementsView();
    if (me.needs_payout_setup) return onboardingView(a === 'onboarding' ? b : '');
    if (me.tenant && me.tenant.status !== 'active' && !isSuper()) { showChrome(false); view.innerHTML = '<section class="card login stack"><h1>Account suspended</h1><p>Contact Agilities support to restore access.</p><button class="btn ghost" type="button" id="lo">Log out</button></section>'; document.getElementById('lo').addEventListener('click', logout); return; }
    showChrome(true); buildChrome();
    try {
      if (isAffiliateUser()) {
        if (a === 'account') await affiliateDetailsView();
        else await affiliateView();
      } else if (!me.tenant) {
        if (a === 'super' && b) await superTenantView(b);
        else if (a === 'platform') await platformView();
        else if (a === 'leads') await leadsView();
        else if (a === 'affiliates') await superAffiliatesView(b);
        else await superView();
      } else if (a === 'requests' && b === 'new') newRequestView();
      else if (a === 'requests' && b) await requestView(b);
      else if (a === 'quotes' && b === 'photo') photoQuoteView(c);
      else if (a === 'quotes' && b) await quoteView(b);
      else if (a === 'customers') await customersView();
      else if (a === 'schedule' && b === 'new') await jobFormView(null, c, h.split('/')[3]);
      else if (a === 'schedule' && b === 'job' && c) await jobView(c);
      else if (a === 'schedule' && b === 'edit' && c) await jobFormView(c);
      else if (a === 'schedule') await scheduleView(b, c);
      else if (a === 'emails') await campaignsView();
      else if (a === 'quotes') await quotesView();
      else if (a === 'products') await productsView();
      else if (a === 'business') await businessView();
      else if (a === 'website') await websiteView();
      else if (a === 'settings') await settingsView(b);
      else if (a === 'terms') await termsView();
      else if (a === 'affiliate' && b === 'details') await affiliateDetailsView();
      else if (a === 'affiliate') await affiliateView();
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
