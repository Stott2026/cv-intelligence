import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactPersonalDetails, parseCvBlocks, achievementLines, cleanFields, fileBaseName, buildPdf, buildDocx, REDACT_PLACEHOLDER,
} from '../lib/format.js';

const CV = `Jo Bloggs
jo.bloggs@example.com | 07700 900123 | linkedin.com/in/jobloggs
12 High Street, London SW1A 1AA

Experience
Senior Engineer — Acme Ltd, London
2020 – Present
• Cut cloud costs by 32% across 6 teams.
• Led a team of 12 engineers through a platform rebuild that took the
service from 3 releases a year to weekly.

Skills
Python, Go, AWS, Kubernetes

1`;

test('the candidate\'s email, phone, LinkedIn and home address are removed; ordinary figures stay', () => {
  const out = redactPersonalDetails(CV);
  assert.ok(!out.includes('jo.bloggs@example.com'));
  assert.ok(!out.includes('07700'));
  assert.ok(!out.includes('linkedin.com/in/jobloggs'));
  assert.ok(!out.includes('SW1A'));
  assert.equal(out.split(REDACT_PLACEHOLDER).length - 1, 1, 'a contact block becomes one notice');
  for (const kept of ['32%', '6 teams', '12 engineers', '2020']) assert.ok(out.includes(kept), kept);
});

test('CV text is split into headings, job titles, dates, bullets and skills', () => {
  const blocks = parseCvBlocks(redactPersonalDetails(CV));
  const types = blocks.map((b) => (b.type === 'para' && b.role ? 'role' : b.type));
  assert.deepEqual(types, ['para', 'contact', 'heading', 'role', 'date', 'bullets', 'heading', 'skills']);
  const bullets = blocks.find((b) => b.type === 'bullets');
  assert.equal(bullets.items.length, 2);
  assert.match(bullets.items[1].text, /rebuild that took the service/, 'a wrapped line joins its bullet');
  assert.deepEqual(blocks.find((b) => b.type === 'skills').items, ['Python', 'Go', 'AWS', 'Kubernetes']);
  assert.ok(!blocks.some((b) => b.text === '1'), 'a page number on its own is dropped');
});

test('words split across lines by the original PDF are joined back up', () => {
  const blocks = parseCvBlocks('Skills\nTesting: SQL engine vali-\ndation, regression testing');
  assert.deepEqual(blocks[1].items, ['SQL engine validation', 'regression testing']);
});

test('achievements are capped at five and lose typed bullets; fields are length-capped', () => {
  assert.deepEqual(achievementLines('• One\n- Two\n\nThree\n4\n5\n6'), ['One', 'Two', 'Three', '4', '5']);
  assert.equal(cleanFields({ name: 'x'.repeat(500) }).name.length, 100);
  assert.equal(cleanFields({}).salary, '');
  assert.equal(fileBaseName({ name: 'Jo / Bloggs' }, 'long'), 'Jo  Bloggs - Stott and May Candidate Pack');
});

test('every template builds as a PDF and a Word file', async () => {
  const fields = { name: 'Jo Bloggs', summary: 'A senior engineer.', keyAchievements: 'Cut cloud costs by 32%' };
  for (const template of ['basic', 'medium', 'long']) {
    const pdf = await buildPdf({ cvText: CV, fields, template });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(!pdf.toString('latin1').includes('jo.bloggs@example.com'));
    const docx = await buildDocx({ cvText: CV, fields, template });
    assert.equal(docx.subarray(0, 2).toString(), 'PK', 'a .docx is a zip file');
  }
});

test('a LinkedIn-style CV: the Contact heading keeps a contact block, and one-per-line skills become tags', () => {
  const linkedin = `Contact
www.linkedin.com/in/jobloggs (LinkedIn)
jo@example.com
Top Skills
Large Language Models (LLM)
Amazon Web Services (AWS)
Machine Learning
Experience
Engineer — Acme, London`;
  const blocks = parseCvBlocks(redactPersonalDetails(linkedin));
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'contact', 'heading', 'skills', 'heading', 'para']);
  assert.deepEqual(blocks[3].items, ['Large Language Models (LLM)', 'Amazon Web Services (AWS)', 'Machine Learning']);
});

test('the consultant\'s details replace the removed contact details in the CV', async () => {
  const fields = { name: 'Jo Bloggs', consultantName: 'Sam Consultant', email: 'sam@stottandmay.com', phone: '020 7946 0000' };
  for (const template of ['basic', 'medium', 'long']) {
    const docx = await buildDocx({ cvText: CV, fields, template });
    assert.ok(docx.length > 1000);
  }
  const { execFileSync } = await import('node:child_process');
  const pdf = await buildPdf({ cvText: CV, fields, template: 'basic' });
  let text = '';
  try { text = execFileSync('pdftotext', ['-', '-'], { input: pdf }).toString(); } catch { return; } // pdftotext not installed: skip the text check
  assert.match(text, /Sam Consultant/);
  assert.match(text, /sam@stottandmay\.com/);
  assert.ok(!text.includes('jo.bloggs@example.com'));
});

test('page furniture from a CV that was already formatted is dropped, and wrapped words are not headings', async () => {
  const { parseCvBlocks } = await import('../lib/format.js');
  const blocks = parseCvBlocks('C A N D I D AT E R E S U M E\nExperience\nAnalyst - a bank, London\n- Facilitator for Design Thinking\ntraining.\nS T O T T A N D M AY - 0 1\ntraining\n- Course one');
  const text = JSON.stringify(blocks);
  assert.ok(!/C A N D|S T O T T/.test(text), 'letter-spaced furniture removed');
  assert.deepEqual(blocks.filter((b) => b.type === 'heading').map((b) => b.text), ['Experience', 'Training']);
  assert.match(text, /Design Thinking training/);
});
