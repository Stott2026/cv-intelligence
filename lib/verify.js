// Server-side checks that run on everything the model returns, so the app never shows
// a figure that is not in the CV, a company over the size limit, or an invented link.

export const SIZE_LIMIT = 1000; // hard ceiling: companies above this are never shown
export const SIZE_OPTIONS = [50, 200, 500, 1000];

export function sizeLimit(value) {
  const n = Number(value);
  return SIZE_OPTIONS.includes(n) ? n : SIZE_LIMIT;
}

// "1,200" -> "1200", "4.5" -> "4.5". Returns every number written in the text.
export function numbersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    out.push(m[0].replace(/,(?=\d{3}\b)/g, '').replace(/,$/, ''));
  }
  return out;
}

export function cvNumberSet(cvText) {
  return new Set(numbersIn(cvText));
}

// True when every number in `text` also appears somewhere in the CV.
export function onlyCvNumbers(text, cvNumbers) {
  return numbersIn(text).every((n) => cvNumbers.has(n));
}

// Removes any sentence that contains a number the CV does not contain.
export function stripUnverifiedSentences(text, cvNumbers) {
  const sentences = String(text || '').match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [];
  return sentences.filter((s) => onlyCvNumbers(s, cvNumbers)).join('').trim();
}

// Achievements: keep "From CV" only when the figure and every number in the
// statement are in the CV. Anything else becomes "Inferred - check" with no figure,
// and inferred items that still contain numbers not in the CV are dropped.
export function checkAchievements(items, cvNumbers) {
  const kept = [];
  for (const item of items || []) {
    const figure = String(item.figure || '').trim();
    const statement = String(item.statement || '').trim();
    if (!statement) continue;
    const figureOk = figure !== '' && numbersIn(figure).length > 0 && onlyCvNumbers(figure, cvNumbers);
    const statementOk = onlyCvNumbers(statement, cvNumbers);
    if (item.source === 'From CV' && figureOk && statementOk) {
      kept.push({ figure, statement, source: 'From CV', cvQuote: item.cvQuote || '' });
    } else if (statementOk) {
      kept.push({ figure: '', statement, source: 'Inferred - check', cvQuote: '' });
    }
  }
  return kept;
}

// Selling points: drop any that quote a number the CV does not contain.
export function checkSellingPoints(items, cvNumbers) {
  return (items || [])
    .filter((p) => onlyCvNumbers(`${p.point} ${p.detail}`, cvNumbers))
    .map((p) => ({ ...p, source: p.source === 'From CV' ? 'From CV' : 'Inferred - check' }));
}

// Companies: drop anything without a believable size or above the chosen limit.
export function checkCompanies(items, limit) {
  const max = Math.min(sizeLimit(limit), SIZE_LIMIT);
  return (items || []).filter((c) => {
    const n = Number(c.approxEmployees);
    return c.name && Number.isInteger(n) && n > 0 && n <= max;
  });
}

// URL comparison that ignores tracking parameters, trailing slashes, case of host and #fragments.
export function normaliseUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|mc_|ref$|source$)/i.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.protocol = 'https:';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

// Keep only vacancies whose link appeared in the web search results.
export function checkVacancies(items, seenUrls) {
  const seen = new Set([...seenUrls].map(normaliseUrl).filter(Boolean));
  const out = [];
  const used = new Set();
  for (const v of items || []) {
    const url = normaliseUrl(v.url);
    if (!url || !seen.has(url) || used.has(url)) continue;
    used.add(url);
    out.push({ ...v, url: String(v.url).trim() });
  }
  return out;
}

// House style: spaced hyphen instead of em or en dashes.
export function houseStyle(value) {
  if (typeof value === 'string') return value.replace(/\s*[—–]\s*/g, ' - ');
  if (Array.isArray(value)) return value.map(houseStyle);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'url' ? v : houseStyle(v)]));
  }
  return value;
}
