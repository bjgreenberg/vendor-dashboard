/**
 * Content hashes for the site assets the dashboard borrows.
 *
 * The dashboard renders inside briangreenberg.net's chrome and loads the
 * site's /assets/site.css, /assets/js/theme.js and /assets/js/consent.js. The
 * site serves /assets/* as `immutable` for a year and busts caches with a
 * `?v=<md5[0:10]>` content hash on every link (its eleventy.config.js
 * `assetHash`). An UNVERSIONED link can therefore never be busted: on
 * 2026-09-30 a phone kept a pre-fix site.css and the dashboard header ran to
 * the screen edge while the site's own pages were already fixed.
 *
 * So the Worker fetches each asset, hashes it the way the site build does,
 * and the page links the same URLs the site emits (one browser cache entry
 * shared by both). Degrade, don't die: until a first fetch succeeds the page
 * keeps the plain links (today's behaviour); after that a failed refresh
 * keeps the last good versions and retries a minute later.
 *
 * The site is a Custom Domain Worker, which Cloudflare treats as the zone's
 * origin, so a same-zone fetch from this route-bound Worker reaches it.
 */

export const SITE_ORIGIN = 'https://briangreenberg.net';
export const SITE_ASSETS = Object.freeze({
  css: '/assets/site.css',
  theme: '/assets/js/theme.js',
  consent: '/assets/js/consent.js',
});
const TTL_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 3000;

/** @type {{at: number, versions: Record<string, string>} | null} */
let cached = null;

/** Test hook: forget the isolate-level cache. */
export function resetSiteAssetCache() {
  cached = null;
}

/** MD5 via Workers' WebCrypto (Cloudflare supports the non-standard MD5 digest). */
const md5Digest = (buf) => crypto.subtle.digest('MD5', buf);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * @param {{fetchFn?: typeof fetch, digest?: (buf: ArrayBuffer) => Promise<ArrayBuffer|Uint8Array>, now?: () => number}} [opts]
 * @returns {Promise<Record<string, string> | null>} version per asset key, or null when none is known yet
 */
export async function siteAssetVersions({ fetchFn = fetch, digest = md5Digest, now = Date.now } = {}) {
  const t = now();
  if (cached && t - cached.at < TTL_MS) return cached.versions;
  try {
    const entries = await Promise.all(
      Object.entries(SITE_ASSETS).map(async ([key, path]) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
          // A unique query keeps any edge cache out of it; the asset server
          // ignores the query and returns the current file.
          const res = await fetchFn(`${SITE_ORIGIN}${path}?_=${t}`, { signal: ctrl.signal });
          if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
          return [key, hex(await digest(await res.arrayBuffer())).slice(0, 10)];
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    cached = { at: t, versions: Object.fromEntries(entries) };
    return cached.versions;
  } catch {
    if (!cached) return null;
    // Keep serving the last good versions; try again in a minute.
    cached = { at: t - TTL_MS + RETRY_MS, versions: cached.versions };
    return cached.versions;
  }
}
