import { describe, it, expect } from 'vitest';
import worker from '../../src/worker/index.js';
import { makeD1 } from '../helpers/d1.js';

// site-auditor finding (2026-08-04): every path on briangreenberg.net served
// HSTS except /service-status — this Worker's responses never set it. A route
// that intercepts a sub-path must uphold the zone's transport posture itself.
const HSTS = 'max-age=31536000; includeSubDomains';

const env = () => ({ DB: makeD1(), BASE_PATH: '/service-status' });

describe('Strict-Transport-Security on every Worker response', () => {
  it('the dashboard HTML carries HSTS', async () => {
    const res = await worker.fetch(new Request('https://x/service-status/'), env());
    expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS);
  });

  it('the JSON API carries HSTS', async () => {
    const res = await worker.fetch(new Request('https://x/service-status/api/status'), env());
    expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS);
  });

  it('the health probe carries HSTS', async () => {
    const res = await worker.fetch(new Request('https://x/service-status/health'), env());
    expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS);
  });

  it('even the 404 fallthrough carries HSTS', async () => {
    const res = await worker.fetch(new Request('https://x/service-status/nope'), env());
    expect(res.status).toBe(404);
    expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS);
  });
});
