// CV Intelligence - Express server.
// Serves the front end from public/ and the /api routes. It is the only part that
// holds the Anthropic API key. CVs are processed in memory and never stored.
import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractCvText, CvError } from './lib/extract.js';
import { TEMPLATES, buildPdf, buildDocx, fileBaseName, cleanFields } from './lib/format.js';
import { termsMatcher, flagTerms, termsReady, radarUrl } from './lib/terms.js';
import { anonymise } from './lib/anonymise.js';
import { wrapOwnCv } from './lib/wrap.js';
import { wordToPdf } from './lib/convert.js';
import { acceptPass, currentUser, signOut, houseSignInUrl, houseReady, backupOn } from './lib/house.js';
import { ask, parseJson, searchedUrls, searchErrors, ClaudeError, MODEL } from './lib/claude.js';
import { SENIORITY, ANALYSIS_SYSTEM, ANALYSIS_SCHEMA, analysisMessage, VACANCY_SYSTEM, vacancyMessage, EMAIL_SYSTEM, emailMessage } from './lib/prompts.js';
import {
  sizeLimit, cvNumberSet, onlyCvNumbers, numbersIn, stripUnverifiedSentences,
  checkAchievements, checkSellingPoints, checkCompanies, checkVacancies, houseStyle,
} from './lib/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MAX_CV_CHARS = 60000;
const MAX_SPEC_CHARS = 15000;

const app = express();
app.set('trust proxy', 1); // Railway sits in front of the app
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});

// Health check for Railway. Deliberately needs no access code and touches nothing else.
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Back to the House: the address of the House's hallway, from HOUSE_URL (the front door to every
// Stott and May tool). No access code needed: it only says where the button goes. Empty hides it.
app.get('/house-link', (req, res) => {
  const base = (process.env.HOUSE_URL || '').trim().replace(/\/+$/, '');
  res.json({ url: /^https?:\/\//.test(base) ? `${base}/?hallway` : null });
});

// ---- Signing in through the House (lib/house.js) ----
// A House pass in the address signs you in, then the address is tidied.
app.use(acceptPass);

// What the page needs to know at start: signed in or not, and where to sign in.
app.get('/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user = currentUser(req);
  res.json({ signedIn: Boolean(user), name: user?.name || '', signIn: houseSignInUrl(req, '/'), backup: backupOn });
});

app.post('/signout', (req, res) => {
  signOut(req, res);
  res.json({ ok: true });
});

// The page itself: if you're not signed in, go through the House (unless the backup access code is on).
app.get(['/', '/index.html'], (req, res, next) => {
  if (currentUser(req) || backupOn || !houseReady) return next();
  res.redirect(houseSignInUrl(req));
});

app.use(express.static(path.join(here, 'public'), { extensions: ['html'] }));

// ---- Everything under /api needs the access code ----
const api = express.Router();
api.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests. Wait a few minutes and try again.' } }));
api.use(express.json({ limit: '300kb' }));

function sameCode(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Signed in through the House, or (only when the backup is switched on) the old shared access code.
api.use((req, res, next) => {
  if (currentUser(req)) return next();
  const given = req.get('x-access-code') || '';
  if (backupOn && given && sameCode(given, process.env.ACCESS_CODE)) return next();
  if (!houseReady && !backupOn) return res.status(503).json({ error: 'Sign-in is not set up yet: HOUSE_URL is missing on the server.' });
  res.status(401).json({ error: 'Please sign in again.', signIn: houseSignInUrl(req, '/') });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

api.post('/check', (req, res) => res.json({ ok: true }));

// 1. Analyse a CV
api.post('/analyse', upload.single('cv'), async (req, res, next) => {
  try {
    if (!req.file) throw new CvError('Choose a CV to upload first.');
    let cvText = await extractCvText(req.file);
    if (cvText.length > MAX_CV_CHARS) cvText = cvText.slice(0, MAX_CV_CHARS);
    const jobSpec = String(req.body.jobSpec || '').trim().slice(0, MAX_SPEC_CHARS);
    const maxSize = sizeLimit(req.body.maxSize);
    const location = String(req.body.location || '').trim().slice(0, 100);

    const result = await ask({
      label: 'analysis',
      system: ANALYSIS_SYSTEM,
      messages: [{ role: 'user', content: analysisMessage({ cvText, jobSpec, maxSize, location }) }],
      outputSchema: ANALYSIS_SCHEMA,
      effort: 'medium',
    });
    const raw = parseJson(result.text);
    const nums = cvNumberSet(cvText);

    const analysis = houseStyle({
      candidate: { ...raw.candidate, summary: stripUnverifiedSentences(raw.candidate.summary, nums) },
      targetCompanies: checkCompanies(raw.targetCompanies, maxSize).map((c) => ({ ...c, whyFit: stripUnverifiedSentences(c.whyFit, nums) })),
      sellingPoints: checkSellingPoints(raw.sellingPoints, nums),
      achievements: checkAchievements(raw.achievements, nums),
      pitchGuide: {
        opening: stripUnverifiedSentences(raw.pitchGuide.opening, nums),
        steps: raw.pitchGuide.steps.filter((s) => onlyCvNumbers(`${s.title} ${s.detail}`, nums)),
        objections: raw.pitchGuide.objections.filter((o) => onlyCvNumbers(`${o.objection} ${o.response}`, nums)),
      },
      // Only ever show a job match when a job spec was pasted.
      jobMatch: jobSpec && raw.jobMatch
        ? { ...raw.jobMatch, score: Math.max(0, Math.min(100, raw.jobMatch.score)) }
        : null,
    });
    // Flag companies we already have Terms with (Client Radar), current Terms clients first.
    const match = await termsMatcher();
    analysis.targetCompanies = flagTerms(analysis.targetCompanies, match, (c) => ({ name: c.name }));

    res.json({
      analysis,
      cvText,
      filters: { maxSize, location },
      removed: { companies: raw.targetCompanies.length - analysis.targetCompanies.length },
      terms: { on: termsReady, checked: Boolean(match), radarUrl },
      usage: { ...result.usage, cost_usd: result.cost, model: result.model },
    });
  } catch (err) {
    next(err);
  }
});

// 2. Find live vacancies with web search
api.post('/vacancies', async (req, res, next) => {
  try {
    const { headline, skills, companies } = req.body || {};
    if (!headline) return res.status(400).json({ error: 'Analyse a CV first.' });
    const maxSize = sizeLimit(req.body.maxSize);
    const location = String(req.body.location || '').trim().slice(0, 100);
    const level = SENIORITY.includes(req.body.level) ? req.body.level : '';
    const nums = cvNumberSet(String(req.body.cvText || '').slice(0, MAX_CV_CHARS));

    const result = await ask({
      label: 'vacancies',
      system: VACANCY_SYSTEM,
      messages: [{ role: 'user', content: vacancyMessage({ headline, skills, location, maxSize, companies, level }) }],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10 }],
      effort: 'medium',
    });

    const errors = searchErrors(result.blocks);
    const seen = searchedUrls(result.blocks);
    if (seen.size === 0 && errors.length) {
      return res.status(502).json({ error: `Web search did not work (${errors.join(', ')}). If this keeps happening, check web search is turned on for your Anthropic organisation.` });
    }
    let found = [];
    try {
      found = parseJson(result.text);
    } catch {
      found = [];
    }
    const match = await termsMatcher();
    const vacancies = flagTerms(houseStyle(checkVacancies(Array.isArray(found) ? found : [], seen, nums)), match, (v) => ({ name: v.company, url: v.url }));
    res.json({
      vacancies,
      terms: { on: termsReady, checked: Boolean(match), radarUrl },
      checked: { returned: Array.isArray(found) ? found.length : 0, kept: vacancies.length, searchResults: seen.size },
      usage: { ...result.usage, cost_usd: result.cost, model: result.model },
    });
  } catch (err) {
    next(err);
  }
});

// 3. Write an intro email to a hiring manager
api.post('/email', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.headline || !body.cvText) return res.status(400).json({ error: 'Analyse a CV first.' });
    const nums = cvNumberSet(String(body.cvText).slice(0, MAX_CV_CHARS));
    const brief = emailMessage({
      headline: String(body.headline).slice(0, 200),
      location: String(body.location || '').slice(0, 100),
      sellingPoints: checkSellingPoints(body.sellingPoints, nums),
      achievements: checkAchievements(body.achievements, nums),
      company: String(body.company || '').slice(0, 100),
      managerName: String(body.managerName || '').slice(0, 100),
      jobTitle: String(body.jobTitle || '').slice(0, 150),
    });

    // Up to two tries: an email that quotes a number not in the CV is never returned.
    let usageTotal = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await ask({ label: 'email', system: EMAIL_SYSTEM, messages: [{ role: 'user', content: brief }], effort: 'low', maxTokens: 4000 });
      usageTotal = mergeUsage(usageTotal, result);
      const email = houseStyle(result.text.replace(/^```\w*\n?|```$/g, '').trim());
      const bad = numbersIn(email).filter((n) => !nums.has(n));
      if (bad.length === 0) return res.json({ email, usage: usageTotal });
      console.warn(JSON.stringify({ event: 'email_rejected', reason: 'numbers not in CV', numbers: bad }));
    }
    res.status(502).json({ error: 'Could not write an email using only figures from the CV. Please try again.', usage: usageTotal });
  } catch (err) {
    next(err);
  }
});

// 4. Format the CV as a Stott and May PDF or Word document (no Claude call, nothing stored)
api.post('/format', async (req, res, next) => {
  try {
    const body = req.body || {};
    const template = TEMPLATES.includes(body.template) ? body.template : null;
    const format = body.format === 'pdf' || body.format === 'docx' ? body.format : null;
    const cvText = String(body.cvText || '').slice(0, MAX_CV_CHARS);
    if (!template || !format) return res.status(400).json({ error: 'Choose a template and a file type.' });
    if (!cvText.trim()) return res.status(400).json({ error: 'Analyse a CV first.' });
    // Anonymous: the browser sends the text from /api/anonymise; the name is never shown.
    const anonymous = body.anonymous === true;
    const fields = cleanFields(body.fields, { anonymous });
    const file = format === 'pdf' ? await buildPdf({ cvText, fields, template, anonymous }) : await buildDocx({ cvText, fields, template, anonymous });
    sendFile(res, file, `${fileBaseName(fields, template)}.${format}`, format);
  } catch (err) {
    next(err);
  }
});

function sendFile(res, file, name, format) {
  res.set({
    'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  res.send(file);
}

// 5. Anonymise the CV text, summary and achievements (one Claude call, checked in lib/anonymise.js).
//    The result goes back to the browser for /api/format; nothing is stored.
api.post('/anonymise', async (req, res, next) => {
  try {
    const body = req.body || {};
    const cvText = String(body.cvText || '').slice(0, MAX_CV_CHARS);
    if (!cvText.trim()) return res.status(400).json({ error: 'Analyse a CV first.' });
    const out = await anonymise({
      cvText,
      name: String(body.name || '').slice(0, 100),
      summary: String(body.summary || '').slice(0, 1500),
      achievements: (Array.isArray(body.achievements) ? body.achievements : []).map((a) => String(a).slice(0, 300)).slice(0, 5),
    });
    res.json(out);
  } catch (err) {
    if (err.usage) console.warn(JSON.stringify({ event: 'anonymise_failed_cost', cost_usd: err.usage.cost_usd }));
    next(err);
  }
});

// 6. The candidate's own CV, untouched, in a Stott and May frame with a cover sheet (PDF only).
api.post('/format-own', upload.single('cv'), async (req, res, next) => {
  try {
    if (!req.file) throw new CvError('Choose the CV to upload first.');
    const fname = req.file.originalname || '';
    const isPdf = /\.pdf$/i.test(fname) || req.file.mimetype === 'application/pdf';
    const isDocx = /\.docx$/i.test(fname);
    if (!isPdf && !isDocx) throw new CvError('The candidate\'s own CV option works with PDF and Word (.docx) CVs.', 422);
    let fields = {};
    try { fields = JSON.parse(String(req.body.fields || '{}')); } catch { fields = {}; }
    const clean = cleanFields(fields);
    const pdf = isPdf ? req.file.buffer : await wordToPdf(req.file.buffer);
    const file = await wrapOwnCv({ pdf, fields: clean });
    sendFile(res, file, `${fileBaseName(clean, 'own')}.pdf`, 'pdf');
  } catch (err) {
    next(err);
  }
});

function mergeUsage(total, result) {
  const u = { ...result.usage, cost_usd: result.cost, model: result.model };
  if (!total) return u;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'web_search_requests']) total[k] += u[k];
  total.cost_usd = Math.round(((total.cost_usd || 0) + (u.cost_usd || 0)) * 10000) / 10000;
  return total;
}

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Errors: show a plain message, never a stack trace.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 10 MB. Please upload a smaller CV.' : 'The upload did not work. Please try again.';
    return res.status(400).json({ error: msg });
  }
  if (err instanceof CvError || err instanceof ClaudeError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`CV Intelligence running on http://localhost:${PORT} (model ${MODEL})`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('Warning: ANTHROPIC_API_KEY is not set.');
  if (!process.env.ACCESS_CODE) console.warn('Warning: ACCESS_CODE is not set, so every /api request will be refused.');
});
