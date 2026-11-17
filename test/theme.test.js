import test from 'node:test';
import assert from 'node:assert/strict';
import { themeCss, DEFAULT_THEME, parseTags } from '../src/store.js';

test('theme css falls back to defaults for anything that is not a plain color or font name', () => {
  const css = themeCss({ ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, paper: 'red;}body{display:none' },
    fonts: { head: 'Evil"; }', body: 'Nunito', hand: 'Caveat' }, custom_fonts: [{ name: 'Bad"}', key: 'fonts/x.woff2' }] });
  assert.ok(!css.includes('display:none'));
  assert.ok(!css.includes('Evil'));
  assert.ok(!css.includes('Bad'));
  assert.ok(css.includes('--paper: #f3f1fa;'));
  assert.ok(css.includes('"Nunito"'));
});
test('tags are trimmed, lowercased, de-duplicated and lose their #', () => {
  assert.deepEqual(parseTags('Calico, round,  #Cat, calico,,'), ['calico', 'round', 'cat']);
});
