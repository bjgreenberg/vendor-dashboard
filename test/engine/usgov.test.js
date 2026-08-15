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

// Keyed by exact hostname — matched with URL parsing, never a substring test
// (js/incomplete-url-substring-sanitization; exact matching is also simply the
// truthful routing).
const ROUTES = {
  'status.login.gov': fixture('LoginGov-statuspage'),
  'status.ssa.gov': fixture('SSA-statuspage'),
  'cloudgov.statuspage.io': fixture('CloudGov-statuspage'),
  'valighthouse.statuspage.io': fixture('VAAPIs-statuspage'),
};

const fetchFn = async (url) => {
  const body = ROUTES[new URL(url).hostname];
  if (!body) throw new Error(`unrouted ${url}`);
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

const run = async () => {
  const res = await collect({ vendors: [usgov] }, { fetchFn, now, retryDelayMs: 0 });
  return res.records[0];
};

describe('US Government composite vendor (real config + recorded payloads)', () => {
  it('is declared in config as a composite of the four verified federal feeds', () => {
    expect(usgov).toBeTruthy();
    expect(usgov.type).toBe('composite');
    expect(usgov.sources.map((s) => s.group)).toEqual([
      'Login.gov',
      'Social Security',
      'cloud.gov',
      'VA APIs',
    ]);
    expect(usgov.sources.every((s) => s.type === 'statuspage')).toBe(true);
  });

  it('reports operational from the recorded all-clear payloads', async () => {
    const r = await run();
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.description).toBe('All 53 monitored US Government services report healthy.');
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
    expect(names.filter((n) => n.split(' · ')[0] === 'cloud.gov')).toHaveLength(23);
    expect(names.some((n) => n.includes('AWS'))).toBe(false);
    expect(names.some((n) => n.includes('GSA Corporate Email'))).toBe(false);
  });

  it('displays VA APIs at GROUP level — the leaves are unreadable environment rows', async () => {
    // Every VA leaf is named "Production Environment" or "Sandbox Environment";
    // only the 24 API groups mean anything to a reader (the NetSuite pattern).
    const r = await run();
    const va = r.components.filter((c) => c.name.split(' · ')[0] === 'VA APIs');
    expect(va).toHaveLength(24);
    expect(va.map((c) => c.name)).toContain('VA APIs · Benefits Claims API - v2');
    expect(va.some((c) => c.name.includes('Environment'))).toBe(false);
  });

  it('lets only VA PRODUCTION leaves vote, so a sandbox blip cannot color the row', async () => {
    // Scope + group mode compose (operator decision 2026-08-03): scoped leaves
    // vote, groups display. Sandbox trouble informs the card, never the row.
    const sandboxDown = structuredClone(ROUTES['valighthouse.statuspage.io']);
    for (const c of sandboxDown.components) {
      if (!c.group && c.name === 'Sandbox Environment') c.status = 'major_outage';
    }
    const res = await collect({ vendors: [usgov] }, {
      fetchFn: async (url) =>
        new URL(url).hostname === 'valighthouse.statuspage.io'
          ? { ok: true, status: 200, text: async () => JSON.stringify(sandboxDown) }
          : fetchFn(url),
      now,
      retryDelayMs: 0,
    });
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('a broken VA production API breaks the row', async () => {
    const prodDown = structuredClone(ROUTES['valighthouse.statuspage.io']);
    const prod = prodDown.components.find((c) => !c.group && c.name === 'Production Environment');
    prod.status = 'major_outage';
    const res = await collect({ vendors: [usgov] }, {
      fetchFn: async (url) =>
        new URL(url).hostname === 'valighthouse.statuspage.io'
          ? { ok: true, status: 200, text: async () => JSON.stringify(prodDown) }
          : fetchFn(url),
      now,
      retryDelayMs: 0,
    });
    expect(res.records[0].severity).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('a broken federal service breaks the row', async () => {
    // Same worst-wins merge every composite gets; pinned here so a scope edit
    // can never quietly stop SSA from voting.
    const degraded = structuredClone(ROUTES['status.ssa.gov']);
    degraded.components[0].status = 'major_outage';
    const res = await collect({ vendors: [usgov] }, {
      fetchFn: async (url) =>
        new URL(url).hostname === 'status.ssa.gov'
          ? { ok: true, status: 200, text: async () => JSON.stringify(degraded) }
          : fetchFn(url),
      now,
      retryDelayMs: 0,
    });
    expect(res.records[0].severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(res.records[0].description).toMatch(/Social Security/);
  });
});
