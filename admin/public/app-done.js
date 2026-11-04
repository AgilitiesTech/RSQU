'use strict';
// app-done.html: if Stripe's setup link expired, say so (the page itself covers finishing normally).
if (/[?&]expired=1/.test(location.search)) {
  document.getElementById('t').textContent = 'That Stripe link expired';
  document.getElementById('m').textContent = 'Tap Done at the top of the screen to go back to the HitchPoint app, then tap Connect Stripe again.';
}
