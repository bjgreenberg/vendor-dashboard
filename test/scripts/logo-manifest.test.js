import { describe, it, expect } from 'vitest';
import { reconcileManifest } from '../../scripts/logo-manifest.mjs';

// The 2026-08-28 hume deploy: five refused downloads shrank the manifest and
// the live board lost five logos. These pin the rule that a refused download
// never prunes; only leaving config does.
describe('reconcileManifest', () => {
  const previous = { linkedin: 'linkedin.png', openai: 'openai.png', zoom: 'zoom.svg', gone: 'gone.png' };
  const configured = ['linkedin', 'openai', 'zoom', 'brandnew'];

  it('a refused download keeps the committed entry and reports it as missing (fail the build)', () => {
    const r = reconcileManifest(previous, ['zoom.svg', 'openai.png'], configured);
    expect(r.manifest).toEqual({ linkedin: 'linkedin.png', openai: 'openai.png', zoom: 'zoom.svg' });
    expect(r.missing).toEqual(['linkedin']);
  });
  it('an entry is pruned only when its vendor left config', () => {
    const r = reconcileManifest(previous, ['linkedin.png', 'openai.png', 'zoom.svg', 'gone.png'], configured);
    expect(r.manifest).not.toHaveProperty('gone');
    expect(r.pruned).toEqual(['gone']);
    expect(r.missing).toEqual([]);
  });
  it('a newly fetched logo joins; a stray file for an unconfigured vendor does not', () => {
    const r = reconcileManifest(previous, ['linkedin.png', 'openai.png', 'zoom.svg', 'brandnew.png', 'stray.png'], configured);
    expect(r.manifest.brandnew).toBe('brandnew.png');
    expect(r.manifest).not.toHaveProperty('stray');
  });
  it('a re-fetch that changed the extension wins over the committed entry', () => {
    const r = reconcileManifest({ zoom: 'zoom.png' }, ['zoom.svg'], ['zoom']);
    expect(r.manifest).toEqual({ zoom: 'zoom.svg' });
  });
  it('dotfiles are ignored and the output is sorted', () => {
    const r = reconcileManifest({}, ['.DS_Store', 'b.png', 'a.png'], ['a', 'b']);
    expect(Object.keys(r.manifest)).toEqual(['a', 'b']);
  });
});
