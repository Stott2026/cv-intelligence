import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvNumberSet, checkAchievements, checkCompanies, checkVacancies, stripUnverifiedSentences, houseStyle, normaliseUrl } from '../lib/verify.js';

const cv = 'Cut cloud cost by 32%. Managed a team of 6 engineers. Handled 4.5 million events a day. Revenue grew to £1,200,000.';
const nums = cvNumberSet(cv);

test('achievement figures must be in the CV', () => {
  const out = checkAchievements([
    { figure: '32%', statement: 'Cut cloud cost by 32%', source: 'From CV', cvQuote: '' },
    { figure: '40%', statement: 'Cut cloud cost by 40%', source: 'From CV', cvQuote: '' },
    { figure: '', statement: 'Improved reporting speed - ask for a figure', source: 'Inferred - check', cvQuote: '' },
    { figure: '£1.2m', statement: 'Grew revenue to £1,200,000', source: 'From CV', cvQuote: '' },
  ], nums);
  assert.equal(out[0].source, 'From CV');
  assert.equal(out.length, 3, 'the 40% item is dropped');
  assert.ok(!out.some((a) => a.statement.includes('40%')));
  assert.deepEqual(out[2], { figure: '', statement: 'Grew revenue to £1,200,000', source: 'Inferred - check', cvQuote: '' }, 'recalculated figure £1.2m is not shown');
});

test('a From CV item with an unverified figure but clean statement is downgraded', () => {
  const out = checkAchievements([{ figure: '10x', statement: 'Led a large team', source: 'From CV', cvQuote: '' }], nums);
  assert.deepEqual(out.map((a) => [a.source, a.figure]), [['Inferred - check', '']]);
});

test('companies over the limit or without a size are removed', () => {
  const out = checkCompanies([
    { name: 'A', approxEmployees: 250 }, { name: 'B', approxEmployees: 1500 },
    { name: 'C', approxEmployees: 1000 }, { name: 'D', approxEmployees: null }, { name: 'E', approxEmployees: 400 },
  ], 1000);
  assert.deepEqual(out.map((c) => c.name), ['A', 'C', 'E']);
  assert.deepEqual(checkCompanies([{ name: 'E', approxEmployees: 400 }], 200), []);
  assert.deepEqual(checkCompanies([{ name: 'F', approxEmployees: 5000 }], 99999), [], 'limit can never exceed 1,000');
});

test('vacancies must link to a URL seen in search results', () => {
  const seen = new Set(['https://www.example.com/jobs/123?utm_source=x', 'https://jobs.example.org/a/']);
  const out = checkVacancies([
    { title: 'A', url: 'https://example.com/jobs/123' },
    { title: 'B', url: 'https://jobs.example.org/a' },
    { title: 'C', url: 'https://made-up.example.net/job' },
    { title: 'D', url: 'javascript:alert(1)' },
  ], seen);
  assert.deepEqual(out.map((v) => v.title), ['A', 'B']);
  assert.equal(normaliseUrl('ftp://x'), null);
});

test('sentences with invented numbers are removed', () => {
  assert.equal(stripUnverifiedSentences('Has 8 years in data. Led a team of 6.', nums), 'Led a team of 6.');
});

test('em and en dashes become spaced hyphens, URLs untouched', () => {
  assert.deepEqual(houseStyle({ a: 'Fast—reliable – good', url: 'https://x.com/a—b' }), { a: 'Fast - reliable - good', url: 'https://x.com/a—b' });
});

test('vacancy descriptions lose sentences quoting numbers not in the CV', () => {
  const seen = new Set(['https://jobs.example.com/1']);
  const [v] = checkVacancies([{ title: 'A', url: 'https://jobs.example.com/1',
    whySuitable: 'Uses the same stack. It asks for 2 years of experience. The team is 6 engineers.' }], seen, nums);
  assert.equal(v.whySuitable, 'Uses the same stack. The team is 6 engineers.');
  const [w] = checkVacancies([{ title: 'B', url: 'https://jobs.example.com/1', whySuitable: 'Needs 5 years.' }], seen);
  assert.equal(w.whySuitable, '', 'with no CV text, any number is removed');
});
