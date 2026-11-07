'use strict';
// Where this visitor came from, kept for 90 days in this browser (per business) and sent with the
// request form, so the owner can see which ads, Google profile links, partners and pages bring in
// work. A visit with tracking tags (utm_*) or a Google Ads click ID replaces what's stored; a visit
// from another site replaces only an untagged one; a direct visit never replaces anything.
var hpLeadSource = (function () {
  var m = document.querySelector('meta[name="rsqu-business"]');
  var key = 'hp_src:' + (m ? m.getAttribute('content') : location.host), DAYS90 = 90 * 864e5;
  function get() {
    try { var v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' && Date.now() - v.t < DAYS90 ? v : null; } catch (e) { return null; }
  }
  function put(v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private window or storage off */ } }
  var touch = { t: Date.now(), landing: location.pathname }, tagged = false, q;
  try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid'].forEach(function (k) {
    var v = q && q.get(k); if (v) { touch[k] = v.slice(0, 300); tagged = true; }
  });
  try { var r = document.referrer ? new URL(document.referrer) : null; if (r && r.host !== location.host) touch.referrer = r.hostname; } catch (e) { /* no referrer */ }
  touch.tagged = tagged;
  var cur = get();
  if (tagged || !cur || (touch.referrer && !cur.tagged)) { put(touch); cur = touch; }
  return function () { return get() || cur; };
})();

// Google Analytics / Google Ads, only on sites whose owner added their IDs (the server then also
// allows Google's hosts in this page's security policy). Counts sent requests and taps on call and
// text buttons.
var hpTrack = (function () {
  var el = document.getElementById('hp-track'), c = null;
  try { c = el ? JSON.parse(el.textContent) : null; } catch (e) { c = null; }
  if (!c || !(c.ga4 || c.ads)) return function () {};
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  if (c.ga4) window.gtag('config', c.ga4);
  if (c.ads) window.gtag('config', c.ads);
  var s = document.createElement('script'); s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(c.ga4 || c.ads);
  document.head.appendChild(s);
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="tel:"], a[href^="sms:"]'); if (!a) return;
    var call = a.getAttribute('href').indexOf('tel:') === 0;
    window.gtag('event', call ? 'click_to_call' : 'click_to_text', { link_location: a.closest('header') ? 'header' : a.closest('footer') ? 'footer' : 'page' });
    if (call && c.ads && c.call) window.gtag('event', 'conversion', { send_to: c.ads + '/' + c.call });
  });
  return function (kind, params) {
    if (kind !== 'request') return;
    window.gtag('event', 'generate_lead', params || {});
    if (c.ads && c.request) window.gtag('event', 'conversion', { send_to: c.ads + '/' + c.request });
  };
})();

// Videos load YouTube's player only when a visitor presses play (faster pages, no tracking until then).
(function () {
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-yt]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    var f = document.createElement('iframe');
    f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(a.getAttribute('data-yt')) + '?autoplay=1&rel=0';
    f.title = a.getAttribute('data-title') || 'Video';
    f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin'; // YouTube's player needs to know which site embeds it
    var box = document.createElement('div'); box.className = 'yt'; box.appendChild(f);
    a.replaceWith(box);
  });
})();

(function () {
  var f = document.getElementById('req-form'); if (!f) return;
  var slug = f.getAttribute('data-slug');
  var err = document.getElementById('err'), status = document.getElementById('loc-status');
  var kind = document.getElementById('kind'), dateWrap = document.getElementById('date-wrap');
  if (kind) kind.addEventListener('change', function () { dateWrap.hidden = kind.value === 'repair'; });

  document.getElementById('gps').addEventListener('click', function () {
    var loc = f.elements.location;
    if (!navigator.geolocation) { status.textContent = 'This device can’t share its location.'; return; }
    status.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(function (p) {
      loc.value = (loc.value.trim() ? loc.value.trim() + '\n' : '') + 'GPS: ' + p.coords.latitude.toFixed(5) + ', ' + p.coords.longitude.toFixed(5);
      status.textContent = 'Location added.';
    }, function () { status.textContent = 'Couldn’t get your location. Type it instead.'; }, { enableHighAccuracy: true, timeout: 10000 });
  });

  function resize(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type)) return resolve(null);
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }

  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = function (n) { return (f.elements[n] && f.elements[n].value || '').trim(); };
    if (!v('location') || !v('phone')) { err.textContent = 'Add where you are and a phone number so we can reach you.'; err.hidden = false; return; }
    err.hidden = true;
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Sending…';
    var k = kind ? kind.value : 'repair';
    var data = { type: k === 'repair' ? 'repair' : 'booking', product_id: k === 'repair' ? null : Number(k), location: v('location'), phone: v('phone'), name: v('name'), email: v('email'), heard_about: v('heard_about'), rig: v('rig'), issue: v('issue'), preferred_date: k === 'repair' ? '' : v('preferred_date'), website: v('website'), source: hpLeadSource() };
    resize(f.elements.photo.files[0]).then(function (photo) {
      if (photo) data.photo = photo;
      return fetch('/api/public/t/' + encodeURIComponent(slug) + '/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not send.'); }); })
      .then(function () { try { hpTrack('request', { form_type: data.type }); } catch (e) { /* never block the thank-you */ } document.getElementById('sent-phone').textContent = v('phone'); f.hidden = true; document.getElementById('sent').hidden = false; })
      .catch(function (ex) { err.textContent = ex.message + ' Please call or text us instead.'; err.hidden = false; btn.disabled = false; btn.textContent = 'Send request'; });
  });
})();

// Questions page: send a question. Nothing shows on the site until the business answers it.
(function () {
  var f = document.getElementById('ask-form'); if (!f) return;
  var slug = f.getAttribute('data-slug'), err = document.getElementById('ask-err');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = function (n) { return (f.elements[n] && f.elements[n].value || '').trim(); };
    if (v('question').length < 10) { err.textContent = 'Type your question (a sentence or two).'; err.hidden = false; f.elements.question.focus(); return; }
    err.hidden = true;
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/api/public/t/' + encodeURIComponent(slug) + '/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: v('question'), name: v('name'), email: v('email'), website: v('website') }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not send.'); return j; }); })
      .then(function (j) { f.hidden = true; document.getElementById('ask-sent-email').hidden = !j.email; var s = document.getElementById('ask-sent'); s.hidden = false; s.setAttribute('tabindex', '-1'); s.focus(); })
      .catch(function (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Send question'; });
  });
})();
