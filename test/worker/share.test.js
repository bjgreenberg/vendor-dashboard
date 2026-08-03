import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderDashboard } from '../../src/worker/render.js';

// The share bar is duplicated by necessity: this page is a Worker, the rest of
// briangreenberg.net is Eleventy, and they cannot share an include. That
// duplication drifted on the first try -- the dashboard shipped without
// Facebook and Threads while the site had both -- so the parity is asserted
// here rather than left to memory.
//
// The site's include is read from the sibling checkout when it is present. It
// is NOT a hard dependency: a clone of this repo alone, and CI, must still pass
// every other assertion in this file, so that one test skips when the path is
// absent instead of failing.

const SITE_INCLUDE = '/Users/brian/src/briangreenberg.net/src/_includes/share.njk';

const html = () => renderDashboard({ records: [], meta: null });

/**
 * Platform pill labels, in document order. Email / Copy link / Share are
 * excluded by construction: their labels open with an HTML entity (`&#9993;`),
 * so the leading-letter class skips them. They are asserted separately.
 */
function pills(doc) {
  const start = doc.indexOf('class="share-bar');
  const seg = doc.slice(start, doc.indexOf('</div>', start));
  return [...seg.matchAll(/>([A-Za-z][A-Za-z ]*?)<\/(?:a|button)>/g)].map((m) => m[1].trim());
}

describe('share bar', () => {
  it('offers every platform that publishes a web share intent', () => {
    expect(pills(html())).toEqual(['LinkedIn', 'Bluesky', 'X', 'Facebook', 'Threads', 'Mastodon']);
  });

  it('keeps the three non-platform actions', () => {
    const doc = html();
    expect(doc).toContain('Email</a>');
    expect(doc).toContain('Copy link</button>');
    expect(doc).toContain('class="pill share-native"');
  });

  it('matches the platforms the rest of the site offers', (ctx) => {
    let njk;
    try {
      njk = readFileSync(SITE_INCLUDE, 'utf8');
    } catch {
      ctx.skip(); // sibling checkout absent (CI, or a standalone clone)
      return;
    }
    const body = njk.slice(njk.indexOf('class="share-bar'));
    const site = [...body.matchAll(/>([A-Za-z][A-Za-z ]*?)<\/(?:a|button)>/g)].map((m) => m[1].trim());
    expect([...pills(html())].sort()).toEqual([...site].sort());
  });

  it('ships no third-party script or SDK', () => {
    const doc = html();
    for (const sdk of ['platform.twitter.com', 'connect.facebook.net', 'platform.linkedin.com']) {
      expect(doc).not.toContain(sdk);
    }
    // Scripts and images may be same-origin only -- the page's CSP is
    // `default-src 'none'` with self-only script/img, so anything absolute or
    // protocol-relative would be blocked at runtime AND leak a visitor's IP to
    // a third party. Asserted here so the failure surfaces at test time.
    //
    // Scoped to attributes that actually FETCH: a `<link rel="canonical">` is
    // legitimately absolute and loads nothing, so a blanket href rule would
    // fail on it. Only script/img `src` and a stylesheet/preload/icon `href`
    // cause a request.
    expect(doc.match(/<(?:script|img)[^>]+src="(?:https?:)?\/\//g), 'no remote src').toBeNull();
    expect(
      doc.match(/<link[^>]+rel="(?:stylesheet|preload|[^"]*icon)"[^>]+href="(?:https?:)?\/\//g),
      'no remote subresource href',
    ).toBeNull();
  });

  it('emits a Mastodon host check that is valid, executable JavaScript', () => {
    // This script lives inside a template literal, so an escaping slip yields a
    // regex that silently rejects every host rather than a syntax error.
    const doc = html();
    const m = doc.match(/if \(!(\/\^\[a-z0-9\.-\]\+.*?\/i)\.test\(host\)\) return;/);
    expect(m, 'the host-validation regex is present').toBeTruthy();

    const re = new RegExp(m[1].replace(/^\//, '').replace(/\/i$/, ''), 'i');
    expect(re.test('infosec.exchange')).toBe(true);
    expect(re.test('mastodon.social')).toBe(true);
    expect(re.test('')).toBe(false);
    expect(re.test('not a host')).toBe(false);
    expect(re.test('javascript:alert(1)')).toBe(false);
  });

  it('does not link platforms that have no share intent', () => {
    // Instagram, TikTok and Apple Music expose no web share endpoint. A pill
    // for one of them could only be a dead link or a bare profile URL, neither
    // of which shares anything -- the native share sheet is what reaches them.
    const doc = html();
    for (const host of ['instagram.com/share', 'tiktok.com/share', 'music.apple.com/share']) {
      expect(doc).not.toContain(host);
    }
    expect(doc).toContain('share-native');
  });
});
