// Anonymous CVs: Claude removes the candidate's name, contact details and the organisations they name,
// and the server checks the result before anything uses it (the Rules in CLAUDE.md):
// - no number may appear that wasn't in the original text;
// - none of the candidate's name, and none of the names Claude says it replaced, may be left in.
// One retry, then a clear error. Nothing is stored: the anonymised text goes back to the browser.
import { ask, parseJson, ClaudeError } from './claude.js';
import { ANON_SYSTEM, ANON_SCHEMA, anonMessage } from './prompts.js';
import { cvNumberSet, numbersIn, houseStyle } from './verify.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every word of the name (3+ letters) and every listed name must be gone, matched as whole words.
export function leftovers(text, banned) {
  const found = new Set();
  for (const raw of banned) {
    const term = String(raw || '').trim();
    if (term.length < 3) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    if (re.test(text)) found.add(term);
  }
  return [...found];
}

export function checkAnonymised(original, result, name) {
  const nums = cvNumberSet([original.cvText, original.summary, ...(original.achievements || [])].join('\n'));
  const out = [result.cvText, result.summary, ...result.achievements].join('\n');
  const newNumbers = numbersIn(out).filter((n) => !nums.has(n));
  const nameWords = String(name || '').split(/\s+/).filter((w) => w.length >= 3);
  const banned = [...nameWords, ...(result.removed?.names || []), ...(result.removed?.organisations || [])];
  const left = leftovers(out, banned);
  return { ok: newNumbers.length === 0 && left.length === 0, newNumbers, left };
}

export async function anonymise({ cvText, name, summary, achievements }) {
  const original = { cvText, summary, achievements };
  let usage = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await ask({
      label: 'anonymise', system: ANON_SYSTEM, outputSchema: ANON_SCHEMA, effort: 'low', maxTokens: 16000,
      messages: [{ role: 'user', content: anonMessage({ cvText, name, summary, achievements }) }],
    });
    usage = mergeUsage(usage, result);
    const raw = parseJson(result.text);
    const clean = houseStyle({
      cvText: String(raw.cvText || ''), summary: String(raw.summary || ''),
      achievements: (raw.achievements || []).map(String).filter(Boolean).slice(0, 5), removed: raw.removed,
    });
    const check = checkAnonymised(original, clean, name);
    if (check.ok) {
      return { cvText: clean.cvText, summary: clean.summary, achievements: clean.achievements, removedCount: (clean.removed?.names?.length || 0) + (clean.removed?.organisations?.length || 0), usage };
    }
    // Log only counts, never the names or the CV.
    console.warn(JSON.stringify({ event: 'anonymise_rejected', newNumbers: check.newNumbers.length, namesLeft: check.left.length }));
  }
  throw Object.assign(new ClaudeError('Could not make a fully anonymous version of this CV. Please try again.', 502), { usage });
}

function mergeUsage(total, result) {
  const u = { ...result.usage, cost_usd: result.cost, model: result.model };
  if (!total) return u;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'web_search_requests']) total[k] += u[k];
  total.cost_usd = Math.round(((total.cost_usd || 0) + (u.cost_usd || 0)) * 10000) / 10000;
  return total;
}
