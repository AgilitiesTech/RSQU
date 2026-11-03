// Drafts a repair proposal from photos a technician takes on site, using Claude's vision through the
// Anthropic Messages API. The draft is only a starting point: the technician reviews and edits every
// line before the customer sees it. Prices come from the business's own price list; anything not on
// it comes back at $0, flagged for the technician to price.

const TOOL = {
  name: 'draft_proposal',
  description: 'Return the drafted repair proposal.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short proposal title, 2-6 words, e.g. "Awning arm replacement".' },
      customer_summary: { type: 'string', description: 'Plain-language summary for the customer, 2-4 sentences: what was found and what the work will do. No jargon, no prices.' },
      findings: { type: 'array', items: { type: 'string' }, description: 'What is visible in the photos, one observation each. Say when something is uncertain.' },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            product_id: { type: ['integer', 'null'], description: 'ID from the price list when an entry fits; otherwise null.' },
            name: { type: 'string' },
            description: { type: 'string', description: 'One short sentence the customer will read.' },
            quantity: { type: 'number' },
            is_labor: { type: 'boolean', description: 'True for a labor line billed by the hour.' },
          },
          required: ['name', 'quantity'],
        },
      },
      safety_notes: { type: 'array', items: { type: 'string' }, description: 'Hazards visible in the photos (propane, burned wiring, water near electrical, structural damage). Empty if none.' },
      questions_for_technician: { type: 'array', items: { type: 'string' }, description: 'What the technician should confirm on site before sending the proposal.' },
    },
    required: ['title', 'customer_summary', 'findings', 'line_items'],
  },
};

function systemPrompt({ businessName, servicePhrase, hourlyRateCents }) {
  return [
    `You help ${businessName}, a ${servicePhrase.toLowerCase()} business, draft a repair proposal from photos the technician took at the customer's RV.`,
    'Rules:',
    '- Describe only what the photos show. Do not guess at hidden causes; when unsure, say so in findings and add a question for the technician.',
    '- Use entries from the price list whenever one fits, with its product_id. Do not invent prices; the business sets every price.',
    '- For work or parts that are not on the price list, add a line with product_id null. The technician will price it.',
    hourlyRateCents ? '- If the job needs hourly labor beyond the price list, add one line named "Labor" with is_labor true and your best estimate of hours as the quantity.' : '- Do not add hourly labor lines; this business prices labor through its price list.',
    '- Keep the customer summary plain and calm. No prices, no blame, no guarantees.',
    '- List any safety hazards you can see. If you see signs of a propane leak, fire or electrical burning, say so first.',
    `Call the ${TOOL.name} tool with your draft.`,
  ].join('\n');
}

export async function draftProposal({ apiKey, model, apiBase, images, note, rig, business, products, hourlyRateCents, timeoutMs = 90_000 }) {
  const priceList = products.map((p) => ({ product_id: p.id, name: p.name, description: p.description || '', price: (p.price_cents / 100).toFixed(2) }));
  const context = [
    rig ? `RV: ${rig}` : '',
    note ? `Technician's note: ${note}` : '',
    `Price list (JSON): ${JSON.stringify(priceList)}`,
    hourlyRateCents ? `Hourly labor rate: $${(hourlyRateCents / 100).toFixed(2)}` : '',
  ].filter(Boolean).join('\n');
  const body = {
    model,
    max_tokens: 4000,
    system: systemPrompt({ businessName: business.name, servicePhrase: business.servicePhrase, hourlyRateCents }),
    tools: [TOOL],
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text: `${context}\n\nDraft the proposal from these ${images.length} photo${images.length === 1 ? '' : 's'}.` },
      ],
    }],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${apiBase.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The AI draft took too long.' : 'Couldn’t reach the AI service.');
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`The AI service returned an error (${res.status}${data.error?.type ? ': ' + data.error.type : ''}).`);
  const use = (data.content || []).find((c) => c.type === 'tool_use' && c.name === TOOL.name);
  let out = use?.input;
  if (!out) { // fall back to JSON in a text reply
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const m = /\{[\s\S]*\}/.exec(text);
    try { out = m ? JSON.parse(m[0]) : null; } catch { out = null; }
  }
  if (!out || typeof out !== 'object') throw new Error('The AI didn’t return a usable draft.');
  return { draft: out, model: data.model || model, usage: data.usage || null };
}

// Turns the AI's draft into quote lines the app trusts: price-list entries use the business's own
// name and price; anything else is $0 and flagged; labor uses the business's hourly rate.
export function normalizeDraft(draft, products, hourlyRateCents) {
  const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);
  const list = (v, n, len) => (Array.isArray(v) ? v.map((x) => str(x, len)).filter(Boolean).slice(0, n) : []);
  const byId = new Map(products.map((p) => [Number(p.id), p]));
  const items = (Array.isArray(draft.line_items) ? draft.line_items : []).slice(0, 20).map((li) => {
    const qty = Math.min(100, Math.max(0.25, Math.round((Number(li?.quantity) || 1) * 4) / 4));
    const p = byId.get(Number(li?.product_id));
    if (p) return { product_id: p.id, name: p.name, description: str(li.description, 300) || p.description || '', qty, unit_cents: p.price_cents, taxable: p.taxable ? 1 : 0, needs_price: false };
    const name = str(li?.name, 120);
    if (!name) return null;
    if (li?.is_labor && hourlyRateCents) return { product_id: null, name: 'Labor', description: str(li.description, 300) || 'Estimated hours; final hours may vary.', qty, unit_cents: hourlyRateCents, taxable: 0, needs_price: false, estimate: true };
    return { product_id: null, name, description: str(li.description, 300), qty, unit_cents: 0, taxable: 0, needs_price: true };
  }).filter(Boolean);
  return {
    title: str(draft.title, 120) || 'Repair proposal',
    summary: str(draft.customer_summary, 1500),
    findings: list(draft.findings, 12, 300),
    safety: list(draft.safety_notes, 8, 300),
    questions: list(draft.questions_for_technician, 8, 300),
    items,
  };
}
