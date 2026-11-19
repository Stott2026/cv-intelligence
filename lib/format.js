// Formats a candidate's CV into a Stott and May branded PDF or Word document.
// Three templates, matching Ian's CV Formatter Artifact:
//   basic  - the CV only, with the brand bar and a black address footer
//   medium - a Candidate Profile page, then the CV
//   long   - a cover page, the Candidate Profile page, the CV and a "Get in touch" page
// Everything happens in memory for this request only. Nothing is stored or logged.
//
// The CV layout rules (spotting headings, job titles, dates, bullets and skills lists) and the
// removal of the candidate's own email, phone and home address are ported from that Artifact,
// so both tools produce the same structure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  AlignmentType, VerticalAlign, Header, Footer, LevelFormat, LineRuleType, TableLayoutType, TabStopType, Tab, SimpleField,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType,
} from 'docx';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(here, 'fonts');
const FONTS = {
  head: path.join(FONT_DIR, 'Manrope-ExtraBold.ttf'),
  headBold: path.join(FONT_DIR, 'Manrope-Bold.ttf'),
  body: path.join(FONT_DIR, 'Inter-Regular.ttf'),
  bodySemi: path.join(FONT_DIR, 'Inter-SemiBold.ttf'),
  bodyBold: path.join(FONT_DIR, 'Inter-Bold.ttf'),
};

export const TEMPLATES = ['basic', 'medium', 'long'];
export const ADDRESS = 'Cannon Green, 27 Bush Lane, London EC4R 0AA';
export const WEBSITE = 'www.stottandmay.com';

// Brand colours (Stott and May brand skill): ink, slate label grey, border grey, light page, teal and aquamarine.
const C = { ink: '#111314', slate: '#7A8798', line: '#C3CAD2', mist: '#ECEEF3', white: '#FFFFFF', teal: '#00C8C8', aqua: '#73F7BB' };

// ---------------------------------------------------------------------------
// The details a consultant can fill in (all plain text, length-capped)
// ---------------------------------------------------------------------------
const FIELD_LIMITS = {
  name: 100, location: 100, vacancyTitle: 150, availability: 100, salary: 100, nationality: 100,
  summary: 1500, keyAchievements: 1500, company: 100, vacancyName: 150,
  consultantName: 100, consultantTitle: 100, email: 150, phone: 50, linkedin: 150,
};

export function cleanFields(raw) {
  const out = {};
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    out[key] = String(raw?.[key] ?? '').replace(/\r/g, '').trim().slice(0, max);
  }
  return out;
}

// Up to five achievement lines, without any bullet the consultant typed.
export function achievementLines(text) {
  return String(text || '').split('\n').map((l) => l.replace(/^[\s•\-*]+/, '').trim()).filter(Boolean).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Removing the candidate's own contact details from the CV body
// (so a client can't go around Stott and May). Best-effort, always on.
// ---------------------------------------------------------------------------
export const REDACT_PLACEHOLDER = 'Contact details available via Stott and May.';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 9 to 15 digits with spaces, dots, dashes or brackets between: a phone number, but not a year or a headcount.
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const UK_POSTCODE_RE = /\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/;
const ADDRESS_LABEL_RE = /^(home\s+)?address\s*:/i;
// Links to a personal profile or site (LinkedIn, GitHub and so on) are contact routes too.
const PROFILE_LINK_RE = /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com)\/[^\s,;]*/gi;

function redactPhone(m) {
  const digits = m.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15 ? REDACT_PLACEHOLDER : m;
}

export function redactPersonalDetails(text) {
  const lines = String(text || '').split('\n').map((line) => {
    if (ADDRESS_LABEL_RE.test(line.trim()) || UK_POSTCODE_RE.test(line)) return REDACT_PLACEHOLDER;
    return line.replace(EMAIL_RE, REDACT_PLACEHOLDER).replace(PROFILE_LINK_RE, REDACT_PLACEHOLDER).replace(PHONE_RE, redactPhone);
  });
  // Fold a run of redacted lines (a contact block) into one notice.
  const out = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].includes(REDACT_PLACEHOLDER)) {
      let j = i + 1, end = j;
      while (j < lines.length) {
        if (lines[j].includes(REDACT_PLACEHOLDER)) { j++; end = j; } else if (lines[j].trim() === '') j++; else break;
      }
      out.push(REDACT_PLACEHOLDER);
      i = end;
    } else { out.push(lines[i]); i++; }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Turning CV text into blocks: headings, job title lines, dates, bullets, skills, paragraphs.
// Pattern-based (no AI); anything unclear stays a plain paragraph.
// ---------------------------------------------------------------------------
const BULLET_RE = /^(?:[•▪●◦*]|[-–—])\s+/;
const BULLET_O_RE = /^o\s+/;
const HEADING_WORDS = new Set([
  'profile', 'summary', 'professional summary', 'personal statement', 'objective', 'career objective',
  'experience', 'work experience', 'employment history', 'career history', 'professional experience', 'career summary',
  'education', 'education and qualifications', 'academic history', 'academic background',
  'skills', 'key skills', 'core skills', 'technical skills', 'competencies', 'core competencies',
  'certifications', 'certificates', 'qualifications', 'licenses', 'licences',
  'achievements', 'key achievements', 'accomplishments',
  'projects', 'key projects', 'publications', 'languages', 'interests', 'hobbies',
  'references', 'training', 'awards', 'volunteering', 'additional information',
  'contact', 'contact details', 'contact information', 'personal details', 'top skills',
  'honors-awards', 'honours-awards', 'honors', 'honours', 'honours and awards', 'honors and awards',
]);
const SKILLS_HEADINGS = new Set(['skills', 'key skills', 'core skills', 'technical skills', 'competencies', 'core competencies', 'top skills']);
const DATE_RANGE_RE = /^(?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2}\s*(?:[–—-]|to)\s*(?:(?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2}|present|current|now)\.?$/i;

const isBullet = (l) => BULLET_RE.test(l) || BULLET_O_RE.test(l);
const stripBullet = (l) => l.replace(BULLET_RE, '').replace(BULLET_O_RE, '').trim();
const normHeading = (l) => l.toLowerCase().replace(/[:\-–—]+$/, '').trim();
const endsTerminal = (s) => /[.!?:;]\s*$/.test(String(s || '').trim());

function isHeading(line) {
  const norm = normHeading(line);
  if (HEADING_WORDS.has(norm)) return true;
  const parts = norm.split(/\s*(?:&|and|\/)\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => HEADING_WORDS.has(p))) return true;
  // A short all-capitals line reads as a section heading even if it isn't on the list.
  return line.length <= 30 && !/[–—,]/.test(line) && !/\d/.test(line)
    && /^[A-Z][A-Z\s&/'-]*$/.test(line) && line.trim().split(/\s+/).length <= 4;
}
function labelledSkills(line) {
  const m = line.match(/^([A-Za-z][A-Za-z0-9 &/'()-]{1,40}):\s*(.+)$/);
  if (!m) return null;
  const rest = m[2].trim();
  if (!rest || /[.!?]$/.test(rest)) return null;
  const items = rest.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return items.length >= 2 ? { label: m[1].trim(), items } : null;
}
function isRoleLine(line) {
  const t = line.trim();
  return !/[.!?;:]$/.test(t) && t.length <= 100 && /\s[–—-]\s/.test(t);
}

export function parseCvBlocks(text) {
  // PDF exports often split a word across lines with a hyphen ("vali-\ndation"): join it back up.
  text = String(text || '').replace(/([a-z])-\n\s*([a-z])/g, '$1$2');
  const blocks = [];
  let openBullets = null, last = null, heading = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(?:page\s*)?\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?$/i.test(line)) continue; // a page number from the original file
    if (line === REDACT_PLACEHOLDER) { // where the candidate's contact details were: shows the consultant's instead
      if (!blocks.some((b) => b.type === 'contact')) blocks.push({ type: 'contact' });
      openBullets = null; last = null;
      continue;
    }
    if (isBullet(line)) {
      const item = { text: stripBullet(line) };
      if (!openBullets) { openBullets = { type: 'bullets', items: [] }; blocks.push(openBullets); }
      openBullets.items.push(item);
      last = item;
      continue;
    }
    if (isHeading(line)) {
      blocks.push({ type: 'heading', text: line });
      heading = normHeading(line); openBullets = null; last = null;
      continue;
    }
    if (DATE_RANGE_RE.test(line)) {
      blocks.push({ type: 'date', text: line }); openBullets = null; last = null;
      continue;
    }
    if (heading && SKILLS_HEADINGS.has(heading)) {
      const labelled = labelledSkills(line);
      if (labelled) { blocks.push({ type: 'skills', ...labelled }); openBullets = null; last = null; continue; }
      // One skill per line (as in LinkedIn's PDF export): collect the short lines into one row of tags.
      if (line.length <= 50 && !endsTerminal(line) && !line.includes(':') && !/[,;]/.test(line)) {
        const prev = blocks[blocks.length - 1];
        if (prev && prev.type === 'skills' && !prev.label) prev.items.push(line); else blocks.push({ type: 'skills', items: [line] });
        openBullets = null; last = null;
        continue;
      }
    }
    // A line that continues an unfinished sentence (PDF exports wrap lines) joins the previous one.
    if (last && !endsTerminal(last.text)) {
      last.text += ' ' + line;
    } else {
      openBullets = null;
      const role = isRoleLine(line);
      const para = { type: 'para', text: line, role };
      blocks.push(para);
      last = role ? null : para;
    }
  }
  // "Skills" followed by one comma-separated line reads better as a row of tags.
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type !== 'heading' || !SKILLS_HEADINGS.has(normHeading(blocks[i].text))) continue;
    const next = blocks[i + 1];
    if (next && next.type === 'para' && /[,;]/.test(next.text)) {
      const items = next.text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      if (items.length >= 2) blocks[i + 1] = { type: 'skills', items };
    }
  }
  // A divider goes above each job title line except the first one under a heading.
  blocks.forEach((b, i) => { if (b.type === 'para' && b.role && i > 0 && blocks[i - 1].type !== 'heading') b.divider = true; });
  return blocks;
}

export function fileBaseName(fields, template) {
  const who = (fields.name || 'Candidate').replace(/[^\p{L}\p{N} .'-]/gu, '').trim() || 'Candidate';
  const label = { basic: 'CV', medium: 'Profile and CV', long: 'Candidate Pack' }[template] || 'CV';
  return `${who} - Stott and May ${label}`;
}

// ---------------------------------------------------------------------------
// The look, from the Stott and May brand skill (layout-patterns.md and the example collateral):
// - cover (Full pack): dark page, logo top-left, white display headline with the last line in aquamarine,
//   a soft teal glow and the glowing wave line;
// - inner pages: light #ECEEF3, eyebrow in teal with a hairline rule, Manrope Bold headline with the key
//   phrase in teal, content in white rounded cards (Inter inside cards);
// - footer on every inner page: hairline, the stack brand mark bottom-left, uppercase tracked text in
//   #7A8798 and a two-digit page number;
// - closing (Full pack): radial gradient, logo top-left, near-black and white text only, the brand's
//   closing line and "About Stott and May" boilerplate.
// The page backgrounds are images from lib/assets/ (scripts/make-word-assets.py), shared by the PDF and
// Word file so the two match. All text is real text.
// ---------------------------------------------------------------------------
export const BOILERPLATE = [
  'Founded in 2009, Stott and May is a professional search firm with a passion for helping leaders achieve complete confidence that they have hired the right talent - first time - in fiercely competitive markets. We believe you should never have to make the choice between candidate quality and time to hire.',
  "As a result, our business has been founded on the principle of offering a premier standard of search service delivered in vastly accelerated timescales that our competition simply cannot match. Because after all, this is about more than just recruitment, it's about turning your business vision into reality.",
];
const ASSETS = path.join(here, 'assets');
const IMG = {
  cover: fs.readFileSync(path.join(ASSETS, 'page-cover.jpg')),
  resume: fs.readFileSync(path.join(ASSETS, 'page-resume.jpg')),
  closing: fs.readFileSync(path.join(ASSETS, 'page-closing.jpg')),
  stack: fs.readFileSync(path.join(ASSETS, 'stack-mark.png')),
};
const STACK_RATIO = 263 / 256; // height / width of stack-mark.png
const A4 = { w: 595.28, h: 841.89 };
const M = 48; // text margin (the CV card's edge plus its padding)
const CARD = { x: 28, y: 28, w: A4.w - 56, bottom: A4.h - 60, r: 16 }; // same as scripts/make-word-assets.py
const RESUME_MARGINS = { top: 52, bottom: A4.h - CARD.bottom + 20, left: M, right: M };

const headline = (f) => ({ main: f.name || 'Candidate', accent: f.vacancyTitle || '' });
function footerText(f, template) {
  const left = template === 'basic' ? `Stott and May  ·  ${ADDRESS}` : `Stott and May candidate profile  ·  ${WEBSITE}`;
  return { left: left.toUpperCase(), right: (f.name || 'Candidate').toUpperCase() };
}
// The consultant's details: on the closing page, and in the CV where the candidate's own were removed.
function consultantLines(f) {
  const lines = [];
  if (f.consultantName || f.consultantTitle) lines.push([f.consultantName, f.consultantTitle].filter(Boolean).join(', '));
  if (f.email) lines.push(`Email: ${f.email}`);
  if (f.phone) lines.push(`Phone: ${f.phone}`);
  if (f.linkedin) lines.push(`LinkedIn: ${f.linkedin}`);
  return lines;
}
const hasConsultant = (f) => consultantLines(f).length > 0;

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
export function buildPdf({ cvText, fields, template }) {
  const f = cleanFields(fields);
  const blocks = parseCvBlocks(redactPersonalDetails(cvText));
  // Pages pdfkit adds by itself (when the CV runs over) use these settings.
  const doc = new PDFDocument({
    size: 'A4', margins: RESUME_MARGINS, bufferPages: true, autoFirstPage: false,
    info: { Title: fileBaseName(f, template), Author: 'Stott and May', Creator: 'CV Intelligence' },
  });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const inner = []; // pages that get the brand footer
  if (template === 'long') pdfCover(doc, f);
  if (template !== 'basic') { pdfProfile(doc, f); inner.push(doc.bufferedPageRange().count - 1); }

  // The CV: each page is the light page with a white card, including pages pdfkit adds itself.
  let inResume = true;
  const onPage = () => { if (inResume) { doc.image(IMG.resume, 0, 0, { width: A4.w, height: A4.h }); inner.push(doc.bufferedPageRange().count - 1); } };
  doc.on('pageAdded', onPage);
  doc.addPage({ size: 'A4', margins: RESUME_MARGINS });
  pdfPageHead(doc, 'Candidate resume', headline(f), 22);
  pdfCvBlocks(doc, blocks, f);
  inResume = false;

  if (template === 'long') pdfClosing(doc, f);

  const { left, right } = footerText(f, template);
  for (const p of inner) { doc.switchToPage(p); pdfFooter(doc, left, `${right}  -  ${String(p + 1).padStart(2, '0')}`); }
  doc.end();
  return done;
}

// Writes text without letting pdfkit start a new page (for footers and fixed pages).
function fixedText(doc, text, x, y, opts) {
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.text(text, x, y, { lineBreak: false, ...opts });
  doc.page.margins.bottom = bottom;
}

// Eyebrow in teal with a hairline rule under it, then the headline with its key phrase in teal.
function pdfPageHead(doc, eyebrow, head, size) {
  const x = M, w = A4.w - 2 * M;
  doc.font('body').fontSize(8).fillColor(C.teal);
  fixedText(doc, eyebrow.toUpperCase(), x, 52, { characterSpacing: 1.2 });
  doc.moveTo(x, 66).lineTo(x + w, 66).lineWidth(0.5).strokeColor(C.line).stroke();
  doc.font('headBold').fontSize(size).fillColor(C.ink).text(head.main, x, 78, { width: w, lineGap: -2 });
  if (head.accent) doc.fillColor(C.teal).text(head.accent, x, doc.y, { width: w, lineGap: -2 });
  doc.y += 16;
}

function pdfFooter(doc, left, right) {
  const y = A4.h - 34, w = 10;
  doc.save();
  doc.moveTo(M, y - 12).lineTo(A4.w - M, y - 12).lineWidth(0.5).strokeColor(C.line).stroke();
  doc.image(IMG.stack, M, y - 3, { width: w });
  doc.font('body').fontSize(6.5).fillColor(C.slate);
  fixedText(doc, left, M + w + 8, y, { characterSpacing: 0.9 });
  fixedText(doc, right, A4.w - M - doc.widthOfString(right, { characterSpacing: 0.9 }), y, { characterSpacing: 0.9 });
  doc.restore();
}

function pdfCover(doc, f) {
  doc.addPage({ size: 'A4', margin: 0 });
  doc.image(IMG.cover, 0, 0, { width: A4.w, height: A4.h });
  const x = 56, w = A4.w - 112;
  doc.font('body').fontSize(9).fillColor(C.aqua);
  fixedText(doc, 'CANDIDATE PROFILE', x, 300, { characterSpacing: 1.4 });
  doc.font('head').fontSize(42).fillColor(C.white).text(f.name || 'Candidate', x, 322, { width: w, lineGap: -4 });
  doc.fillColor(C.aqua).text(f.vacancyName || f.vacancyTitle || 'Candidate profile', x, doc.y, { width: w, lineGap: -4 });
  doc.font('body').fontSize(12).fillColor(C.white)
    .text(f.company ? `Prepared for ${f.company} by Stott and May` : 'Prepared by Stott and May', x, doc.y + 14, { width: w });
  doc.font('body').fontSize(8).fillColor(C.slate);
  fixedText(doc, WEBSITE.toUpperCase(), x, A4.h - 64, { characterSpacing: 1.2 });
}

function pdfProfile(doc, f) {
  doc.addPage({ size: 'A4', margin: 0 });
  doc.rect(0, 0, A4.w, A4.h).fill(C.mist);
  pdfPageHead(doc, 'Candidate profile', headline(f), 28);
  const x = M, w = A4.w - 2 * M, gap = 10, tw2 = (w - gap) / 2;
  let y = doc.y + 4;

  // Key facts as white tiles, two per row.
  const facts = [
    ['Candidate name', f.name], ['Location', f.location], ['Vacancy job title', f.vacancyTitle],
    ['Availability / notice', f.availability], ['Salary expectations', f.salary], ['Nationality', f.nationality],
  ];
  for (let i = 0; i < facts.length; i += 2) {
    const pair = facts.slice(i, i + 2);
    doc.font('bodySemi').fontSize(11);
    const h = Math.max(...pair.map(([, v]) => doc.heightOfString(v || '-', { width: tw2 - 28 }))) + 40;
    pair.forEach(([label, value], j) => {
      const tx = x + j * (tw2 + gap);
      doc.roundedRect(tx, y, tw2, h, 14).fill(C.white);
      doc.font('body').fontSize(7).fillColor(C.slate);
      fixedText(doc, label.toUpperCase(), tx + 14, y + 13, { characterSpacing: 0.9 });
      doc.font('bodySemi').fontSize(11).fillColor(C.ink).text(value || '-', tx + 14, y + 27, { width: tw2 - 28 });
    });
    y += h + gap;
  }
  y += 8;

  // Summary and achievements in white cards, kept on this one page.
  const lines = achievementLines(f.keyAchievements);
  y = pdfCard(doc, y, 'Candidate summary', (cy, measureOnly) => {
    doc.font('body').fontSize(10);
    const h = doc.heightOfString(f.summary || '-', { width: w - 36, lineGap: 3 });
    if (!measureOnly) doc.fillColor(C.ink).text(f.summary || '-', x + 18, cy, { width: w - 36, lineGap: 3 });
    return h;
  });
  pdfCard(doc, y + gap, 'Key achievements', (cy, measureOnly) => {
    let h = 0;
    for (const item of (lines.length ? lines : ['-'])) {
      doc.font('body').fontSize(10);
      const ih = doc.heightOfString(item, { width: w - 52, lineGap: 3 });
      if (!measureOnly) {
        if (lines.length) doc.circle(x + 21, cy + h + 6, 2).fill(C.teal);
        doc.fillColor(C.ink).text(item, x + 32, cy + h, { width: w - 52, lineGap: 3 });
      }
      h += ih + 6;
    }
    return h - 6;
  });
}

function pdfCard(doc, y, label, draw) {
  const x = M, w = A4.w - 2 * M;
  const maxBottom = A4.h - 62;
  const h = Math.min(draw(0, true) + 52, maxBottom - y);
  doc.roundedRect(x, y, w, h, 16).fill(C.white);
  doc.font('body').fontSize(7.5).fillColor(C.teal);
  fixedText(doc, label.toUpperCase(), x + 18, y + 16, { characterSpacing: 1.1 });
  doc.save().rect(x, y, w, h - 12).clip();
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  draw(y + 34, false);
  doc.page.margins.bottom = bottom;
  doc.restore();
  return y + h;
}

function pdfCvBlocks(doc, blocks, f) {
  const x = M, w = A4.w - 2 * M;
  const limit = () => doc.page.maxY();
  const ensure = (needed) => { if (doc.y + needed > limit()) { doc.addPage({ size: 'A4', margins: RESUME_MARGINS }); doc.y = RESUME_MARGINS.top; } };
  if (!blocks.length) {
    doc.font('body').fontSize(10).fillColor(C.slate).text('The CV had no text to format.', x, doc.y, { width: w });
    return;
  }
  blocks.forEach((b, i) => {
    if (b.type === 'heading') {
      ensure(52);
      if (i > 0) doc.y += 12;
      doc.font('headBold').fontSize(12).fillColor(C.ink).text(b.text, x, doc.y, { width: w });
      doc.y += 4;
      doc.moveTo(x, doc.y).lineTo(x + w, doc.y).lineWidth(0.5).strokeColor(C.line).stroke();
      doc.rect(x, doc.y - 1, 36, 2).fill(doc.linearGradient(x, 0, x + 36, 0).stop(0, C.teal).stop(1, C.aqua));
      doc.y += 9;
    } else if (b.type === 'contact') {
      const lines = hasConsultant(f) ? consultantLines(f) : [REDACT_PLACEHOLDER];
      doc.font('body').fontSize(9.5);
      const h = lines.reduce((sum, l) => sum + doc.heightOfString(l, { width: w - 28 }) + 2, 0) + 30;
      ensure(h + 8);
      const top = doc.y;
      doc.roundedRect(x, top, w, h, 12).fill(C.mist);
      doc.font('body').fontSize(7).fillColor(C.slate);
      fixedText(doc, 'CONTACT VIA STOTT AND MAY', x + 14, top + 11, { characterSpacing: 1 });
      let ly = top + 24;
      lines.forEach((l, j) => {
        doc.font(j === 0 && hasConsultant(f) ? 'bodySemi' : 'body').fontSize(9.5).fillColor(C.ink).text(l, x + 14, ly, { width: w - 28 });
        ly = doc.y + 2;
      });
      doc.y = top + h + 10;
    } else if (b.type === 'date') {
      ensure(16);
      doc.font('body').fontSize(8).fillColor(C.slate).text(b.text.toUpperCase(), x, doc.y, { width: w, characterSpacing: 0.6 });
      doc.y += 6;
    } else if (b.type === 'skills') {
      if (b.label) {
        ensure(30);
        doc.font('bodySemi').fontSize(9.5).fillColor(C.ink).text(b.label, x, doc.y, { width: w });
        doc.y += 4;
      }
      doc.font('body').fontSize(8.5);
      ensure(22);
      let cx = x, rowY = doc.y;
      for (const item of b.items) {
        const tw = Math.min(doc.widthOfString(item), w - 24);
        if (cx + tw + 24 > x + w) {
          cx = x; rowY += 23;
          if (rowY + 22 > limit()) { doc.addPage({ size: 'A4', margins: RESUME_MARGINS }); rowY = RESUME_MARGINS.top; }
        }
        // Brand chip: fully rounded with a thin #C3CAD2 outline.
        doc.roundedRect(cx, rowY, tw + 22, 18, 9).lineWidth(0.8).strokeColor(C.line).stroke();
        doc.fillColor(C.ink);
        fixedText(doc, item, cx + 11, rowY + 4.5, { width: tw, ellipsis: true });
        cx += tw + 28;
      }
      doc.y = rowY + 28;
    } else if (b.type === 'bullets') {
      for (const item of b.items) {
        doc.font('body').fontSize(9.5);
        ensure(Math.min(90, doc.heightOfString(item.text, { width: w - 14, lineGap: 2.5 }) + 4));
        const top = doc.y;
        doc.circle(x + 3.5, top + 5.5, 1.8).fill(C.teal);
        doc.fillColor(C.ink).text(item.text, x + 14, top, { width: w - 14, lineGap: 2.5 });
        doc.y += 4;
      }
      doc.y += 6;
    } else if (b.role) {
      ensure(70); // keep a job title with the first lines under it
      if (b.divider) {
        doc.y += 6;
        doc.moveTo(x, doc.y).lineTo(x + w, doc.y).lineWidth(0.5).strokeColor(C.line).stroke();
        doc.y += 10;
      } else if (i > 0 && blocks[i - 1].type !== 'heading') doc.y += 6;
      doc.font('bodySemi').fontSize(10.5).fillColor(C.ink).text(b.text, x, doc.y, { width: w });
      doc.y += 2;
    } else {
      doc.font('body').fontSize(9.5);
      ensure(Math.min(30, doc.heightOfString(b.text, { width: w, lineGap: 2.5 })));
      doc.fillColor(C.ink).text(b.text, x, doc.y, { width: w, lineGap: 2.5 });
      doc.y += 8;
    }
  });
}

function pdfClosing(doc, f) {
  doc.addPage({ size: 'A4', margin: 0 });
  doc.image(IMG.closing, 0, 0, { width: A4.w, height: A4.h });
  const x = 56, w = A4.w - 112;
  // On a gradient, text is near-black or white only.
  doc.font('head').fontSize(34).fillColor(C.ink).text("Let's make great", x, 196, { width: w, lineGap: -4 });
  doc.fillColor(C.white).text('hires today.', x, doc.y, { width: w, lineGap: -4 });
  let y = doc.y + 26;
  if (hasConsultant(f)) {
    doc.font('body').fontSize(8).fillColor(C.ink);
    fixedText(doc, 'YOUR STOTT AND MAY CONSULTANT', x, y, { characterSpacing: 1.2 });
    y += 18;
    consultantLines(f).forEach((l, j) => { doc.font(j === 0 ? 'bodySemi' : 'body').fontSize(12).fillColor(C.ink).text(l, x, y, { width: w }); y = doc.y + 4; });
    y += 10;
  }
  // The brand's call to action, in an outlined pill.
  doc.font('bodySemi').fontSize(10);
  const cta = 'Book a hiring 1-2-1';
  const cw = doc.widthOfString(cta) + 32;
  doc.roundedRect(x, y, cw, 28, 14).lineWidth(1.2).strokeColor(C.ink).stroke();
  doc.fillColor(C.ink);
  fixedText(doc, cta, x + 16, y + 8.5);
  y = Math.max(y + 70, 520);
  doc.font('headBold').fontSize(14).fillColor(C.ink).text('About Stott and May', x, y, { width: w });
  y = doc.y + 8;
  for (const p of BOILERPLATE) { doc.font('body').fontSize(9.5).fillColor(C.ink).text(p, x, y, { width: w, lineGap: 3 }); y = doc.y + 8; }
  doc.font('bodySemi').fontSize(10).text(WEBSITE, x, y + 4, { width: w });
}

// ---------------------------------------------------------------------------
// Word (.docx): the same pages. Backgrounds are the same images, behind the text; the CV pages' light
// page and white card repeat on every page from the header. Tiles and cards are tables (square corners).
// ---------------------------------------------------------------------------
const tw = (pt) => Math.round(pt * 20); // points to twentieths of a point
const pxw = (pt) => pt * 96 / 72; // points to the pixels the docx package measures images in
const emu = (pt) => Math.round(pt * 12700); // points to EMUs, for image positions
const CONTENT_W = tw(A4.w - 2 * M);
const hex = (c) => c.replace('#', '');
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const FONT = { body: 'Inter', semi: 'Inter SemiBold', head: 'Manrope', display: 'Manrope ExtraBold' };

function run(text, o = {}) {
  return new TextRun({
    text, bold: o.bold, size: Math.round((o.pt || 10) * 2), color: hex(o.color || C.ink),
    font: o.font || FONT.body, characterSpacing: o.spacing ? tw(o.spacing) : undefined, border: o.border,
  });
}
function para(children, o = {}) {
  return new Paragraph({
    children: Array.isArray(children) ? children : [children], style: o.style,
    spacing: {
      before: tw(o.before || 0), after: tw(o.after ?? 0),
      ...(o.exact ? { line: tw(o.exact), lineRule: LineRuleType.EXACT } : { line: o.line || 280, lineRule: LineRuleType.AUTO }),
    },
    alignment: o.align, border: o.border, numbering: o.numbering, keepNext: o.keepNext, keepLines: true, tabStops: o.tabStops,
    indent: o.indent,
  });
}
// An image laid behind the text, positioned from the page's top-left corner.
function behind(data, type, x, y, w, h) {
  return new ImageRun({
    type, data, transformation: { width: pxw(w), height: pxw(h) },
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(x) },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(y) },
      behindDocument: true, allowOverlap: true, lockAnchor: true, layoutInCell: false, wrap: { type: TextWrappingType.NONE },
    },
  });
}
const spacer = (heightPt, children = []) => para(children, { exact: heightPt });
function pageProps(m, footerFrom = 0, headerFrom = 0) {
  return { page: {
    size: { width: tw(A4.w), height: tw(A4.h) },
    margin: { top: tw(m.top), right: tw(m.side), bottom: tw(m.bottom), left: tw(m.side), header: tw(headerFrom), footer: tw(footerFrom) },
  } };
}
const emptyHeader = () => new Header({ children: [new Paragraph({})] });
const emptyFooter = () => new Footer({ children: [new Paragraph({})] });

function brandFooter(f, template) {
  const { left, right } = footerText(f, template);
  return new Footer({ children: [new Paragraph({
    style: 'FooterText', tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }],
    border: { top: { style: BorderStyle.SINGLE, size: 4, color: hex(C.line), space: 8 } },
    children: [
      new ImageRun({ type: 'png', data: IMG.stack, transformation: { width: pxw(10), height: pxw(10 * STACK_RATIO) } }),
      new TextRun({ text: '  ' + left }), new TextRun({ children: [new Tab()] }), new TextRun({ text: `${right}  -  ` }),
      new SimpleField('PAGE \\# "00"', '01'),
    ],
  })] });
}

function fixedTable(rows, columnWidths, width = CONTENT_W) {
  return new Table({ rows, columnWidths, width: { size: width, type: WidthType.DXA }, layout: TableLayoutType.FIXED, borders: NO_BORDERS });
}
function cell(children, width, o = {}) {
  return new TableCell({
    children, width: { size: width, type: WidthType.DXA }, borders: NO_BORDERS, verticalAlign: VerticalAlign.TOP,
    shading: o.fill ? { type: ShadingType.CLEAR, fill: hex(o.fill), color: 'auto' } : undefined,
    margins: { top: tw(o.padY ?? 0), bottom: tw(o.padY ?? 0), left: tw(o.padX ?? 0), right: tw(o.padX ?? 0) },
  });
}
function docxPageHead(eyebrow, head, size) {
  const out = [
    para(run(eyebrow.toUpperCase(), { pt: 8, color: C.teal, spacing: 1.2 }), {
      after: 10, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: hex(C.line), space: 5 } },
    }),
    para(run(head.main, { font: FONT.head, bold: true, pt: size }), { line: 240, keepNext: true }),
  ];
  if (head.accent) out.push(para(run(head.accent, { font: FONT.head, bold: true, pt: size, color: C.teal }), { line: 240 }));
  out.push(para([], { exact: 14 }));
  return out;
}
function docxCard(label, paragraphs) {
  return fixedTable([new TableRow({ cantSplit: true, children: [cell([
    para(run(label.toUpperCase(), { pt: 7.5, color: C.teal, spacing: 1.1 }), { after: 8 }), ...paragraphs,
  ], CONTENT_W, { fill: C.white, padX: 18, padY: 16 })] })], [CONTENT_W]);
}

function docxProfile(f) {
  const gap = tw(10), half = Math.round((CONTENT_W - gap) / 2);
  const facts = [
    ['Candidate name', f.name], ['Location', f.location], ['Vacancy job title', f.vacancyTitle],
    ['Availability / notice', f.availability], ['Salary expectations', f.salary], ['Nationality', f.nationality],
  ];
  const tile = ([label, value]) => cell([
    para(run(label.toUpperCase(), { pt: 7, color: C.slate, spacing: 0.9 }), { after: 4 }),
    para(run(value || '-', { font: FONT.semi, pt: 11 })),
  ], half, { fill: C.white, padX: 14, padY: 12 });
  const rows = [];
  for (let i = 0; i < facts.length; i += 2) {
    if (i) rows.push(new TableRow({ height: { value: gap, rule: 'exact' }, children: [cell([new Paragraph({})], half), cell([new Paragraph({})], gap), cell([new Paragraph({})], half)] }));
    rows.push(new TableRow({ cantSplit: true, children: [tile(facts[i]), cell([new Paragraph({})], gap), tile(facts[i + 1])] }));
  }
  const lines = achievementLines(f.keyAchievements);
  return [
    ...docxPageHead('Candidate profile', headline(f), 28),
    fixedTable(rows, [half, gap, half]),
    para([], { exact: 18 }),
    docxCard('Candidate summary', (f.summary || '-').split('\n').filter(Boolean).map((t) => para(run(t), { line: 300, after: 6 }))),
    para([], { exact: 10 }),
    docxCard('Key achievements', lines.length
      ? lines.map((t) => para(run(t), { line: 300, after: 6, numbering: { reference: 'cv-bullets', level: 0 } }))
      : [para(run('-'))]),
  ];
}

function docxCvBody(blocks, f) {
  const out = [];
  if (!blocks.length) return [para(run('The CV had no text to format.', { pt: 9.5, color: C.slate }))];
  blocks.forEach((b, i) => {
    if (b.type === 'heading') {
      out.push(para(run(b.text, { font: FONT.head, bold: true, pt: 12 }), {
        before: i > 0 ? 12 : 0, after: 9, keepNext: true,
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: hex(C.line), space: 4 } },
      }));
    } else if (b.type === 'contact') {
      const lines = hasConsultant(f) ? consultantLines(f) : [REDACT_PLACEHOLDER];
      out.push(fixedTable([new TableRow({ cantSplit: true, children: [cell([
        para(run('CONTACT VIA STOTT AND MAY', { pt: 7, color: C.slate, spacing: 1 }), { after: 4 }),
        ...lines.map((l, j) => para(run(l, { pt: 9.5, font: j === 0 && hasConsultant(f) ? FONT.semi : FONT.body }), { after: 2 })),
      ], CONTENT_W, { fill: C.mist, padX: 14, padY: 10 })] })], [CONTENT_W]), para([], { exact: 10 }));
    } else if (b.type === 'date') {
      out.push(para(run(b.text.toUpperCase(), { pt: 8, color: C.slate, spacing: 0.6 }), { after: 6, keepNext: true }));
    } else if (b.type === 'skills') {
      if (b.label) out.push(para(run(b.label, { font: FONT.semi, pt: 9.5 }), { after: 4, keepNext: true }));
      const chips = [];
      b.items.forEach((item, j) => {
        if (j) chips.push(run('    ', { pt: 8.5 }));
        // Brand chip outline (Word draws it square).
        chips.push(run(` ${item.replace(/ /g, ' ')} `, { pt: 8.5, border: { style: BorderStyle.SINGLE, size: 6, color: hex(C.line), space: 2 } }));
      });
      out.push(para(chips, { line: 420, after: 8 }));
    } else if (b.type === 'bullets') {
      b.items.forEach((item, j) => out.push(para(run(item.text, { pt: 9.5 }), {
        line: 290, after: j === b.items.length - 1 ? 10 : 4, numbering: { reference: 'cv-bullets', level: 0 },
      })));
    } else if (b.role) {
      out.push(para(run(b.text, { font: FONT.semi, pt: 10.5 }), {
        before: b.divider ? 6 : (i > 0 && blocks[i - 1].type !== 'heading' ? 6 : 0), after: 2, keepNext: true,
        border: b.divider ? { top: { style: BorderStyle.SINGLE, size: 4, color: hex(C.line), space: 10 } } : undefined,
      }));
    } else {
      out.push(para(run(b.text, { pt: 9.5 }), { line: 290, after: 8 }));
    }
  });
  return out;
}

export async function buildDocx({ cvText, fields, template }) {
  const f = cleanFields(fields);
  const blocks = parseCvBlocks(redactPersonalDetails(cvText));
  const sections = [];
  const white = (text, o = {}) => run(text, { color: C.white, ...o });
  const ink = (text, o = {}) => run(text, { color: C.ink, ...o });

  if (template === 'long') {
    sections.push({ properties: pageProps({ top: 0, bottom: 0, side: 56 }), headers: { default: emptyHeader() }, footers: { default: emptyFooter() }, children: [
      spacer(300, [behind(IMG.cover, 'jpg', 0, 0, A4.w, A4.h)]),
      para(run('CANDIDATE PROFILE', { pt: 9, color: C.aqua, spacing: 1.4 }), { exact: 20 }),
      para(white(f.name || 'Candidate', { font: FONT.display, pt: 42 }), { exact: 46 }),
      para(run(f.vacancyName || f.vacancyTitle || 'Candidate profile', { font: FONT.display, pt: 42, color: C.aqua }), { exact: 46 }),
      para(white(f.company ? `Prepared for ${f.company} by Stott and May` : 'Prepared by Stott and May', { pt: 12 }), { before: 14, exact: 18 }),
      // The website sits near the bottom of the page, as in the PDF (positioned from the page top).
      new Paragraph({ children: [run(WEBSITE.toUpperCase(), { pt: 8, color: C.slate, spacing: 1.2 })], frame: {
        type: 'absolute', position: { x: tw(56), y: tw(A4.h - 66) }, width: tw(300), height: tw(14),
        anchor: { horizontal: 'page', vertical: 'page' }, alignment: { x: 'left', y: 'top' },
      } }),
    ] });
  }

  const footers = { default: brandFooter(f, template) };
  if (template !== 'basic') {
    sections.push({
      properties: pageProps({ top: 0, bottom: 60, side: M }, 26),
      headers: { default: new Header({ children: [para([behind(Buffer.from(MIST_PIXEL, 'base64'), 'png', 0, 0, A4.w, A4.h)])] }) },
      footers, children: [spacer(48), ...docxProfile(f)],
    });
  }
  sections.push({
    properties: pageProps({ top: RESUME_MARGINS.top, bottom: RESUME_MARGINS.bottom, side: M }, 26),
    // The light page with the white card, repeated on every CV page.
    headers: { default: new Header({ children: [para([behind(IMG.resume, 'jpg', 0, 0, A4.w, A4.h)])] }) },
    footers, children: [...docxPageHead('Candidate resume', headline(f), 22), ...docxCvBody(blocks, f)],
  });

  if (template === 'long') {
    const kids = [
      spacer(196, [behind(IMG.closing, 'jpg', 0, 0, A4.w, A4.h)]),
      para(ink("Let's make great", { font: FONT.display, pt: 34 }), { exact: 38 }),
      para(white('hires today.', { font: FONT.display, pt: 34 }), { exact: 38, after: 26 }),
    ];
    if (hasConsultant(f)) {
      kids.push(para(ink('YOUR STOTT AND MAY CONSULTANT', { pt: 8, spacing: 1.2 }), { after: 6 }));
      consultantLines(f).forEach((l, j) => kids.push(para(ink(l, { pt: 12, font: j === 0 ? FONT.semi : FONT.body }), { after: 4 })));
      kids.push(para([], { exact: 10 }));
    }
    kids.push(
      para(ink('  Book a hiring 1-2-1  ', { font: FONT.semi, pt: 10, border: { style: BorderStyle.SINGLE, size: 8, color: hex(C.ink), space: 4 } }), { after: 40 }),
      para(ink('About Stott and May', { font: FONT.head, bold: true, pt: 14 }), { after: 8 }),
      ...BOILERPLATE.map((t) => para(ink(t, { pt: 9.5 }), { line: 300, after: 8 })),
      para(ink(WEBSITE, { font: FONT.semi, pt: 10 }), { before: 4 }),
    );
    sections.push({ properties: pageProps({ top: 0, bottom: 0, side: 56 }), headers: { default: emptyHeader() }, footers: { default: emptyFooter() }, children: kids });
  }

  const doc = new Document({
    creator: 'Stott and May', title: fileBaseName(f, template), description: 'Formatted by CV Intelligence',
    styles: {
      default: { document: { run: { font: FONT.body, size: 20, color: hex(C.ink) }, paragraph: { spacing: { before: 0, after: 0 } } } },
      paragraphStyles: [{ id: 'FooterText', name: 'Footer Text', run: { font: FONT.body, size: 13, color: hex(C.slate), characterSpacing: 18 } }],
    },
    numbering: { config: [{ reference: 'cv-bullets', levels: [{
      level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: tw(14), hanging: tw(10) } }, run: { color: hex(C.teal), font: FONT.body } },
    }] }] },
    // The brand fonts travel inside the file, so the document looks the same on computers without them.
    fonts: [
      { name: FONT.body, data: fs.readFileSync(FONTS.body), bold: fs.readFileSync(FONTS.bodyBold), characterSet: '00' },
      { name: FONT.semi, data: fs.readFileSync(FONTS.bodySemi), characterSet: '00' },
      { name: FONT.head, data: fs.readFileSync(FONTS.headBold), bold: fs.readFileSync(FONTS.headBold), characterSet: '00' },
      { name: FONT.display, data: fs.readFileSync(FONTS.head), characterSet: '00' },
    ],
    sections,
  });
  return Packer.toBuffer(doc);
}

// A single #ECEEF3 pixel, stretched behind the profile page in Word.
const MIST_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN48+4zAAWXAs7rocS6AAAAAElFTkSuQmCC';
