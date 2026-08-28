import { describe, it, expect } from 'vitest';
import { toPlainText } from '../../src/engine/record.js';

// Some feeds ship markdown in plain-text fields (Google, 2026-08-28); the
// markers rendered literally on the card. Only the markers go.
describe('toPlainText strips markdown emphasis and heading markers', () => {
  it('removes bold and underscore emphasis but keeps the words', () => {
    expect(toPlainText('**Summary:** all __good__ here')).toBe('Summary: all good here');
  });
  it('removes heading hashes', () => {
    expect(toPlainText('# Title\nbody')).toBe('Title body');
  });
  it('still strips HTML and collapses whitespace', () => {
    expect(toPlainText('<p>a</p>   <b>b</b>')).toBe('a b');
  });
  it('leaves a lone asterisk or a math expression alone', () => {
    expect(toPlainText('2 * 3 = 6 and a*b')).toBe('2 * 3 = 6 and a*b');
  });
});
