// Customer-facing receipt and email-unsubscribe pages, plus the consent wording shown when a customer
// signs a proposal. The exact wording is stored with each consent.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (c, d) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : d);
export const money = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' }) : '');
const METHOD = { card: 'Card or bank (online)', cash: 'Cash', check: 'Check', other: 'Other' };

export const consentText = {
  email: (biz) => `Email me updates and offers from ${biz}. I can unsubscribe anytime.`,
  sms: (biz) => `Text me service reminders and offers from ${biz} at the number above. Message frequency varies. Msg & data rates may apply. Reply STOP to cancel, HELP for help. Consent isn't required to buy.`,
};

function page(t, title, body) {
  const p = hex(t.primary_color, '#B0141C');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | ${esc(t.name)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#F3F4F6;color:#1D1F23;font:17px/1.5 system-ui,-apple-system,'Segoe UI',Arial,sans-serif}
.top{background:${p};color:#fff;padding:16px max(16px,env(safe-area-inset-left))}.top strong{font-size:20px}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px;display:grid;gap:16px}
.card{background:#fff;border:1px solid #DFE2E6;border-radius:10px;padding:20px}
h1{font-size:26px;margin:0}h2{font-size:18px;margin:0 0 8px}p{margin:0}.muted{color:#5B616A;font-size:15px}
table{width:100%;border-collapse:collapse}td,th{padding:8px 0;border-bottom:1px solid #ECEEF1;text-align:left;vertical-align:top}th{font-size:14px;color:#5B616A;font-weight:600}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.total td{font-weight:700;border-bottom:0}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}dt{color:#5B616A}dd{margin:0}
.paid{display:inline-block;border:2px solid #1E7B4A;color:#1E7B4A;font-weight:800;letter-spacing:.08em;padding:2px 10px;border-radius:4px;text-transform:uppercase}
.btn{display:inline-block;background:${p};color:#fff;border:0;border-radius:6px;padding:12px 20px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
a{color:${p}}
</style></head><body>
<header class="top"><strong>${esc(t.name)}</strong></header>
<main>${body}</main></body></html>`;
}

export function renderReceipt({ t, pay, quote, items, totals, proposalUrl }) {
  const rows = quote && items.length
    ? `<table><thead><tr><th>Work and parts</th><th class="num">Amount</th></tr></thead><tbody>
      ${items.map((it) => `<tr><td>${esc(it.name)}${Number(it.qty) !== 1 ? ` <span class="muted">× ${Number(it.qty)}</span>` : ''}</td><td class="num">${money(Math.round(it.qty * it.unit_cents))}</td></tr>`).join('')}
      ${totals.tax ? `<tr><td>Sales tax</td><td class="num">${money(totals.tax)}</td></tr>` : ''}
      ${totals.credit ? `<tr><td>Deposit paid earlier</td><td class="num">−${money(totals.credit)}</td></tr>` : ''}
      <tr class="total"><td>Paid today</td><td class="num">${money(pay.amount_cents)}</td></tr></tbody></table>`
    : `<table><tbody><tr><td>${esc(pay.description)}</td><td class="num">${money(pay.amount_cents)}</td></tr><tr class="total"><td>Paid</td><td class="num">${money(pay.amount_cents)}</td></tr></tbody></table>`;
  return page(t, 'Receipt', `
  <div class="card" style="display:grid;gap:10px">
    <span class="paid">Paid</span>
    <h1>Receipt ${money(pay.amount_cents)}</h1>
    <dl><dt>Receipt</dt><dd>#${pay.id}</dd><dt>Date</dt><dd>${day(pay.paid_at)}</dd><dt>Paid by</dt><dd>${esc(METHOD[pay.method] || pay.method)}</dd>${quote ? `<dt>For</dt><dd>${esc(quote.title)} (proposal #${quote.id})</dd>` : ''}</dl>
  </div>
  <div class="card">${rows}</div>
  <div class="card" style="display:grid;gap:8px">
    <h2>Questions about this job?</h2>
    <p>${t.phone ? `Call or text ${esc(t.name)} at <a href="tel:${esc(String(t.phone).replace(/[^\d+]/g, ''))}">${esc(t.phone)}</a>` : `Contact ${esc(t.name)}`}${t.email ? ` or email <a href="mailto:${esc(t.email)}">${esc(t.email)}</a>` : ''}.</p>
    ${proposalUrl ? `<p><a href="${esc(proposalUrl)}">View the signed proposal</a></p>` : ''}
    <p class="muted">${esc(t.name)} is the seller for this job. Card payments are processed by Stripe.</p>
  </div>`);
}

export function renderUnsubscribe({ t, customer, done, actionPath }) {
  if (!customer) return page(t, 'Unsubscribe', '<div class="card"><h1>Link not found</h1><p>This unsubscribe link isn’t valid. Reply to the email instead and the business will remove you.</p></div>');
  if (done || !customer.email_opt_in) return page(t, 'Unsubscribed', `<div class="card" style="display:grid;gap:8px"><h1>You’re unsubscribed</h1><p>${esc(t.name)} won’t send you update or offer emails. You’ll still get receipts for work you pay for.</p></div>`);
  return page(t, 'Unsubscribe', `<div class="card" style="display:grid;gap:12px"><h1>Unsubscribe from ${esc(t.name)}?</h1><p>You’ll stop getting update and offer emails at ${esc(customer.email)}. Receipts for work you pay for still come.</p>
  <form method="post" action="${esc(actionPath)}"><button class="btn" type="submit">Unsubscribe</button></form></div>`);
}
