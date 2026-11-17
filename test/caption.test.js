import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCaption } from '../src/deferred/instagram-import.js';
const env = {};
test('listed post with weight', () => {
  const p = parseCaption('Round calico cat 🐱\n20g #forsale #polymerclay', env);
  assert.deepEqual([p.forSale, p.sold, p.grams, p.price_cents, p.title], [true, false, 20, 2000, 'Round calico cat 🐱']);
});
test('sold tag', () => {
  const p = parseCaption('Worm in an apple - 10g #forsale #sold', env);
  assert.deepEqual([p.forSale, p.sold, p.grams, p.price_cents, p.title], [true, true, 10, 1000, 'Worm in an apple']);
});
test('explicit price wins', () => {
  const p = parseCaption('Big bear, 35 g, $40 #forsale', env);
  assert.deepEqual([p.grams, p.price_cents, p.title], [35, 4000, 'Big bear']);
});
test('work in progress is not listed', () => {
  assert.equal(parseCaption('painting day! this guy is about 20g #wip', env).forSale, false);
});
test('#forsalesoon is not #forsale; $10 is not 10 grams', () => {
  assert.equal(parseCaption('#forsalesoon', env).forSale, false);
  assert.equal(parseCaption('Frog $10 #forsale', env).grams, null);
});
test('no weight means no price', () => {
  assert.equal(parseCaption('Mystery guy #forsale', env).price_cents, null);
});
