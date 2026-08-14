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

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(REPO, 'config', 'vendors.json');
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
 * Identify an image by its BYTES. Returns the extension to save under, or null
 * when the payload is not a recognisable image.
 *
 * Content-Type and the URL's extension are both under the REMOTE server's
 * control and both lied in practice: LinkedIn's bot wall answered the favicon
 * URL with 200 + its challenge page, and the old header-based logic saved that
 * HTML as `linkedin.ico` — which then shipped in the repo until the gitleaks
 * gate flagged the reCAPTCHA sitekey inside it (PR #32). Magic bytes are the
 * ground truth; anything unrecognised is refused, so a challenge or error page
 * can never be committed as a logo again.
 *
 * @param {Buffer} buf
 * @returns {string|null}
 */
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (/^GIF8[79]a/.test(buf.toString('ascii', 0, 6))) return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  // SVG is text, so it has no magic number: require an <svg root and refuse
  // anything that looks like an HTML document (bot walls, soft-404 pages).
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.includes('<html') || head.startsWith('<!doctype html')) return null;
  if ((head.startsWith('<?xml') || head.startsWith('<svg')) && buf.toString('utf8').toLowerCase().includes('<svg')) return 'svg';
  return null;
}

/**
 * @param {string} url
 * @returns {Promise<{buf: Buffer, ext: string}|null>}
 */
async function download(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) return null; // an empty or placeholder response
    const ext = sniffImage(buf);
    if (!ext) {
      console.warn(`  ! ${url} returned something that is not an image (bot wall or error page); refused`);
      return null;
    }
    return { buf, ext };
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

  // A vendor may declare `iconUrl` to bypass favicon discovery — for rows with
  // no single brand favicon (US Government uses Twemoji's US flag, CC BY 4.0,
  // © Twitter/X — that licence requires this attribution). A declared URL that
  // stops resolving falls back to brandDomain discovery, and its bytes go
  // through the same magic-byte sniff as anything else fetched.
  let got = vendor.iconUrl ? await download(vendor.iconUrl) : null;
  if (!got) {
    const iconUrl = await discoverIconUrl(brand);
    got = iconUrl ? await download(iconUrl) : null;
  }
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

// Mirror the fetched set into the Worker's served asset directory. This used
// to be a manual copy nobody owned; the byte-parity test in logos.test.js is
// what caught runs that updated one side only. Extras in public/ that no
// longer exist in assets/ are removed, so a renamed vendor cannot leave its
// old mark shipping forever.
const PUB_DIR = join(REPO, 'public', 'service-status', 'icons');
mkdirSync(PUB_DIR, { recursive: true });
const fetched = new Set(readdirSync(OUT_DIR).filter((f) => !f.startsWith('.')).sort());
for (const f of fetched) writeFileSync(join(PUB_DIR, f), readFileSync(join(OUT_DIR, f)));
for (const f of readdirSync(PUB_DIR)) {
  if (!f.startsWith('.') && !fetched.has(f)) rmSync(join(PUB_DIR, f));
}

// Regenerate the manifest the renderer reads. It emits an <img> only for logos
// that exist, so a vendor without one degrades to its status dot rather than a
// broken image. The manifest IS tracked (render.js imports it at build time);
// the image files are not — they are a build artifact this script regenerates
// (see .gitignore for why).
const manifest = {};
for (const f of fetched) manifest[f.replace(/\.[^.]+$/, '')] = f;
writeFileSync(join(REPO, 'config', 'logos.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: ${Object.keys(manifest).length} logos -> config/logos.json (mirrored to public/)`);

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
