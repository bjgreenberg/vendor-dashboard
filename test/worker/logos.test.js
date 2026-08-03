import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The icon FILES are a build artifact since the repo went public-ready:
// redistributing 46 trademarked marks in a public repo is a different act
// from serving them on the dashboard, so they are gitignored and regenerated
// by scripts/fetch-logos.mjs. A fresh clone therefore has no icons on disk —
// the disk-reading gates below run wherever the artifact exists (any machine
// that fetches or deploys logos, which is the only place icons can change)
// and skip loudly on a bare checkout. The MANIFEST gates always run: the
// manifest is tracked, because render.js imports it at build time.
const iconsOnDisk = (dir) => existsSync(dir) && readdirSync(dir).some((f) => !f.startsWith('.'));

// Reported from a phone 2026-08-01: Signal's logo was invisible — white on
// white. Its favicon ships an OS-theme-adaptive style:
//
//   @media (prefers-color-scheme: dark) { path { fill:#FFFFFF; } }
//
// Right for a browser tab, wrong here: the chip these sit on has its own fixed
// near-white background, independent of the page theme. An embedded <style>
// also BEATS a path's `fill` attribute, so the blue fills already present were
// being overridden.
//
// Vendors change their favicons whenever they like, so this is a GATE rather
// than a one-off fix — the next adaptive favicon fails here instead of
// vanishing on someone's phone.

const DIR = 'public/service-status/icons';
const svgs = iconsOnDisk(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.svg')) : [];

/** CSS with comments removed — a commented-out rule is inert. */
const activeCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe.runIf(iconsOnDisk(DIR))('self-hosted logos render deterministically on the chip', () => {
  it('has SVGs to check', () => {
    expect(svgs.length).toBeGreaterThan(0);
  });

  it.each(svgs)('%s carries no active prefers-color-scheme rule', (file) => {
    const svg = readFileSync(join(DIR, file), 'utf8');
    // Tailscale ships its dark rules inside a comment block, which is inert;
    // stripping comments first keeps that from being a false positive.
    expect(activeCss(svg)).not.toMatch(/prefers-color-scheme/);
  });

  it.each(svgs)('%s has balanced braces in any style block', (file) => {
    // The first attempt at the sanitiser ate a closing brace and emitted
    // `<style>path { fill:#3B45FD;</style>`, which silently breaks the rule.
    const svg = readFileSync(join(DIR, file), 'utf8');
    for (const block of svg.match(/<style>[\s\S]*?<\/style>/gi) ?? []) {
      expect((block.match(/\{/g) ?? []).length).toBe((block.match(/\}/g) ?? []).length);
    }
  });

  it('never fills a whole logo pure white', () => {
    // The failure mode in one assertion: a mark that is entirely #fff is
    // invisible on the chip whatever the page theme.
    for (const file of svgs) {
      const svg = readFileSync(join(DIR, file), 'utf8');
      const fills = [...svg.matchAll(/fill[:=]\s*"?(#[0-9a-f]{3,6})/gi)].map((m) => m[1].toLowerCase());
      const coloured = fills.filter((f) => !['#fff', '#ffffff'].includes(f));
      if (fills.length > 0) {
        expect(coloured.length, `${file} is entirely white`).toBeGreaterThan(0);
      }
    }
  });
});

describe('every vendor has a locally-hosted logo', () => {
  // The logos are self-hosted deliberately: hot-linking would mean ~46
  // third-party requests per page view, leaking every visitor's IP to 46
  // companies on a site with a privacy policy, and would force widening the
  // CSP past `img-src 'self' data:`. This gate keeps that true as vendors are
  // added — a new vendor with no logo silently falls back to a status dot,
  // which is easy to miss on a 46-row board.
  const config = JSON.parse(readFileSync('config/vendors.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('config/logos.json', 'utf8'));
  const slug = (n) =>
    String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  it.each(config.vendors.map((v) => v.name))('%s has a logo in the manifest', (name) => {
    expect(manifest[slug(name)]).toBeTruthy();
  });

  it.runIf(iconsOnDisk(DIR)).each(config.vendors.map((v) => v.name))(
    '%s logo file is actually served',
    (name) => {
      // A manifest entry pointing at a missing file renders a broken image,
      // which is worse than no logo at all. Disk-gated: icons are a build
      // artifact (see header comment), so this runs where they exist.
      const file = manifest[slug(name)];
      expect(() => readFileSync(join(DIR, file))).not.toThrow();
    },
  );

  it('declares a brandDomain for every vendor, so a refetch can find the icon', () => {
    for (const v of config.vendors) {
      expect(v.brandDomain, `${v.name} has no brandDomain`).toBeTruthy();
    }
  });

  it('has no orphaned logo files left by a rename', () => {
    // Renaming a vendor (Amazon Web Services -> AWS, or folding Microsoft
    // Azure into the composite) leaves its old file behind and shipping in the
    // Worker's static assets forever.
    const slugs = new Set(config.vendors.map((v) => slug(v.name)));
    const orphans = Object.keys(manifest).filter((k) => !slugs.has(k));
    expect(orphans, `orphaned logos: ${orphans.join(', ')}`).toEqual([]);
  });

  it('serves every logo from the Worker asset directory, not a remote host', () => {
    // The manifest must name bare filenames; an absolute URL here would mean a
    // hot-link, defeating the whole point.
    for (const [key, file] of Object.entries(manifest)) {
      expect(file, `${key} is not a local filename`).not.toMatch(/^https?:\/\//);
      expect(file).not.toContain('/');
    }
  });
});

// Found by the secret-scan gate on PR #32: assets/icons/linkedin.ico was not an
// icon at all but LinkedIn's bot-challenge HTML page, saved verbatim by
// fetch-logos.mjs because the script trusted the response instead of the bytes.
// gitleaks flagged the reCAPTCHA sitekey inside it. The icon directories are
// SERVED to every visitor, so anything that is not a genuine image is a defect:
// validate by magic bytes, never by extension or Content-Type — both are under
// the remote server's control.
describe.runIf(iconsOnDisk(DIR))('every shipped icon is a genuine image (magic bytes)', () => {
  const DIRS = ['assets/icons', 'public/service-status/icons'];
  const manifest = JSON.parse(readFileSync('config/logos.json', 'utf8'));

  /** @param {Buffer} buf @returns {string|null} detected format, null = not an image */
  const sniff = (buf) => {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (/^GIF8[79]a/.test(buf.toString('ascii', 0, 6))) return 'gif';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
    if (head.includes('<html') || head.startsWith('<!doctype html')) return null;
    if ((head.startsWith('<?xml') || head.startsWith('<svg')) && buf.toString('utf8').toLowerCase().includes('<svg')) return 'svg';
    return null;
  };

  for (const dir of DIRS) {
    // Guarded at collection time too: describe.runIf skips EXECUTION, but the
    // suite body still runs during collection, where a readdirSync on a
    // missing directory would throw on a fresh clone.
    it.each(existsSync(dir) ? readdirSync(dir) : [])(`${dir}/%s is a real image, not a saved error/challenge page`, (file) => {
      const format = sniff(readFileSync(join(dir, file)));
      expect(format, `${dir}/${file} is not a recognisable image`).not.toBeNull();
    });
  }

  it('ships no icon file the manifest does not reference', () => {
    // fetch-logos.mjs keys the manifest by basename, so when a better format
    // arrives (apple.ico superseded by apple.png) the old file stays on disk,
    // unmapped, and ships in the Worker's public assets forever. Dead weight,
    // and — as linkedin.ico proved — sometimes worse than dead weight.
    const mapped = new Set(Object.values(manifest));
    for (const dir of DIRS) {
      const orphans = readdirSync(dir).filter((f) => !f.startsWith('.') && !mapped.has(f));
      expect(orphans, `unmapped files in ${dir}`).toEqual([]);
    }
  });

  it('keeps assets/icons and the served public/ copy byte-identical', () => {
    // No build step syncs the two directories; the copy is manual. This is the
    // gate that catches a fetch that updated one side only.
    const [a, b] = DIRS;
    const av = readdirSync(a).filter((f) => !f.startsWith('.')).sort();
    const bv = readdirSync(b).filter((f) => !f.startsWith('.')).sort();
    expect(av).toEqual(bv);
    for (const f of av) {
      expect(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), `${f} differs between ${a} and ${b}`).toBe(true);
    }
  });
});
