// Helpers for the owner features: business time zone, quiet hours, customer message wording,
// calendar feeds, CSV export cells, review settings and the postal address for update emails.
// Pure functions only; the routes and the background sender live in server.js.
import * as siteProfile from './site-profile.js';
import * as customerTerms from './customer-terms.js';

// ---------- time zones ----------
export const DEFAULT_TIMEZONE = 'America/Denver';
export const US_TIMEZONES = [
  ['America/New_York', 'Eastern time'],
  ['America/Chicago', 'Central time'],
  ['America/Denver', 'Mountain time'],
  ['America/Phoenix', 'Arizona time (no daylight saving)'],
  ['America/Los_Angeles', 'Pacific time'],
  ['America/Anchorage', 'Alaska time'],
  ['Pacific/Honolulu', 'Hawaii time'],
];
export const validTimezone = (tz) => US_TIMEZONES.some(([v]) => v === tz);
export const tzOf = (t) => (t && validTimezone(t.timezone) ? t.timezone : DEFAULT_TIMEZONE);

const fmtCache = new Map();
function parts(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}
// The wall-clock date and time in a time zone.
export function localParts(date, tz) {
  const o = {};
  for (const p of parts(tz).formatToParts(date)) o[p.type] = p.value;
  const hour = Number(o.hour) % 24;
  return { year: Number(o.year), month: Number(o.month), day: Number(o.day), hour, minute: Number(o.minute), second: Number(o.second), date: `${o.year}-${o.month}-${o.day}`, time: `${String(hour).padStart(2, '0')}:${o.minute}` };
}
function offsetMs(ms, tz) {
  const s = Math.floor(ms / 1000) * 1000;
  const p = localParts(new Date(s), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s;
}
// A wall-clock date ('YYYY-MM-DD') and time ('HH:MM') in a time zone, as an instant.
export function zonedTimeToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // second pass settles daylight-saving edges
  return new Date(t);
}
export const utcString = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
export const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
export const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
export const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const todayIn = (tz, now = new Date()) => localParts(now, tz).date;

export function formatWhen(date, tz) {
  const d = new Date(date);
  const day = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} at ${formatTime(d, tz)}`;
}
export const formatTime = (date, tz) => new Date(date).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
export const formatDate = (date, tz) => new Date(date).toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' });

// ---------- quiet hours for texts: 8am to 8pm in the business's time zone ----------
export const TEXT_HOURS = { start: 8, end: 20 };
export function inTextHours(date, tz) {
  const h = localParts(new Date(date), tz).hour;
  return h >= TEXT_HOURS.start && h < TEXT_HOURS.end;
}
// The next 8am (local) at or after `date`.
export function nextTextWindow(date, tz) {
  const p = localParts(new Date(date), tz);
  const day = p.hour < TEXT_HOURS.start ? p.date : addDays(p.date, 1);
  return zonedTimeToUtc(day, `${String(TEXT_HOURS.start).padStart(2, '0')}:00`, tz);
}

// ---------- reviews ----------
export const DEFAULT_REVIEW_MESSAGE = 'Thanks for choosing us! If you’re happy with the work, would you leave us a quick Google review? It helps other RV owners find us.';
export const REVIEW_DELAYS = [2, 4, 12, 24, 48, 72];
export const REVIEW_REPEAT_DAYS = 90;
export function reviewSettings(t) {
  const link = siteProfile.parseProfile(t.site_profile).links.google_review || '';
  const enabled = t.review_requests == null ? true : Boolean(t.review_requests); // on by default once there's a link
  const delayHours = REVIEW_DELAYS.includes(Number(t.review_delay_hours)) ? Number(t.review_delay_hours) : 24;
  return { link, enabled, active: Boolean(link) && enabled, delayHours, message: t.review_message || DEFAULT_REVIEW_MESSAGE, custom: Boolean(t.review_message) };
}
// The receipt page link (only when the business asks for reviews).
export const reviewLink = (t) => { const r = reviewSettings(t); return r.active ? r.link : ''; };

// ---------- postal address for update emails (from Customer Terms details) ----------
export function postalAddress(t) {
  const p = customerTerms.parseProfile(t.legal_profile) || {};
  const missing = ['addressLine1', 'city', 'state', 'postalCode'].filter((k) => !String(p[k] || '').trim());
  const line = [p.addressLine1, p.addressLine2, [p.city, [p.state, p.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter((x) => String(x || '').trim()).join(', ');
  return { ok: missing.length === 0, missing, name: p.legalName || t.name, line };
}

// ---------- customer messages ----------
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const phoneLine = (t) => (t.phone ? `Questions? Call or text ${t.phone}.` : '');
const shortAddr = (a) => String(a || '').split('\n')[0].trim().slice(0, 80);

export function jobMessage(kind, channel, { t, job, tz, updated = false, minutes }) {
  const when = formatWhen(new Date(job.start_at.replace(' ', 'T') + 'Z'), tz);
  const where = shortAddr(job.address);
  const hi = first(job.customer_name);
  if (kind === 'job_on_way') {
    return { text: `${t.name} is on the way, about ${minutes} minutes.${t.phone ? ` Questions? Call ${t.phone}.` : ''}` };
  }
  if (kind === 'job_confirm') {
    if (channel === 'sms') return { text: `${t.name}: ${updated ? 'Your appointment changed. You’re now booked for' : 'You’re booked for'} ${when}${where ? ` at ${where}` : ''}. ${phoneLine(t)} Reply STOP to opt out.`.replace(/\s+/g, ' ').trim() };
    return {
      subject: `${updated ? 'Updated appointment' : 'Your appointment'} with ${t.name}: ${when}`,
      text: [`Hi${hi ? ' ' + hi : ''},`, '', `${updated ? 'Your appointment changed. You’re now booked' : 'You’re booked'} with ${t.name}.`, '', `When: ${when}`, where ? `Where: ${job.address}` : '', '', `Need to change it? ${t.phone ? `Call or text ${t.phone}` : 'Reply to this email'}.`, '', t.name].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
    };
  }
  // job_reminder
  if (channel === 'sms') return { text: `${t.name}: Reminder, we’ll see you tomorrow, ${when}${where ? ` at ${where}` : ''}. Need to change it? ${t.phone ? `Call ${t.phone}.` : 'Reply here.'} Reply STOP to opt out.` };
  return {
    subject: `Reminder: ${t.name} tomorrow, ${when}`,
    text: [`Hi${hi ? ' ' + hi : ''},`, '', `This is a reminder that ${t.name} will see you tomorrow.`, '', `When: ${when}`, where ? `Where: ${job.address}` : '', '', `Need to change it? ${t.phone ? `Call or text ${t.phone}` : 'Reply to this email'}.`, '', t.name].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
  };
}

// The "we got your request" reply a customer gets right after sending the website form.
export function requestAck(channel, { t, r }) {
  const hi = first(r.name);
  const now = t.phone ? ` Need help right now? Call ${t.phone}.` : '';
  if (channel === 'sms') return { text: `${t.name}: Thanks${hi ? ' ' + hi : ''}, we got your request and will call or text you soon.${now} Reply STOP to opt out.` };
  const facts = [r.location && `Where: ${r.location}`, r.rig && `Vehicle: ${r.rig}`, r.issue && `What’s going on: ${r.issue}`].filter(Boolean);
  return {
    subject: `We got your request: ${t.name}`,
    text: [`Hi${hi ? ' ' + hi : ''},`, '', `Thanks for reaching out to ${t.name}. We got your request and will call or text you soon at ${r.phone}.`,
      ...(facts.length ? ['', ...facts] : []), '',
      t.phone ? `Need help right now? Call or text ${t.phone}.` : 'Reply to this email if anything changes.', '', t.name].join('\n'),
  };
}

// Emails carry the business's name and mailing address (`address` from postalAddress()), like update emails.
export function reviewMessage(channel, { t, name, link, message, unsubUrl, address }) {
  const hi = first(name);
  if (channel === 'sms') return { text: `${t.name}: ${message} ${link}${t.phone ? ` Questions? Call ${t.phone}.` : ''} Reply STOP to opt out.` };
  const lines = [`Hi${hi ? ' ' + hi : ''},`, '', message, '', `Leave a review: ${link}`, '', '--', t.name,
    address.name && address.name !== t.name ? address.name : null, address.line || null, phoneLine(t) || null];
  if (unsubUrl) lines.push('', `You’re getting this because you agreed to emails from ${t.name}. Unsubscribe: ${unsubUrl}`);
  return { subject: `How did we do? ${t.name}`, text: lines.filter((l) => l !== null).join('\n') };
}

export function campaignEmail({ t, subject, body, address, unsubUrl }) {
  const footer = ['', '--', t.name, address.name && address.name !== t.name ? address.name : '', address.line, t.phone ? `Call or text ${t.phone}` : '', '', `You’re getting this because you agreed to updates and offers from ${t.name}.`, `Unsubscribe: ${unsubUrl}`];
  return { subject, text: String(body).replace(/\r\n/g, '\n').trim() + '\n' + footer.filter((l, i) => l !== '' || i < 2 || footer[i - 1] !== '').join('\n') };
}

// ---------- calendar feed (RFC 5545) ----------
const icsText = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n|\r/g, '\\n');
function fold(line) {
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export function icsCalendar({ name, tz, host, events, now = new Date() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HitchPoint//Schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(name)}`, `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:job-${e.id}@${host}`, `DTSTAMP:${icsStamp(now)}`, `DTSTART:${icsStamp(e.start)}`, `DTEND:${icsStamp(e.end)}`,
      `SUMMARY:${icsText(e.summary)}`, ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []), ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
      `STATUS:${e.canceled ? 'CANCELLED' : 'CONFIRMED'}`, ...(e.updated ? [`LAST-MODIFIED:${icsStamp(e.updated)}`] : []), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- CSV ----------
// Every cell quoted; anything a spreadsheet could read as a formula gets a leading apostrophe.
// Money is passed as { usd: cents }, so a refund's minus sign stays a plain number.
export function csvCell(v) {
  if (v && typeof v === 'object' && 'usd' in v) return `"${(Math.round(Number(v.usd) || 0) / 100).toFixed(2)}"`;
  let x = String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ');
  if (/^[=+\-@\t\r]/.test(x) || /^\s+[=+\-@]/.test(x)) x = "'" + x;
  return '"' + x.replace(/"/g, '""') + '"';
}
