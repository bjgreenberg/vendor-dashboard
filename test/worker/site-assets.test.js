import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { siteAssetVersions, resetSiteAssetCache, SITE_ASSETS } from '../../src/worker/site-assets.js';
import { renderDashboard } from '../../src/worker/render.js';

// The dashboard borrows the site's /assets/site.css, theme.js and consent.js.
// The site serves /assets/* as immutable for a year, so an UNVERSIONED link
// pins whatever copy a browser first saw: on 2026-09-30 Brian's phone kept a
// pre-fix site.css and the dashboard header ran to the screen edge while the
// site's own (versioned) pages were fixed. The dashboard now links the same
// ?v=<md5[0:10]> URLs the site's build emits.
const md5 = async (buf) => createHash('md5').update(Buffer.from(buf)).digest();
const BODIES = { '/assets/site.css': 'body{}', '/assets/js/theme.js': 'theme()', '/assets/js/consent.js': 'consent()' };
const expected = (p) => createHash('md5').update(BODIES[p]).digest('hex').slice(0, 10);
const okFetch = (calls = []) => async (url) => {
  calls.push(url);
  const p = new URL(url).pathname;
  return new Response(BODIES[p], { status: 200 });
};

describe('siteAssetVersions — the site’s own content hashes', () => {
  beforeEach(() => resetSiteAssetCache());

  it('hashes each asset exactly as the site build does (md5, first 10 hex)', async () => {
    const v = await siteAssetVersions({ fetchFn: okFetch(), digest: md5, now: () => 0 });
    expect(v).toEqual({ css: expected('/assets/site.css'), theme: expected('/assets/js/theme.js'), consent: expected('/assets/js/consent.js') });
  });
  it('fetches past any edge cache (a unique query) and only every five minutes', async () => {
    const calls = [];
    await siteAssetVersions({ fetchFn: okFetch(calls), digest: md5, now: () => 0 });
    expect(calls).toHaveLength(Object.keys(SITE_ASSETS).length);
    expect(calls.every((u) => u.startsWith('https://briangreenberg.net/assets/') && /[?&]_=/.test(u))).toBe(true);
    await siteAssetVersions({ fetchFn: okFetch(calls), digest: md5, now: () => 4 * 60_000 });
    expect(calls).toHaveLength(3);
    await siteAssetVersions({ fetchFn: okFetch(calls), digest: md5, now: () => 6 * 60_000 });
    expect(calls).toHaveLength(6);
  });
  it('degrades, never dies: no versions on a first failure, the last good ones after that', async () => {
    const boom = async () => new Response('', { status: 503 });
    expect(await siteAssetVersions({ fetchFn: boom, digest: md5, now: () => 0 })).toBeNull();
    const good = await siteAssetVersions({ fetchFn: okFetch(), digest: md5, now: () => 0 });
    expect(await siteAssetVersions({ fetchFn: boom, digest: md5, now: () => 10 * 60_000 })).toEqual(good);
  });
});

describe('renderDashboard — versioned links to the site’s assets', () => {
  it('links site.css, theme.js and consent.js with ?v= when versions are known', () => {
    const html = renderDashboard({ assetVersions: { css: 'aaaaaaaaaa', theme: 'bbbbbbbbbb', consent: 'cccccccccc' } });
    expect(html).toContain('href="/assets/site.css?v=aaaaaaaaaa"');
    expect(html).toContain('src="/assets/js/theme.js?v=bbbbbbbbbb"');
    expect(html).toContain('src="/assets/js/consent.js?v=cccccccccc"');
  });
  it('falls back to the plain links when they are not', () => {
    const html = renderDashboard({});
    expect(html).toContain('href="/assets/site.css"');
    expect(html).toContain('src="/assets/js/theme.js"');
  });
  it('never lets a version string break out of the attribute', () => {
    const html = renderDashboard({ assetVersions: { css: '"><script>x</script>' } });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('href="/assets/site.css"');
  });
});
