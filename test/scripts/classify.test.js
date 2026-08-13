import { describe, it, expect } from 'vitest';
import { classify } from '../../scripts/watchdog/classify.mjs';

// The classifier is the pure half of the watchdog's diagnosis: probe results
// in, classification + fix playbook out. Zero network — the probes live in
// diagnose-endpoint.mjs and stay thin.
const base = {
  host: 'status.example.com',
  dns: { ok: true, chain: ['status.example.com', 'pages.example-status-host.com'] },
  tls: { ok: true, matchesHost: true, subject: 'status.example.com' },
  http: { ok: true, status: 200, redirects: [], finalHost: 'status.example.com', bodyIsJson: true },
};

describe('classify — precedence ladder', () => {
  it('DNS failure outranks everything', () => {
    const r = classify({ ...base, dns: { ok: false, chain: [], error: 'ENOTFOUND' } });
    expect(r.classification).toBe('dns-failure');
  });

  it('the SendGrid signature: wrong cert plus off-host redirect reads as the cert mismatch', () => {
    // Live capture 2026-08-12: stale CNAME to stspg-customer.com serving a
    // *.statuspage.io certificate, then a 302 off to statuspage.io.
    const r = classify({
      ...base,
      host: 'status.sendgrid.com',
      dns: { ok: true, chain: ['status.sendgrid.com', '3tgl2vf85cht.stspg-customer.com'] },
      tls: { ok: true, matchesHost: false, subject: '*.statuspage.io' },
      http: {
        ok: true,
        status: 302,
        redirects: [{ status: 302, location: 'https://www.statuspage.io' }],
        finalHost: 'www.statuspage.io',
        bodyIsJson: false,
      },
    });
    expect(r.classification).toBe('tls-cert-mismatch');
    expect(r.suggestedFix).toMatch(/decommission|moved|new status page/i);
  });

  it('an off-host redirect that still serves the JSON feed is a MOVE, not rot', () => {
    // Found by the first live smoke test: status.anthropic.com 302s to
    // status.claude.com (rebrand), which answers 200 with valid JSON. The
    // board keeps working through the redirect — the fix is a leisurely
    // config repoint, not an outage diagnosis.
    const r = classify({
      ...base,
      http: {
        ok: true,
        status: 200,
        redirects: [{ status: 302, location: 'https://status.newbrand.com/api/v2/summary.json' }],
        finalHost: 'status.newbrand.com',
        bodyIsJson: true,
      },
    });
    expect(r.classification).toBe('moved-but-redirecting');
    expect(r.suggestedFix).toMatch(/update.*config|repoint/i);
  });

  it('an off-host redirect with a VALID cert is a decommissioned page', () => {
    const r = classify({
      ...base,
      http: {
        ok: true,
        status: 302,
        redirects: [{ status: 302, location: 'https://www.statuspage.io' }],
        finalHost: 'www.statuspage.io',
        bodyIsJson: false,
      },
    });
    expect(r.classification).toBe('decommissioned');
  });

  it('a same-host redirect is not decommissioning', () => {
    const r = classify({
      ...base,
      http: { ...base.http, redirects: [{ status: 301, location: '/api/v2/summary.json/' }] },
    });
    expect(r.classification).toBe('endpoint-ok-likely-adapter-drift');
  });

  it('4xx and 5xx classify separately — a 401 needs a different fix than a 503', () => {
    expect(
      classify({ ...base, http: { ...base.http, status: 404, bodyIsJson: false } }).classification,
    ).toBe('http-client-error');
    expect(
      classify({ ...base, http: { ...base.http, status: 503, bodyIsJson: false } }).classification,
    ).toBe('http-server-error');
  });

  it('200 but not JSON is a payload reshape', () => {
    const r = classify({ ...base, http: { ...base.http, bodyIsJson: false } });
    expect(r.classification).toBe('body-not-json');
  });

  it('a healthy endpoint means the ADAPTER drifted, and the playbook says so', () => {
    const r = classify(base);
    expect(r.classification).toBe('endpoint-ok-likely-adapter-drift');
    expect(r.suggestedFix).toMatch(/adapter|scope|vocabulary/i);
  });

  it('an unreachable-but-resolving endpoint reads as a server-side failure', () => {
    const r = classify({ ...base, http: { ok: false, redirects: [], error: 'ETIMEDOUT' } });
    expect(r.classification).toBe('http-server-error');
  });

  it('never throws on a partial probe, and fails closed to dns-failure', () => {
    expect(() => classify({ host: 'x' })).not.toThrow();
    expect(classify({ host: 'x' }).classification).toBe('dns-failure');
    expect(() => classify(null)).not.toThrow();
  });

  it('every classification carries a non-empty fix playbook', () => {
    const probes = [
      { ...base, dns: { ok: false, chain: [] } },
      { ...base, tls: { ok: true, matchesHost: false } },
      { ...base, http: { ...base.http, finalHost: 'elsewhere.io' } },
      { ...base, http: { ...base.http, status: 404 } },
      { ...base, http: { ...base.http, status: 500 } },
      { ...base, http: { ...base.http, bodyIsJson: false } },
      base,
    ];
    for (const p of probes) {
      const r = classify(p);
      expect(r.suggestedFix, r.classification).toBeTruthy();
      expect(r.headline).toContain(r.classification);
    }
  });
});
