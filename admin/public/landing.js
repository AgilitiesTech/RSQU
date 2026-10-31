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
