// Flags companies we already have Terms with, using Client Radar's private Terms feed
// (stott2026/client-radar, GET /api/feed/terms-clients, agreed with Ian in November 2026).
// - Off unless CLIENT_RADAR_URL and TERMS_FEED_KEY are set. The key is the same value as
//   TERMS_FEED_KEY in Client Radar's Railway variables, and never reaches the browser.
// - Company information only (name, website, Terms types, date signed, account owner, archived).
//   The full list stays on the server; the page only gets the matches.
// - If Client Radar can't be reached, everything else carries on without badges.

const RADAR_URL = (process.env.CLIENT_RADAR_URL || '').trim().replace(/\/+$/, '');
const KEY = (process.env.TERMS_FEED_KEY || '').trim();
export const termsReady = /^https?:\/\//.test(RADAR_URL) && KEY.length >= 32;

const CACHE_MS = 10 * 60 * 1000; // keep the list for 10 minutes between fetches
let cache = { at: 0, clients: null };

// Words that don't tell two companies apart ("Acme Ltd" is "Acme Limited" is "Acme").
const SUFFIXES = new Set([
  'ltd', 'limited', 'plc', 'llc', 'llp', 'lp', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'ag', 'bv', 'nv', 'sa', 'sas', 'sarl', 'srl', 'spa', 'ab', 'as', 'oy', 'pty', 'pte',
  'group', 'holdings', 'holding', 'uk', 'international', 'intl', 'global',
]);

// Words often left off a company's name ("Ravelin" for "Ravelin Technology").
const GENERIC = new Set([
  'technology', 'technologies', 'tech', 'solutions', 'software', 'systems', 'labs', 'digital', 'consulting',
  'services', 'partners', 'ventures', 'io', 'ai', 'hq', 'online', 'platform', 'platforms',
]);
export function coreName(n) {
  const words = String(n || '').split(' ').filter(Boolean);
  while (words.length > 1 && GENERIC.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

export function normName(name) {
  const words = String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é -> e
    .toLowerCase().replace(/&/g, ' and ').replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (words[0] === 'the') words.shift();
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

// "jobs.lever.co/mytos/..." -> "mytos"; "careers.acme.com" -> "acme.com"
export function domainOf(url) {
  try {
    const u = new URL(String(url));
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return String(url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  }
}
const ATS_HOSTS = /(^|\.)(lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|teamtailor\.com|recruitee\.com|bamboohr\.com|personio\.(de|com)|smartrecruiters\.com|workday(jobs)?\.com|myworkdayjobs\.com)$/;

// Builds a matcher from the feed. Exact matches on the cleaned-up name, or on the employer's own website.
export function makeMatcher(clients) {
  const byName = new Map();
  const byDomain = new Map();
  const keys = (n) => [...new Set([n, n.replace(/ /g, ''), coreName(n), coreName(n).replace(/ /g, '')])].filter((k) => k.length >= 3);
  for (const c of clients || []) {
    for (const k of keys(normName(c.name))) if (!byName.has(k)) byName.set(k, c);
    const d = String(c.domain || '').toLowerCase();
    if (d && !byDomain.has(d)) byDomain.set(d, c);
  }
  const lookup = (n) => keys(n).map((k) => byName.get(k)).find(Boolean) || null;
  return function match({ name, url } = {}) {
    let hit = lookup(normName(name));
    if (!hit && url) {
      const host = domainOf(url);
      if (ATS_HOSTS.test(host)) {
        // Applicant tracking sites put the employer in the path: jobs.lever.co/<employer>/...
        const slug = (() => { try { return new URL(url).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })();
        hit = lookup(normName(slug.replace(/[-_]+/g, ' ')));
      } else {
        // The employer's own careers site: careers.acme.com matches acme.com.
        for (let h = host; h && h.includes('.') && !hit; h = h.slice(h.indexOf('.') + 1)) hit = byDomain.get(h) || null;
      }
    }
    return hit ? toBadge(hit) : null;
  };
}

function toBadge(c) {
  return {
    terms: true,
    archived: Boolean(c.archived),
    termsTypes: Array.isArray(c.termsTypes) ? c.termsTypes.slice(0, 5) : [],
    owner: c.owner || '',
    signedOn: c.signedOn || null,
    link: c.id != null ? `${RADAR_URL}/?client=${encodeURIComponent(c.id)}` : RADAR_URL,
  };
}

// The Terms list from Client Radar, cached. Returns null if the feed is off or unreachable.
export async function termsMatcher() {
  if (!termsReady) return null;
  if (cache.clients && Date.now() - cache.at < CACHE_MS) return makeMatcher(cache.clients);
  try {
    const res = await fetch(`${RADAR_URL}/api/feed/terms-clients`, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Client Radar answered ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.clients)) throw new Error('Client Radar sent an unexpected reply');
    cache = { at: Date.now(), clients: data.clients };
    console.log(JSON.stringify({ event: 'terms_feed', clients: data.clients.length }));
  } catch (err) {
    console.warn(JSON.stringify({ event: 'terms_feed_failed', message: String(err?.message || err).slice(0, 200) }));
    if (!cache.clients) return null; // nothing to fall back on: carry on without badges
  }
  return makeMatcher(cache.clients);
}

// Adds a `terms` badge to each item that matches, and puts current Terms clients first (order otherwise kept).
export function flagTerms(items, match, toKey) {
  if (!match) return items;
  const flagged = items.map((item) => ({ ...item, terms: match(toKey(item)) }));
  const rank = (i) => (i.terms && !i.terms.archived ? 0 : 1);
  return flagged.map((item, i) => [item, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([item]) => item);
}

export const radarUrl = termsReady ? RADAR_URL : '';
