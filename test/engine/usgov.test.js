import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { collect } from '../../src/engine/collect.js';
import { SEVERITY } from '../../src/engine/severity.js';

// The US Government composite row, pinned against the REAL config entry and
// the real recorded payloads — the same pairing production runs.
//
// Coverage honesty: only three federal services publish a public,
// machine-readable status feed (verified 2026-08-14 by probing 40+
// status.<agency>.gov hosts): Login.gov, SSA, and cloud.gov. The general
// government websites (usa.gov, grants.gov, regulations.gov, …) publish no
// status endpoint at all, and under the governing rule an unverifiable status
// can never render as operational — so they are not on the board.

const fixture = (n) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'));
const now = () => new Date('2026-08-14T19:10:00Z');

const config = JSON.parse(readFileSync('config/vendors.json', 'utf8'));
const usgov = config.vendors.find((v) => v.name === 'US Government');

const ROUTES = {
  'status.login.gov': fixture('LoginGov-statuspage'),
  'status.ssa.gov': fixture('SSA-statuspage'),
  'cloudgov.statuspage.io': fixture('CloudGov-statuspage'),
};

const fetchFn = async (url) => {
  const hit = Object.entries(ROUTES).find(([host]) => url.includes(host));
  if (!hit) throw new Error(`unrouted ${url}`);
  return { ok: true, status: 200, text: async () => JSON.stringify(hit[1]) };
};

const run = async () => {
  const res = await collect({ vendors: [usgov] }, { fetchFn, now, retryDelayMs: 0 });
  return res.records[0];
};

describe('US Government composite vendor (real config + recorded payloads)', () => {
  it('is declared in config as a composite of the three verified federal feeds', () => {
    expect(usgov).toBeTruthy();
    expect(usgov.type).toBe('composite');
    expect(usgov.sources.map((s) => s.group)).toEqual(['Login.gov', 'Social Security', 'cloud.gov']);
    expect(usgov.sources.every((s) => s.type === 'statuspage')).toBe(true);
  });

  it('reports operational from the recorded all-clear payloads', async () => {
    const r = await run();
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.description).toBe('All 29 monitored US Government services report healthy.');
  });

  it('groups every component by its source service', async () => {
    const r = await run();
    const names = r.components.map((c) => c.name);
    expect(names).toContain('Login.gov · Single Sign-On & Identity Proofing (secure.login.gov)');
    expect(names).toContain('Social Security · SSA.gov System Health');
    expect(names).toContain('Social Security · my Social Security Webapp Health');
    expect(names).toContain('cloud.gov · Applications');
  });

  it('scopes cloud.gov to its own services, excluding upstream infrastructure', async () => {
    // The Cloudflare D1 principle: services vote, infrastructure does not.
    // cloud.gov's page also lists the AWS GovCloud primitives and GSA email it
    // depends on; an AWS re-route must not paint the US Government row red.
    const r = await run();
    const names = r.components.map((c) => c.name);
    expect(names.filter((n) => n.startsWith('cloud.gov'))).toHaveLength(23);
    expect(names.some((n) => n.includes('AWS'))).toBe(false);
    expect(names.some((n) => n.includes('GSA Corporate Email'))).toBe(false);
  });

  it('a broken federal service breaks the row', async () => {
    // Same worst-wins merge every composite gets; pinned here so a scope edit
    // can never quietly stop SSA from voting.
    const degraded = structuredClone(ROUTES['status.ssa.gov']);
    degraded.components[0].status = 'major_outage';
    const res = await collect({ vendors: [usgov] }, {
      fetchFn: async (url) =>
        url.includes('status.ssa.gov')
          ? { ok: true, status: 200, text: async () => JSON.stringify(degraded) }
          : fetchFn(url),
      now,
      retryDelayMs: 0,
    });
    expect(res.records[0].severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(res.records[0].description).toMatch(/Social Security/);
  });
});
