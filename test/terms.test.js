import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normName, makeMatcher, flagTerms } from '../lib/terms.js';

const CLIENTS = [
  { id: 1, name: 'Ravelin Technology Ltd', domain: 'ravelin.com', termsTypes: ['Perm'], owner: 'Ian B.', archived: false },
  { id: 2, name: 'Mytos', domain: 'mytos.bio', termsTypes: ['Perm', 'Contract'], owner: 'Sean W.', archived: false },
  { id: 3, name: 'The Hadean Group', domain: 'hadean.com', termsTypes: ['SOW'], owner: 'Tom R.', archived: true },
  { id: 4, name: 'AB', domain: '', termsTypes: [], owner: '', archived: false },
];
const match = makeMatcher(CLIENTS);

test('company names are compared without legal suffixes, "The", case or punctuation', () => {
  assert.equal(normName('Ravelin Technology Ltd.'), 'ravelin technology');
  assert.equal(normName('The Hadean Group'), 'hadean');
  assert.equal(normName('Smith & Jones LLP'), 'smith and jones');
  assert.equal(normName('Société Générale SA'), 'societe generale');
  assert.equal(match({ name: 'Ravelin Technology' }).owner, 'Ian B.');
  assert.equal(match({ name: 'RAVELIN TECHNOLOGY LIMITED' }).termsTypes[0], 'Perm');
});

test('ended Terms are flagged as ended; unrelated or very short names never match', () => {
  assert.equal(match({ name: 'Hadean' }).archived, true);
  assert.equal(match({ name: 'Ravelin' }).owner, 'Ian B.', 'a common word like Technology can be left off');
  assert.equal(match({ name: 'Ravelinx' }), null, 'a different name is not a match');
  assert.equal(match({ name: 'AB' }), null, 'names under 3 letters are ignored');
  assert.equal(match({ name: 'Acme' }), null);
});

test('vacancies match on the employer in an applicant tracking link or the employer\'s own website', () => {
  assert.equal(match({ name: 'Unknown', url: 'https://jobs.lever.co/mytos/bbb558c0' }).owner, 'Sean W.');
  assert.equal(match({ name: '', url: 'https://careers.ravelin.com/jobs/123' }).owner, 'Ian B.');
  assert.equal(match({ name: '', url: 'https://jobs.lever.co/someoneelse/1' }), null);
});

test('the badge links to the client in Client Radar, and Terms clients are listed first', () => {
  const items = [{ name: 'Acme' }, { name: 'Hadean' }, { name: 'Mytos' }, { name: 'Beta' }];
  const out = flagTerms(items, match, (c) => ({ name: c.name }));
  assert.deepEqual(out.map((c) => c.name), ['Mytos', 'Acme', 'Hadean', 'Beta'], 'current Terms first, others keep their order');
  assert.match(out[0].terms.link, /\?client=2$/);
  assert.equal(out[1].terms, null);
  assert.deepEqual(flagTerms(items, null, (c) => c), items, 'no feed: nothing changes');
});
