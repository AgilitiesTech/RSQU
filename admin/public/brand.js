'use strict';
// Applies the business's brand to the customer-facing pages.
window.applyBrand = function (b) {
  if (!b) return;
  const head = document.getElementById('doc-head');
  if (/^#[0-9a-fA-F]{6}$/.test(b.primary_color || '')) { head.style.background = b.primary_color; document.documentElement.style.setProperty('--red', b.primary_color); }
  const name = document.getElementById('biz-name');
  name.textContent = '';
  if (b.logo) { const img = document.createElement('img'); img.src = b.logo; img.alt = ''; img.style.cssText = 'height:36px;border-radius:4px;background:#fff'; name.appendChild(img); }
  const span = document.createElement('span'); span.textContent = b.name; name.appendChild(span);
  const ph = document.getElementById('biz-phone');
  if (b.phone) { ph.textContent = b.phone; ph.href = 'tel:' + b.phone.replace(/[^\d+]/g, ''); ph.hidden = false; }
  document.title = (document.title ? document.title + ' · ' : '') + b.name;
};
window.contactLine = function (b) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return b && b.phone ? `Questions? Call or text ${esc(b.name)} at <a href="tel:${esc(b.phone.replace(/[^\d+]/g, ''))}">${esc(b.phone)}</a>.` : '';
};
