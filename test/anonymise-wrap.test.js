import { test } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { PDFDocument as LibDoc } from 'pdf-lib';
import { leftovers, checkAnonymised, scrubLeftovers } from '../lib/anonymise.js';
import { wrapOwnCv } from '../lib/wrap.js';
import { cleanFields, fileBaseName, ANONYMOUS_NAME } from '../lib/format.js';

const original = {
  cvText: 'Jo Bloggs\nEngineer - Acme Ltd, 2020 - Present\nCut costs by 32% at Acme.\nBSc, University of Leeds',
  summary: 'Jo Bloggs is an engineer at Acme Ltd.',
  achievements: ['Cut costs by 32%'],
};

test('leftovers finds names as whole words only, ignoring case', () => {
  assert.deepEqual(leftovers('Worked at ACME for years', ['Acme']), ['Acme']);
  assert.deepEqual(leftovers('Worked at Acmetric', ['Acme']), [], 'part of another word is not a leftover');
  assert.deepEqual(leftovers('anything', ['Jo']), [], 'names under 3 letters are not checked');
});

test('an anonymised version passes only with no names left and no new numbers', () => {
  const good = {
    cvText: 'Engineer - a UK manufacturing firm, 2020 - Present\nCut costs by 32% at the firm.\nBSc, a Russell Group university',
    summary: 'The candidate is an engineer at a UK manufacturing firm.', achievements: ['Cut costs by 32%'],
    removed: { names: ['Jo Bloggs'], organisations: ['Acme Ltd', 'University of Leeds'] },
  };
  assert.equal(checkAnonymised(original, good, 'Jo Bloggs').ok, true);

  const nameLeft = { ...good, summary: 'Bloggs is an engineer.' };
  assert.deepEqual(checkAnonymised(original, nameLeft, 'Jo Bloggs').left, ['Bloggs']);

  const orgLeft = { ...good, cvText: good.cvText + '\nStill at Acme Ltd.' };
  assert.equal(checkAnonymised(original, orgLeft, 'Jo Bloggs').ok, false);

  const newFigure = { ...good, achievements: ['Cut costs by 35%'] };
  assert.deepEqual(checkAnonymised(original, newFigure, 'Jo Bloggs').newNumbers, ['35']);
});

test('names Claude left in (an employer that is also a skill) are swapped for its own descriptions, then re-checked', () => {
  const almost = {
    cvText: 'Engineer - a UK manufacturing firm, 2020 - Present\nSkills: Acme Ltd tooling, Python\nJo Bloggs led the team.',
    summary: 'The candidate is an engineer.', achievements: ['Cut costs by 32%'],
    removed: { names: ['Jo Bloggs'], organisations: [{ original: 'Acme Ltd', replacement: 'a UK manufacturing firm' }, { original: 'Acme', replacement: 'the firm' }] },
  };
  assert.equal(checkAnonymised(original, almost, 'Jo Bloggs').ok, false);
  const fixed = scrubLeftovers(almost, 'Jo Bloggs');
  assert.match(fixed.cvText, /Skills: a UK manufacturing firm tooling, Python/);
  assert.match(fixed.cvText, /the candidate led the team/);
  assert.equal(checkAnonymised(original, fixed, 'Jo Bloggs').ok, true);
});

test('anonymous fields never carry the candidate\'s name, including the file name', () => {
  const f = cleanFields({ name: 'Jo Bloggs' }, { anonymous: true });
  assert.equal(f.name, ANONYMOUS_NAME);
  assert.equal(fileBaseName(f, 'medium'), 'Anonymous candidate - Stott and May Profile and CV');
});

function samplePdf(pages) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (let i = 0; i < pages; i++) { if (i) doc.addPage(); doc.text(`Original page ${i + 1}`); }
    doc.end();
  });
}

test('the candidate\'s own CV: a cover sheet, then each original page framed', async () => {
  const out = await wrapOwnCv({ pdf: await samplePdf(2), fields: { name: 'Jo Bloggs', vacancyTitle: 'Engineer' } });
  const doc = await LibDoc.load(out);
  assert.equal(doc.getPageCount(), 3, 'cover + 2 framed pages');
  assert.equal(fileBaseName(cleanFields({ name: 'Jo Bloggs' }), 'own'), 'Jo Bloggs - Stott and May Presented CV');
});

test('a file that is not a readable PDF gets a clear message', async () => {
  await assert.rejects(wrapOwnCv({ pdf: Buffer.from('not a pdf'), fields: {} }), /could not be opened/);
});

test('a Word CV is turned into a PDF for the candidate\'s own CV, if LibreOffice is installed', async (t) => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('LibreOffice not installed here'); }
  const { Document, Packer, Paragraph } = await import('docx');
  const { wordToPdf } = await import('../lib/convert.js');
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Jo Bloggs - Engineer')] }] }));
  const pdf = await wordToPdf(docx);
  const out = await wrapOwnCv({ pdf, fields: { name: 'Jo Bloggs' } });
  assert.equal((await LibDoc.load(out)).getPageCount(), 2, 'cover + 1 framed page');
});

test('a broken Word file gets a clear message', async (t) => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('LibreOffice not installed here'); }
  const { wordToPdf } = await import('../lib/convert.js');
  await assert.rejects(wordToPdf(Buffer.from('not a word file')), /could not be turned into a PDF/);
});
