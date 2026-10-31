/* Sends website requests to Mike's dashboard.
   Set the dashboard address in each page's <meta name="rsqu-api" content="https://...">.
   If it isn't set, or the dashboard can't be reached, the request opens as a
   pre-filled text message to Mike instead, so nothing is lost. */
(function () {
  var MIKE_SMS = '+18012324995';
  var meta = document.querySelector('meta[name="rsqu-api"]');
  var api = meta && meta.content ? meta.content.replace(/\/$/, '') : '';

  function resizePhoto(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type)) return resolve(null);
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 1600, s = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function smsText(d) {
    var lines = [d.type === 'winterize' ? 'Winterizing booking ($499)' : 'RV repair request'];
    if (d.name) lines.push('Name: ' + d.name);
    lines.push('Phone: ' + d.phone, 'Location: ' + d.location);
    var rig = d.rig || [d.year, d.make, d.model].filter(Boolean).join(' ');
    if (rig) lines.push('RV: ' + rig);
    if (d.preferred_date) lines.push('Preferred date: ' + d.preferred_date);
    if (d.issue) lines.push('Problem: ' + d.issue);
    return lines.join('\n');
  }

  // Resolves to 'sent' (delivered to the dashboard) or 'sms' (text app opened).
  window.rsquSubmit = function (data, photoFile) {
    function fallback() {
      location.href = 'sms:' + MIKE_SMS + '?&body=' + encodeURIComponent(smsText(data));
      return 'sms';
    }
    if (!api) return Promise.resolve(fallback());
    return resizePhoto(photoFile).then(function (photo) {
      if (photo) data.photo = photo;
      return fetch(api + '/api/public/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return 'sent';
    }).catch(fallback);
  };
})();
