import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// public/_headers governs STATIC ASSETS only. Workers static assets answer
// before the Worker runs (no run_worker_first in wrangler.jsonc), so the
// Worker's per-response nonce CSP never reaches an icon or a share card. A
// vendor SVG opened at its own URL is a document on the site's origin; the
// static path therefore carries its own locked-down policy: nothing may load
// or run, inline styles (which real marks use) still apply, and `sandbox`
// treats the document as a unique opaque origin. fetch-logos.mjs refusing
// active SVG content is the first layer (test/scripts/svg-active-content.test.js);
// this pins the second.

const HEADERS_FILE = 'public/_headers';

/**
 * Parse Cloudflare's _headers format into [{pattern, headers}]. Only the
 * splat (`*`) form is supported here: a placeholder rule would need the full
 * matcher, so one makes this test fail rather than match wrongly.
 */
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const m = /^\s+(!\s*)?([^:]+?)\s*(?::\s*(.*))?$/.exec(raw);
    if (!current || !m) throw new Error(`unparseable _headers line: ${raw}`);
    current.headers.push({ detach: Boolean(m[1]), name: m[2].toLowerCase(), value: (m[3] ?? '').trim() });
  }
  return rules;
}

const toRegex = (pattern) => {
  if (/(^|\/):[A-Za-z]/.test(pattern)) throw new Error(`placeholder rules are not modelled by this test: ${pattern}`);
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
};

/** Every header value the rules attach to a path, in file order (Cloudflare comma-joins repeats). */
function headersFor(rules, path) {
  const out = {};
  for (const rule of rules) {
    if (!toRegex(rule.pattern).test(path)) continue;
    for (const h of rule.headers) {
      if (h.detach) delete out[h.name];
      else (out[h.name] ??= []).push(h.value);
    }
  }
  return out;
}

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

const rules = parseHeaders(readFileSync(HEADERS_FILE, 'utf8'));

// Every static file the Worker deploy uploads under /service-status, plus an
// icon path that exists on any deploy host even though icons are gitignored
// here (a bare checkout has none on disk).
const servedPaths = [
  ...walk('public/service-status').map((p) => '/' + relative('public', p).split(sep).join('/')),
  '/service-status/icons/example.svg',
  '/service-status/icons/example.png',
];

/** Directive name -> source list. */
const directives = (csp) =>
  Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...sources] = d.split(/\s+/);
        return [name.toLowerCase(), sources];
      }),
  );

describe('public/_headers — static assets under /service-status', () => {
  it('has paths to check', () => {
    expect(servedPaths.length).toBeGreaterThan(2);
  });

  it.each(servedPaths)('%s carries exactly one locked-down Content-Security-Policy', (path) => {
    const csp = headersFor(rules, path)['content-security-policy'];
    expect(csp, `${path} has no CSP`).toBeDefined();
    // Two rules would be comma-joined into two policies; keep it one so the
    // policy a reader sees in the file is the policy that applies.
    expect(csp).toHaveLength(1);
    const d = directives(csp[0]);
    expect(d['default-src']).toEqual(["'none'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:']);
    expect(d['style-src']).toEqual(["'unsafe-inline'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d).toHaveProperty('sandbox');
    expect(d.sandbox, 'sandbox must grant nothing (no allow-scripts)').toEqual([]);
    // Nothing that could let script run or reach another origin.
    expect(d).not.toHaveProperty('script-src');
    expect(d).not.toHaveProperty('script-src-elem');
    expect(d).not.toHaveProperty('script-src-attr');
    expect(csp[0]).not.toMatch(/unsafe-eval|https?:|\*/);
  });

  it.each(servedPaths)('%s keeps the cache, HSTS and nosniff headers', (path) => {
    const h = headersFor(rules, path);
    expect(h['cache-control']).toEqual(['public, max-age=604800']);
    expect(h['strict-transport-security']).toEqual(['max-age=31536000; includeSubDomains']);
    expect(h['x-content-type-options']).toEqual(['nosniff']);
  });
});
