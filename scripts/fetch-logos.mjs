#!/usr/bin/env node
/**
 * fetch-logos.mjs — build-time logo pipeline.
 *
 * Downloads each vendor's own favicon ONCE, at build time, and writes it into
 * the repository. The dashboard then serves those files itself.
 *
 * WHY BUILD-TIME AND SELF-HOSTED. Hot-linking vendor logos would mean ~41
 * third-party requests on every page view, leaking every visitor's IP address to
 * 41 companies — on a site with a privacy policy and consent-gated analytics. It
 * would also force widening the CSP beyond `img-src 'self' data:` and would
 * break silently whenever a vendor moved a file. Fetching once, here, costs a
 * visitor nothing and keeps the CSP as it is.
 *
 * The brand domain is DECLARED per vendor in config, never derived from the
 * status URL: status.cloudflarestatus.com would yield "cloudflarestatus.com",
 * and www.calendlystatus.com "calendlystatus.com" — neither is the brand.
 *
 * Idempotent: re-running skips anything already present unless --force.
 *
 *   node scripts/fetch-logos.mjs [--force] [--only <vendor>]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(REPO, 'config', 'vendors.example.json');
const OUT_DIR = join(REPO, 'assets', 'icons');

const UA = 'vendor-dashboard/2.0 (+https://briangreenberg.net/service-status; logo fetch, build-time only)';

const force = process.argv.includes('--force');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;

/** @param {string} name */
const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Find the best icon URL a site declares, falling back to /favicon.ico.
 * Prefers the largest declared size, and SVG above all (crisp at any scale).
 *
 * @param {string} domain
 * @returns {Promise<string|null>}
 */
async function discoverIconUrl(domain) {
  const base = `https://${domain}/`;
  let html = '';
  try {
    const res = await fetch(base, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (res.ok) html = await res.text();
  } catch {
    /* fall through to the conventional path */
  }

  const links = [...html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi)].map((m) => m[0]);
  const candidates = [];
  for (const tag of links) {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const sizes = tag.match(/sizes=["'](\d+)/i)?.[1];
    candidates.push({
      url: new URL(href, base).href,
      size: sizes ? Number(sizes) : tag.toLowerCase().includes('.svg') ? 9999 : 0,
    });
  }
  candidates.sort((a, b) => b.size - a.size);
  if (candidates.length) return candidates[0].url;

  return `https://${domain}/favicon.ico`;
}

/**
 * @param {string} url
 * @returns {Promise<{buf: Buffer, ext: string}|null>}
 */
async function download(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) return null; // an empty or placeholder response
    const ext = type.includes('svg')
      ? 'svg'
      : type.includes('png')
        ? 'png'
        : type.includes('x-icon') || type.includes('vnd.microsoft.icon')
          ? 'ico'
          : url.split('.').pop()?.slice(0, 4).toLowerCase() || 'png';
    return { buf, ext: ['svg', 'png', 'ico', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png' };
  } catch {
    return null;
  }
}

/**
 * Make an SVG render deterministically on the logo chip.
 *
 * Vendor favicons increasingly ship a `prefers-color-scheme` block so they can
 * adapt to the OS theme. That is right for a browser tab and wrong here: the
 * chip these sit on has its OWN fixed near-white background, independent of the
 * page theme. Signal's favicon flips every path to #FFFFFF in dark mode, so on
 * a dark-themed page it rendered white-on-white and vanished (reported
 * 2026-08-01). An embedded <style> also BEATS a path's own `fill` attribute, so
 * the blue fills already present were being overridden.
 *
 * The light-mode declarations are what the chip wants, so they are emitted
 * unconditionally and the dark block is dropped — preserving the vendor's
 * intent for a light background rather than merely deleting styling.
 *
 * Comments are stripped before matching: Tailscale ships its dark rules inside
 * a /* ... *\/ block, which is already inert, and rewriting it would be a
 * pointless diff.
 *
 * @param {string} svg
 * @returns {string}
 */
function neutralizeColorScheme(svg) {
  return svg.replace(/<style>([\s\S]*?)<\/style>/gi, (whole, css) => {
    const active = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (!/prefers-color-scheme/.test(active)) return whole;

    // Keep the light-scheme body, unwrapped; drop dark entirely.
    let kept = '';
    // Inner capture must END on a brace, or the rule's own closing brace is
    // eaten and the emitted CSS is malformed.
    const light = /@media[^{]*prefers-color-scheme:\s*light[^{]*\{([\s\S]*?\})\s*\}/i.exec(active);
    if (light) kept = light[1].trim();

    const rest = active
      .replace(/@media[^{]*prefers-color-scheme:[^{]*\{[\s\S]*?\}\s*\}/gi, '')
      .trim();

    const body = [rest, kept].filter(Boolean).join('\n');
    return body ? `<style>${body}</style>` : '';
  });
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
mkdirSync(OUT_DIR, { recursive: true });

const results = { written: [], skipped: [], missing: [], noBrand: [] };

for (const vendor of config.vendors) {
  if (only && vendor.name !== only) continue;

  const brand = vendor.brandDomain;
  if (!brand) {
    results.noBrand.push(vendor.name);
    continue;
  }

  const slug = slugify(vendor.name);
  const already = readdirSync(OUT_DIR).find((f) => f.startsWith(`${slug}.`));
  if (already && !force) {
    results.skipped.push(vendor.name);
    continue;
  }

  const iconUrl = await discoverIconUrl(brand);
  const got = iconUrl ? await download(iconUrl) : null;
  if (!got) {
    results.missing.push(`${vendor.name} (${brand})`);
    continue;
  }

  // SVGs are sanitised before writing so an OS-theme-adaptive favicon cannot
  // render invisibly on the chip's fixed background. This call was once added
  // to the file but never actually wired in — the function sat as dead code and
  // a --force refetch silently reintroduced Signal's white-on-white logo.
  // test/worker/logos.test.js is what caught it.
  const bytes =
    got.ext === 'svg'
      ? Buffer.from(neutralizeColorScheme(got.buf.toString('utf8')), 'utf8')
      : got.buf;
  writeFileSync(join(OUT_DIR, `${slug}.${got.ext}`), bytes);
  results.written.push(`${vendor.name} -> ${slug}.${got.ext} (${(got.buf.length / 1024).toFixed(1)}kB)`);
}

// Regenerate the manifest the renderer reads. It emits an <img> only for logos
// that exist, so a vendor without one degrades to its status dot rather than a
// broken image.
const manifest = {};
for (const f of readdirSync(OUT_DIR).sort()) manifest[f.replace(/\.[^.]+$/, '')] = f;
writeFileSync(join(REPO, 'config', 'logos.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: ${Object.keys(manifest).length} logos -> config/logos.json`);

console.log(`written: ${results.written.length}  skipped: ${results.skipped.length}  missing: ${results.missing.length}  no brandDomain: ${results.noBrand.length}`);
for (const w of results.written) console.log(`  + ${w}`);
if (results.missing.length) {
  console.log('\nno usable icon found (declare one manually or leave the vendor without a mark):');
  for (const m of results.missing) console.log(`  - ${m}`);
}
if (results.noBrand.length) {
  console.log('\nno brandDomain in config:');
  for (const n of results.noBrand) console.log(`  - ${n}`);
}
