'use strict';
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
    var data = { type: k === 'repair' ? 'repair' : 'booking', product_id: k === 'repair' ? null : Number(k), location: v('location'), phone: v('phone'), name: v('name'), rig: v('rig'), issue: v('issue'), preferred_date: k === 'repair' ? '' : v('preferred_date'), website: v('website') };
    resize(f.elements.photo.files[0]).then(function (photo) {
      if (photo) data.photo = photo;
      return fetch('/api/public/t/' + encodeURIComponent(slug) + '/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not send.'); }); })
      .then(function () { document.getElementById('sent-phone').textContent = v('phone'); f.hidden = true; document.getElementById('sent').hidden = false; })
      .catch(function (ex) { err.textContent = ex.message + ' Please call or text us instead.'; err.hidden = false; btn.disabled = false; btn.textContent = 'Send request'; });
  });
})();
