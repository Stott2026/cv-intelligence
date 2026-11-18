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
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType,
  BorderStyle, ShadingType, AlignmentType, VerticalAlign, Footer, HeightRule, LevelFormat, PageBreak,
} from 'docx';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(here, 'fonts');
const LOGO_WHITE = fs.readFileSync(path.join(here, '..', 'public', 'logo-dark-bg.png')); // for teal backgrounds
const LOGO_DARK = fs.readFileSync(path.join(here, '..', 'public', 'logo-light-bg.png')); // for white backgrounds
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

const C = {
  teal: '#00C8C8', aqua: '#73F7BB', ink: '#14171A', muted: '#5B6266', line: '#DFE2E7',
  paperMuted: '#ECEEF3', keyBg: '#F6F7F9', chipBg: '#E3FBF6', chipInk: '#0F6B63', black: '#000000', white: '#FFFFFF',
};

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
]);
const SKILLS_HEADINGS = new Set(['skills', 'key skills', 'core skills', 'technical skills', 'competencies', 'core competencies']);
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
    if (line === REDACT_PLACEHOLDER) { // the contact-details notice always stands on its own line
      blocks.push({ type: 'para', text: line, role: false }); openBullets = null; last = null;
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
// PDF
// ---------------------------------------------------------------------------
const A4 = { w: 595.28, h: 841.89 };
const M = 48; // page margin

export function buildPdf({ cvText, fields, template }) {
  const f = cleanFields(fields);
  const blocks = parseCvBlocks(redactPersonalDetails(cvText));
  const footerKind = template === 'basic' ? 'black' : 'light';
  const footerSpace = footerKind === 'black' ? 64 : 56;
  // Pages pdfkit adds by itself (when the CV text runs over) use these settings, so they must match.
  const doc = new PDFDocument({
    size: 'A4', margins: { top: M, bottom: footerSpace, left: M, right: M }, bufferPages: true, autoFirstPage: false,
    info: { Title: fileBaseName(f, template), Author: 'Stott and May', Creator: 'CV Intelligence' },
  });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const resumePages = [];

  if (template === 'long') pdfCover(doc, f);
  if (template !== 'basic') pdfProfile(doc, f);

  // The CV itself, flowing over as many pages as it needs.
  const firstResume = doc.bufferedPageRange().count;
  doc.addPage({ size: 'A4', margins: { top: M, bottom: footerSpace, left: M, right: M } });
  pdfBar(doc, 'Candidate Resume');
  doc.y = 104;
  pdfCvBlocks(doc, blocks, footerSpace);
  const range = doc.bufferedPageRange();
  for (let i = firstResume; i < range.start + range.count; i++) resumePages.push(i);

  if (template === 'long') pdfClosing(doc, f);

  // Footers and page numbers on the CV pages, drawn once the CV has flowed.
  resumePages.forEach((p, idx) => {
    doc.switchToPage(p);
    pdfFooter(doc, footerKind, resumePages.length > 1 ? `Page ${idx + 1} of ${resumePages.length}` : '');
  });
  doc.end();
  return done;
}

function gradient(doc, x1, y1, x2, y2) {
  return doc.linearGradient(x1, y1, x2, y2).stop(0, C.teal).stop(1, C.aqua);
}

// Writes text without letting pdfkit start a new page (for footers and fixed pages).
function fixedText(doc, text, x, y, opts) {
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.text(text, x, y, { lineBreak: false, ...opts });
  doc.page.margins.bottom = bottom;
}

function pdfBar(doc, label) {
  const h = 70, r = 18, W = A4.w;
  doc.save();
  doc.moveTo(0, 0).lineTo(W, 0).lineTo(W, h - r).quadraticCurveTo(W, h, W - r, h).lineTo(r, h).quadraticCurveTo(0, h, 0, h - r).closePath()
    .fill(gradient(doc, 0, 0, W, h));
  doc.font('head').fontSize(10);
  const text = label.toUpperCase();
  const tw = doc.widthOfString(text, { characterSpacing: 1 });
  doc.roundedRect(M - 6, 21, tw + 32, 28, 14).lineWidth(1.3).strokeColor(C.white).stroke();
  doc.fillColor(C.white);
  fixedText(doc, text, M + 10, 30.5, { characterSpacing: 1 });
  doc.image(LOGO_WHITE, W - M - 42, 14, { width: 42 });
  doc.restore();
}

function pdfFooter(doc, kind, pageLabel) {
  doc.save();
  if (kind === 'black') {
    const h = 36, y = A4.h - h, r = 16, W = A4.w;
    doc.moveTo(0, A4.h).lineTo(0, y + r).quadraticCurveTo(0, y, r, y).lineTo(W - r, y).quadraticCurveTo(W, y, W, y + r).lineTo(W, A4.h).closePath().fill(C.black);
    doc.font('body').fontSize(8).fillColor(C.white);
    fixedText(doc, ADDRESS, M, y + 14);
    const right = pageLabel ? `${WEBSITE}   ·   ${pageLabel}` : WEBSITE;
    fixedText(doc, right, A4.w - M - doc.widthOfString(right), y + 14);
  } else {
    const y = A4.h - 34;
    doc.moveTo(M, y - 10).lineTo(A4.w - M, y - 10).lineWidth(0.6).strokeColor(C.line).stroke();
    doc.image(LOGO_DARK, M, y - 4, { height: 14 });
    doc.font('bodySemi').fontSize(8).fillColor(C.ink);
    fixedText(doc, WEBSITE, M + 20, y);
    doc.font('body').fillColor(C.muted);
    const right = pageLabel ? `Prepared by Stott and May   ·   ${pageLabel}` : 'Prepared by Stott and May';
    fixedText(doc, right, A4.w - M - doc.widthOfString(right), y);
  }
  doc.restore();
}

function pdfCover(doc, f) {
  doc.addPage({ size: 'A4', margin: 0 });
  doc.rect(0, 0, A4.w, A4.h).fill(gradient(doc, 0, 0, A4.w, A4.h));
  doc.image(LOGO_WHITE, 56, 56, { width: 64 });
  doc.fillColor(C.white);
  doc.font('body').fontSize(13);
  fixedText(doc, `[${f.company || 'Company name'}]`, 56, 300);
  doc.font('head').fontSize(54);
  doc.text('Candidate\nProfile', 56, 326, { width: A4.w - 112, lineGap: -6 });
  doc.font('body').fontSize(15);
  doc.text(`[${f.vacancyName || f.vacancyTitle || 'Vacancy name'}]`, 56, doc.y + 12, { width: A4.w - 112 });
  doc.font('headBold').fontSize(18);
  fixedText(doc, f.name || 'Candidate name', 56, A4.h - 110);
}

function pdfProfile(doc, f) {
  doc.addPage({ size: 'A4', margin: 0 });
  doc.rect(0, 0, A4.w, A4.h).fill(C.paperMuted);
  pdfBar(doc, 'Candidate Profile');
  const x = M, w = A4.w - 2 * M;
  let y = 100;

  // The details table
  const rows = [
    ['Candidate Name', f.name], ['Candidate Location', f.location], ['Vacancy Job Title', f.vacancyTitle],
    ['Availability / Notice', f.availability], ['Salary Expectations', f.salary], ['Nationality', f.nationality],
  ];
  const kw = Math.round(w * 0.38), pad = 11;
  doc.fontSize(10);
  const heights = rows.map(([, v]) => Math.max(16, doc.font('body').heightOfString(v || '-', { width: w - kw - 2 * pad })) + 2 * pad);
  const tableH = heights.reduce((a, b) => a + b, 0);
  doc.save().roundedRect(x, y, w, tableH, 10).clip();
  doc.rect(x, y, w, tableH).fill(C.white);
  let ry = y;
  rows.forEach(([k, v], i) => {
    doc.rect(x, ry, kw, heights[i]).fill(C.keyBg);
    doc.fillColor(C.ink).font('bodyBold').fontSize(10).text(k, x + pad, ry + pad, { width: kw - 2 * pad });
    doc.font('body').text(v || '-', x + kw + pad, ry + pad, { width: w - kw - 2 * pad });
    ry += heights[i];
    if (i < rows.length - 1) doc.moveTo(x, ry).lineTo(x + w, ry).lineWidth(0.6).strokeColor(C.line).stroke();
  });
  doc.restore();
  y += tableH + 22;

  // Summary
  y = pdfProfileCard(doc, 'Candidate Summary', y, (cy, cw) => {
    doc.font('body').fontSize(10).fillColor(C.ink).text(f.summary || '-', x + 14, cy, { width: cw, lineGap: 2.5 });
    return doc.y;
  }, () => doc.font('body').fontSize(10).heightOfString(f.summary || '-', { width: w - 28, lineGap: 2.5 }));

  // Key achievements
  const lines = achievementLines(f.keyAchievements);
  const items = lines.length ? lines : ['-'];
  pdfProfileCard(doc, 'Key Achievements', y, (cy, cw) => {
    let iy = cy;
    for (const item of items) {
      if (lines.length) doc.circle(x + 18, iy + 6, 2).fill(C.teal);
      doc.font('body').fontSize(10).fillColor(C.ink).text(item, x + 28, iy, { width: cw - 14, lineGap: 2.5 });
      iy = doc.y + 5;
    }
    return iy;
  }, () => items.reduce((sum, item) => sum + doc.font('body').fontSize(10).heightOfString(item, { width: w - 42, lineGap: 2.5 }) + 5, -5));

  pdfFooter(doc, 'light', '');
}

function pdfProfileCard(doc, title, y, draw, measure) {
  const x = M, w = A4.w - 2 * M;
  // Keep the profile on one page: shrink a card that would run into the footer.
  doc.font('bodyBold').fontSize(10.5).fillColor(C.ink);
  fixedText(doc, title, x, y);
  y += 20;
  const maxH = A4.h - 70 - y;
  const h = Math.min(measure() + 28, maxH);
  doc.save().roundedRect(x, y, w, h, 10).fill(C.white).restore();
  doc.save().rect(x, y, w, h).clip();
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  draw(y + 14, w - 28);
  doc.page.margins.bottom = bottom;
  doc.restore();
  return y + h + 22;
}

function pdfCvBlocks(doc, blocks, footerSpace) {
  const x = M, w = A4.w - 2 * M;
  const limit = () => doc.page.maxY();
  const ensure = (needed) => { if (doc.y + needed > limit()) { doc.addPage({ size: 'A4', margins: { top: M, bottom: footerSpace, left: M, right: M } }); doc.y = M; } };
  if (!blocks.length) {
    doc.font('body').fontSize(10).fillColor(C.muted).text('The CV had no text to format.', x, doc.y, { width: w });
    return;
  }
  blocks.forEach((b, i) => {
    if (b.type === 'heading') {
      ensure(48);
      if (i > 0) doc.y += 14;
      doc.font('head').fontSize(10.5).fillColor(C.ink).text(b.text.toUpperCase(), x, doc.y, { width: w, characterSpacing: 0.8 });
      doc.y += 3;
      doc.moveTo(x, doc.y).lineTo(x + w, doc.y).lineWidth(2).strokeColor(C.teal).stroke();
      doc.y += 9;
    } else if (b.type === 'date') {
      ensure(16);
      doc.font('bodySemi').fontSize(8.5).fillColor(C.muted).text(b.text.toUpperCase(), x, doc.y, { width: w, characterSpacing: 0.4 });
      doc.y += 6;
    } else if (b.type === 'skills') {
      if (b.label) {
        ensure(30);
        doc.font('bodyBold').fontSize(9.5).fillColor(C.ink).text(b.label, x, doc.y, { width: w });
        doc.y += 3;
      }
      doc.font('bodySemi').fontSize(8.5);
      ensure(22);
      let cx = x, rowY = doc.y;
      for (const item of b.items) {
        const tw = Math.min(doc.widthOfString(item), w - 24);
        if (cx + tw + 24 > x + w) {
          cx = x; rowY += 22;
          if (rowY + 22 > limit()) { doc.addPage({ size: 'A4', margins: { top: M, bottom: footerSpace, left: M, right: M } }); rowY = M; }
        }
        doc.roundedRect(cx, rowY, tw + 22, 18, 9).fill(C.chipBg);
        doc.fillColor(C.chipInk);
        fixedText(doc, item, cx + 11, rowY + 4.5, { width: tw, ellipsis: true });
        cx += tw + 28;
      }
      doc.y = rowY + 28;
    } else if (b.type === 'bullets') {
      for (const item of b.items) {
        doc.font('body').fontSize(9.5);
        ensure(Math.min(90, doc.heightOfString(item.text, { width: w - 14, lineGap: 2 }) + 4));
        const top = doc.y;
        doc.circle(x + 3.5, top + 5.5, 1.8).fill(C.teal);
        doc.fillColor(C.ink).text(item.text, x + 14, top, { width: w - 14, lineGap: 2 });
        doc.y += 4;
      }
      doc.y += 6;
    } else if (b.role) {
      ensure(70); // keep a job title with the first lines under it
      if (b.divider) {
        doc.y += 6;
        doc.moveTo(x, doc.y).lineTo(x + w, doc.y).lineWidth(0.6).strokeColor(C.line).stroke();
        doc.y += 10;
      } else if (i > 0 && blocks[i - 1].type !== 'heading') doc.y += 6;
      doc.font('bodyBold').fontSize(10).fillColor(C.ink).text(b.text, x, doc.y, { width: w });
      doc.y += 2;
    } else {
      doc.font('body').fontSize(9.5);
      ensure(Math.min(30, doc.heightOfString(b.text, { width: w, lineGap: 2 })));
      doc.fillColor(C.ink).text(b.text, x, doc.y, { width: w, lineGap: 2 });
      doc.y += 8;
    }
  });
}

function pdfClosing(doc, f) {
  doc.addPage({ size: 'A4', margin: 0 });
  doc.rect(0, 0, A4.w, A4.h).fill(gradient(doc, 0, 0, A4.w, A4.h));
  doc.fillColor(C.white).font('head').fontSize(30);
  fixedText(doc, 'Get in touch:', 56, 96);
  let y = 152;
  const row = (font, text) => { doc.font(font).fontSize(14); doc.text(text, 56, y, { width: A4.w - 112 }); y = doc.y + 10; };
  const contact = contactRows(f);
  contact.forEach(([font, text]) => row(font === 'bold' ? 'bodyBold' : 'body', text));
  doc.image(LOGO_WHITE, A4.w - 56 - 72, A4.h - 56 - 72, { width: 72 });
}

// The consultant's contact details for the closing page (blank lines left out).
function contactRows(f) {
  const rows = [];
  rows.push(['bold', f.consultantName || 'Stott and May']);
  if (f.consultantTitle) rows.push(['', f.consultantTitle]);
  if (f.email) rows.push(['', `Email: ${f.email}`]);
  if (f.phone) rows.push(['', `Phone: ${f.phone}`]);
  if (f.linkedin) rows.push(['', `LinkedIn: ${f.linkedin}`]);
  rows.push(['', WEBSITE]);
  return rows;
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------
const W = { pageW: 11906, pageH: 16838, margin: 1134 }; // A4 in twentieths of a point, 2 cm margins
const CONTENT_W = W.pageW - 2 * W.margin;
const hex = (c) => c.replace('#', '');
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };

function run(text, o = {}) {
  return new TextRun({
    text, bold: o.bold, italics: o.italics, size: o.size || 20, color: hex(o.color || C.ink),
    font: o.head ? 'Manrope' : 'Inter', characterSpacing: o.spacing, allCaps: o.caps, break: o.break,
  });
}
function para(children, o = {}) {
  return new Paragraph({
    children: Array.isArray(children) ? children : [children],
    spacing: { before: o.before || 0, after: o.after ?? 100, line: o.line },
    alignment: o.align, border: o.border, numbering: o.numbering, indent: o.indent, keepNext: o.keepNext,
  });
}
function logoRun(data, size) {
  return new ImageRun({ type: 'png', data, transformation: { width: size, height: size } });
}

// A full-width teal bar with a label on the left and the logo on the right.
function docxBar(label) {
  const cell = (children, align, width) => new TableCell({
    children: [new Paragraph({ children, alignment: align })], width: { size: width, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: hex(C.teal), color: 'auto' }, verticalAlign: VerticalAlign.CENTER,
    margins: { top: 140, bottom: 140, left: 240, right: 240 }, borders: NO_BORDERS,
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W - 2000, 2000], borders: NO_BORDERS,
    rows: [new TableRow({ children: [
      cell([run(label.toUpperCase(), { head: true, bold: true, color: C.white, size: 22, spacing: 30 })], AlignmentType.LEFT, CONTENT_W - 2000),
      cell([logoRun(LOGO_WHITE, 40)], AlignmentType.RIGHT, 2000),
    ] })],
  });
}

// A tall teal block for the cover and closing pages.
function docxTealPage(paragraphs) {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W], borders: NO_BORDERS,
    rows: [new TableRow({
      height: { value: W.pageH - 2 * W.margin - 400, rule: HeightRule.ATLEAST },
      children: [new TableCell({
        children: paragraphs, width: { size: CONTENT_W, type: WidthType.DXA }, borders: NO_BORDERS,
        shading: { type: ShadingType.CLEAR, fill: hex(C.teal), color: 'auto' },
        margins: { top: 600, bottom: 600, left: 600, right: 600 },
      })],
    })],
  });
}

function docxFieldsTable(rows) {
  const kw = Math.round(CONTENT_W * 0.38);
  const line = { style: BorderStyle.SINGLE, size: 4, color: hex(C.line) };
  const cell = (text, isKey, width) => new TableCell({
    children: [para(run(text || '-', { bold: isKey }), { after: 0 })], width: { size: width, type: WidthType.DXA },
    shading: isKey ? { type: ShadingType.CLEAR, fill: hex(C.keyBg), color: 'auto' } : undefined,
    margins: { top: 120, bottom: 120, left: 160, right: 160 },
  });
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [kw, CONTENT_W - kw],
    borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
    rows: rows.map(([k, v]) => new TableRow({ children: [cell(k, true, kw), cell(v, false, CONTENT_W - kw)] })),
  });
}

function docxCvBody(blocks) {
  const out = [];
  if (!blocks.length) return [para(run('The CV had no text to format.', { color: C.muted }))];
  blocks.forEach((b, i) => {
    if (b.type === 'heading') {
      out.push(para(run(b.text.toUpperCase(), { head: true, bold: true, size: 21, spacing: 16 }), {
        before: i > 0 ? 280 : 0, after: 140, keepNext: true,
        border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: hex(C.teal), space: 4 } },
      }));
    } else if (b.type === 'date') {
      out.push(para(run(b.text.toUpperCase(), { size: 17, color: C.muted, bold: true, spacing: 8 }), { after: 100, keepNext: true }));
    } else if (b.type === 'skills') {
      if (b.label) out.push(para(run(b.label, { bold: true, size: 19 }), { after: 40, keepNext: true }));
      out.push(para(run(b.items.join('   ·   '), { size: 18, color: C.chipInk, bold: true }), { after: 160 }));
    } else if (b.type === 'bullets') {
      b.items.forEach((item, j) => out.push(para(run(item.text, { size: 19 }), {
        after: j === b.items.length - 1 ? 160 : 60, numbering: { reference: 'cv-bullets', level: 0 },
      })));
    } else if (b.role) {
      out.push(para(run(b.text, { bold: true, size: 20 }), {
        before: b.divider ? 200 : (i > 0 && blocks[i - 1].type !== 'heading' ? 120 : 0), after: 40, keepNext: true,
        border: b.divider ? { top: { style: BorderStyle.SINGLE, size: 4, color: hex(C.line), space: 8 } } : undefined,
      }));
    } else {
      out.push(para(run(b.text, { size: 19 }), { after: 140 }));
    }
  });
  return out;
}

function docxFooter(kind) {
  if (kind === 'black') {
    const cell = (text, align, width) => new TableCell({
      children: [new Paragraph({ children: [run(text, { size: 16, color: C.white })], alignment: align })],
      width: { size: width, type: WidthType.DXA }, borders: NO_BORDERS,
      shading: { type: ShadingType.CLEAR, fill: '000000', color: 'auto' }, margins: { top: 100, bottom: 100, left: 200, right: 200 },
    });
    const half = Math.round(CONTENT_W / 2);
    return new Footer({ children: [new Table({
      width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [half + 1000, CONTENT_W - half - 1000], borders: NO_BORDERS,
      rows: [new TableRow({ children: [cell(ADDRESS, AlignmentType.LEFT, half + 1000), cell(WEBSITE, AlignmentType.RIGHT, CONTENT_W - half - 1000)] })],
    })] });
  }
  return new Footer({ children: [para([
    run(WEBSITE, { size: 16, bold: true }), run('   ·   Prepared by Stott and May', { size: 16, color: C.muted }),
  ], { after: 0 })] });
}

export async function buildDocx({ cvText, fields, template }) {
  const f = cleanFields(fields);
  const blocks = parseCvBlocks(redactPersonalDetails(cvText));
  const page = { size: { width: W.pageW, height: W.pageH }, margin: { top: W.margin, right: W.margin, bottom: W.margin, left: W.margin } };
  const sections = [];
  const white = (text, o = {}) => run(text, { color: C.white, ...o });

  if (template === 'long') {
    sections.push({ properties: { page }, children: [docxTealPage([
      para(logoRun(LOGO_WHITE, 64), { after: 2400 }),
      para(white(`[${f.company || 'Company name'}]`, { size: 26 }), { after: 120 }),
      para(white('Candidate', { head: true, bold: true, size: 96 }), { after: 0 }),
      para(white('Profile', { head: true, bold: true, size: 96 }), { after: 240 }),
      para(white(`[${f.vacancyName || f.vacancyTitle || 'Vacancy name'}]`, { size: 30 }), { after: 3000 }),
      para(white(f.name || 'Candidate name', { head: true, bold: true, size: 36 }), { after: 0 }),
    ])] });
  }

  const cv = [];
  if (template !== 'basic') {
    const lines = achievementLines(f.keyAchievements);
    cv.push(
      docxBar('Candidate Profile'), para('', { after: 200 }),
      docxFieldsTable([
        ['Candidate Name', f.name], ['Candidate Location', f.location], ['Vacancy Job Title', f.vacancyTitle],
        ['Availability / Notice', f.availability], ['Salary Expectations', f.salary], ['Nationality', f.nationality],
      ]),
      para(run('Candidate Summary', { bold: true, size: 21 }), { before: 320, after: 100 }),
      ...(f.summary || '-').split('\n').filter(Boolean).map((t) => para(run(t, { size: 20 }), { after: 120 })),
      para(run('Key Achievements', { bold: true, size: 21 }), { before: 240, after: 100 }),
      ...(lines.length ? lines.map((t) => para(run(t, { size: 20 }), { after: 80, numbering: { reference: 'cv-bullets', level: 0 } })) : [para(run('-', { size: 20 }))]),
      new Paragraph({ children: [new PageBreak()] }),
    );
  }
  cv.push(docxBar('Candidate Resume'), para('', { after: 200 }), ...docxCvBody(blocks));
  sections.push({ properties: { page }, footers: { default: docxFooter(template === 'basic' ? 'black' : 'light') }, children: cv });

  if (template === 'long') {
    const rows = contactRows(f).map(([font, text]) => para(white(text, { size: 28, bold: font === 'bold' }), { after: 160 }));
    // An explicit empty footer, or Word carries the CV's footer onto this page.
    sections.push({ properties: { page }, footers: { default: new Footer({ children: [new Paragraph({})] }) }, children: [docxTealPage([
      para(white('Get in touch:', { head: true, bold: true, size: 56 }), { after: 400 }),
      ...rows,
      para(logoRun(LOGO_WHITE, 72), { before: 3000, align: AlignmentType.RIGHT }),
    ])] });
  }

  const doc = new Document({
    creator: 'Stott and May', title: fileBaseName(f, template), description: 'Formatted by CV Intelligence',
    styles: { default: { document: { run: { font: 'Inter', size: 20, color: hex(C.ink) } } } },
    numbering: { config: [{ reference: 'cv-bullets', levels: [{
      level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360, hanging: 240 } }, run: { color: hex(C.teal) } },
    }] }] },
    fonts: [
      { name: 'Inter', data: fs.readFileSync(FONTS.body), characterSet: '00' },
      { name: 'Manrope', data: fs.readFileSync(FONTS.head), characterSet: '00' },
    ],
    sections,
  });
  return Packer.toBuffer(doc);
}
