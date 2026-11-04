// Blog posts and the questions-and-answers board on a business's website: limits, the owner's
// formatting, addresses and spam checks. Pure functions; the routes live in server.js and the pages
// in site.js. Nothing a visitor writes is shown on the site until the owner publishes it.
import { slugify } from './site-profile.js';

export const LIMITS = {
  title: 120, summary: 300, body: 20_000, posts: 500,
  question: 1000, questionShown: 300, answer: 6000, name: 80, email: 200,
  pendingQuestions: 200, // waiting for the owner; more are refused until some are answered or deleted
};
// An answered question gets its own page in Google once the answer says something (like city pages).
export const ANSWER_INDEX_MIN = 120;
export const answerIndexable = (q) => String(q.answer || '').trim().length >= ANSWER_INDEX_MIN;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const plain = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
export const oneLine = (s, max) => plain(s, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);

// Inline formatting inside one escaped line: **bold** and [words](https://link).
function inline(line) {
  return esc(line)
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s()<>"']{1,500})\)/g, (m, text, href) => `<a href="${href}" rel="noopener">${text}</a>`);
}
// The owner's writing: blank lines between paragraphs, "## " headings, "- " bullets, **bold**, [links](https://…).
export function richText(text) {
  const out = []; let list = null;
  const flush = () => { if (list) { out.push(`<ul class="ticks">${list.join('')}</ul>`); list = null; } };
  for (const block of String(text || '').split(/\n{2,}/)) {
    const para = [];
    const endPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para.length = 0; } };
    for (const raw of block.split('\n')) {
      const l = raw.trim();
      if (!l) continue;
      if (/^[-*•] /.test(l)) { endPara(); (list ||= []).push(`<li>${inline(l.replace(/^[-*•] /, ''))}</li>`); continue; }
      flush();
      if (/^#{1,3} /.test(l)) { endPara(); out.push(`<h2>${inline(l.replace(/^#{1,3} /, ''))}</h2>`); } else para.push(inline(l));
    }
    endPara(); flush();
  }
  return out.join('\n');
}
// Text for search results and link previews: formatting marks removed.
// Each heading or bullet ends as a sentence so lines don't run together.
export const plainText = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => (/^(#{1,3}|[-*•]) /.test(l) && !/[.!?:;]$/.test(l) ? l + '.' : l))
  .join(' ').replace(/(^|\s)#{1,3} /g, '$1').replace(/(^|\s)[-*•] /g, '$1').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

// A post's or question's address: words from its title, unique within the business.
export function uniqueSlug(title, taken, fallback) {
  const base = (slugify(title) || fallback).slice(0, 80).replace(/-+$/, '') || fallback;
  let s = base, i = 2;
  while (taken(s)) s = `${base}-${i++}`;
  return s;
}

// What the owner may change on a post. Returns the cleaned fields, or throws a message.
export function cleanPost(b, current = {}, cities = []) {
  const v = (k, max, f = plain) => (b[k] !== undefined ? f(b[k], max) : current[k] ?? '');
  const out = { title: v('title', LIMITS.title, oneLine), summary: v('summary', LIMITS.summary, oneLine), body: v('body', LIMITS.body) };
  if (b.city !== undefined) {
    const c = String(b.city || '');
    if (c && !cities.includes(c)) throw new Error('Pick a town from your service area, or none.');
    out.city = c || null;
  } else out.city = current.city ?? null;
  return out;
}
export function publishProblem(p) {
  if (!p.title.trim()) return 'Give the post a title before publishing.';
  if (plainText(p.body).length < 50) return 'Write a little more before publishing (at least a few sentences).';
  return '';
}

// A visitor's question. Returns { question, name, email } or throws a message for the visitor.
const LINKY = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|info|biz|xyz|top|ru|io|co|us|me|site|online|shop|link|click)\b)/i;
export function cleanQuestion(b) {
  const question = plain(b.question, LIMITS.question + 1);
  if (question.length < 10) throw new Error('Type your question (a sentence or two).');
  if (question.length > LIMITS.question) throw new Error(`Keep your question under ${LIMITS.question} characters.`);
  if (LINKY.test(question)) throw new Error('Please leave out links and web addresses.');
  const letters = (question.match(/\p{L}/gu) || []).length;
  if (letters < question.replace(/\s/g, '').length * 0.5) throw new Error('Type your question in words.');
  const name = oneLine(b.name, LIMITS.name);
  if (LINKY.test(name)) throw new Error('Please leave out links and web addresses.');
  const email = oneLine(b.email, LIMITS.email).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Check your email address, or leave it blank.');
  return { question, name, email };
}
// What the owner publishes: the question as shown (they can shorten it or remove personal details) and the answer.
export function cleanAnswer(b, current) {
  const title = b.title !== undefined ? oneLine(b.title, LIMITS.questionShown) : current.title || oneLine(current.question, LIMITS.questionShown);
  const answer = b.answer !== undefined ? plain(b.answer, LIMITS.answer) : current.answer || '';
  return { title, answer };
}
export function answerProblem(q) {
  if (q.title.length < 10) return 'Write the question as it should appear on your site.';
  if (plainText(q.answer).length < 20) return 'Write your answer before publishing.';
  return '';
}
