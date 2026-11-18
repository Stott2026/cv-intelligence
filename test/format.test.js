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
  assert.deepEqual(types, ['para', 'para', 'heading', 'role', 'date', 'bullets', 'heading', 'skills']);
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
