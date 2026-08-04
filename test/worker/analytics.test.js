import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../../src/worker/render.js';
import worker from '../../src/worker/index.js';
import { makeD1 } from '../helpers/d1.js';

// The board is part of briangreenberg.net and should report like the rest of
// it (operator decision 2026-08-04). It reuses the SITE's analytics model
// exactly rather than inventing a second one:
//
//   Cloudflare Web Analytics — ungated. Cookieless, stores nothing on the
//     device, no fingerprinting, so it falls outside consent (the site makes
//     the same call, and says so on /privacy/).
//   Google Analytics 4 — loaded ONLY after explicit consent, by the site's
//     own /assets/js/consent.js, which reads data-ga4-id and shares the
//     `analytics-consent` localStorage key with the site. Same origin, so a
//     decision made on the site already applies here.
//
// The CSP must widen exactly enough for those two and no further; every
// addition below is asserted so a future edit cannot quietly loosen it.

const doc = () => renderDashboard({ records: [], meta: null, nonce: 'testnonce' });

describe('analytics parity with the site', () => {
  it('emits the Cloudflare Web Analytics beacon with the site token', () => {
    const h = doc();
    expect(h).toContain('static.cloudflareinsights.com/beacon.min.js');
    expect(h).toContain('525f27dcb953478db9d0e947f477281a');
  });

  it('loads the SITE consent gate rather than a second implementation', () => {
    const h = doc();
    expect(h).toContain('/assets/js/consent.js');
    // consent.js reads the GA4 id from this attribute; without it, no GA.
    expect(h).toMatch(/<html[^>]+data-ga4-id="G-6XYP02XLFE"/);
  });

  it('never loads Google directly — only the gate may do that', () => {
    // A googletagmanager <script src> in the markup would defeat consent.
    expect(doc()).not.toMatch(/<script[^>]+googletagmanager/);
  });
});

describe('CSP widens exactly enough, and no further', () => {
  // The policy is an HTTP HEADER, not markup — test it where it actually
  // lives, through the real fetch handler.
  const csp = async () => {
    const res = await worker.fetch(new Request('https://x/service-status/'), {
      DB: makeD1(),
      BASE_PATH: '/service-status',
    });
    return res.headers.get('Content-Security-Policy');
  };

  it('allows the two analytics script origins', async () => {
    const c = await csp();
    expect(c).toContain('https://static.cloudflareinsights.com');
    expect(c).toContain('https://www.googletagmanager.com');
  });

  it('allows the beacon and GA to report back', async () => {
    const c = await csp();
    expect(c).toMatch(/connect-src[^;]*cloudflareinsights\.com/);
    expect(c).toMatch(/connect-src[^;]*google-analytics\.com/);
  });

  it('keeps the rest of the policy locked down', async () => {
    const c = await csp();
    expect(c).toContain("default-src 'none'");
    expect(c).toContain("frame-ancestors 'none'");
    expect(c).toContain("base-uri 'none'");
    expect(c).toContain("form-action 'none'");
    // The inline script stays nonce-gated: no 'unsafe-inline' for scripts.
    expect(c).toMatch(/script-src[^;]*'nonce-[0-9a-f]+'/);
    expect(c.slice(c.indexOf('script-src'), c.indexOf('style-src'))).not.toContain("'unsafe-inline'");
  });

  it('does not open connect-src to the whole world', async () => {
    const c = await csp();
    expect(c).not.toMatch(/connect-src[^;]*\*(?!\.)/);
    expect(c).not.toMatch(/connect-src[^;]*'self'/);
  });
});
