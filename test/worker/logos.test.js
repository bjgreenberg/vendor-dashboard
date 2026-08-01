import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
const svgs = readdirSync(DIR).filter((f) => f.endsWith('.svg'));

/** CSS with comments removed — a commented-out rule is inert. */
const activeCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('self-hosted logos render deterministically on the chip', () => {
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
  const config = JSON.parse(readFileSync('config/vendors.example.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('config/logos.json', 'utf8'));
  const slug = (n) =>
    String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  it.each(config.vendors.map((v) => v.name))('%s has a logo in the manifest', (name) => {
    expect(manifest[slug(name)]).toBeTruthy();
  });

  it.each(config.vendors.map((v) => v.name))('%s logo file is actually served', (name) => {
    // A manifest entry pointing at a missing file renders a broken image,
    // which is worse than no logo at all.
    const file = manifest[slug(name)];
    expect(() => readFileSync(join(DIR, file))).not.toThrow();
  });

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
