'use strict';
(function () {
  var f = document.getElementById('lead'); if (!f) return;
  var err = document.getElementById('l-err');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {}; new FormData(f).forEach(function (v, k) { data[k] = String(v).trim(); });
    data.source = document.referrer ? 'landing (from ' + document.referrer.slice(0, 120) + ')' : 'landing';
    if (!data.name || (!data.email && !data.phone)) { err.textContent = 'Add your name and an email or phone number.'; err.hidden = false; return; }
    err.hidden = true;
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/api/public/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not send.'); }); })
      .then(function () { f.hidden = true; document.getElementById('l-ok').hidden = false; })
      .catch(function (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Have someone call me'; });
  });
})();

// Referral links (/a/<code>) land here with ?ref=<code>: say who referred the visitor, and keep the
// code on the sign-up links in case the browser blocks the referral cookie.
(function () {
  var m = /[?&]ref=([a-z0-9-]{3,40})(?:&|$)/i.exec(location.search); if (!m) return;
  fetch('/api/public/referral?code=' + encodeURIComponent(m[1].toLowerCase()), { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (j) {
      if (!j || !j.code) return;
      document.querySelectorAll('a[href="/signup"]').forEach(function (a) { a.setAttribute('href', '/signup?ref=' + encodeURIComponent(j.code)); });
      var hero = document.querySelector('.hero-copy'); if (!hero || !j.name) return;
      var p = document.createElement('p');
      p.className = 'ref-note';
      p.setAttribute('style', 'display:inline-block;margin:0 0 12px;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.14);color:inherit;font-size:15px;font-weight:600');
      p.textContent = 'Referred by ' + j.name;
      hero.insertBefore(p, hero.firstChild);
    })
    .catch(function () { /* the note is optional */ });
})();
