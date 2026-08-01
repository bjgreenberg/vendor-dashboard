import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAzureFeed, parseAzureDevOps } from '../../../src/engine/adapters/azure.js';
import { SEVERITY } from '../../../src/engine/severity.js';

// Added after Microsoft retired the endpoint behind the original "Microsoft"
// row. Fixtures recorded live 2026-08-01.

const AT = new Date('2026-08-01T00:25:00Z');
const now = () => AT;

const azureLive = readFileSync('test/fixtures/Azure-feed.xml', 'utf8');
const adoLive = JSON.parse(readFileSync('test/fixtures/AzureDevOps-health.json', 'utf8'));

const azure = (xml) => parseAzureFeed(xml, { vendor: 'Microsoft Azure', now });
const ado = (payload) => parseAzureDevOps(payload, { vendor: 'Azure DevOps', now });

/** Feed with a controllable build time and item list. */
const feed = (builtIso, items = '') =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>` +
  `<title>Azure Status</title><lastBuildDate>${builtIso}</lastBuildDate>${items}</channel></rss>`;

describe('azure incident feed', () => {
  it('reads the recorded live payload as operational', () => {
    // Recorded while Azure had no active incidents. The clock is PINNED to
    // just after the fixture's lastBuildDate: using real wall-clock time made
    // this test start failing an hour after the fixture was recorded, because
    // the freshness guard correctly rejected a stale feed (testing.md §7 --
    // a test that passes or fails depending on when it runs is not a test).
    const r = parseAzureFeed(azureLive, {
      vendor: 'Microsoft Azure',
      now: () => new Date(Date.parse(/<lastBuildDate>([^<]+)</.exec(azureLive)[1]) + 60_000),
    });
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.service).toBe('Microsoft Azure');
  });

  // --- THE LOAD-BEARING GUARD -------------------------------------------
  // Healthy state is an EMPTY feed, which is absence of evidence -- exactly
  // audit finding H6. An abandoned feed is also empty and would read as
  // perfect health forever. What makes empty trustworthy is that
  // lastBuildDate is regenerated every minute (verified live), so the feed
  // proves its own liveness. These tests pin that reasoning.

  it('treats an empty but FRESHLY BUILT feed as healthy', () => {
    expect(azure(feed('Sat, 01 Aug 2026 00:24:00 Z')).severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('refuses to read an empty STALE feed as healthy', () => {
    // 25 minutes old: inside the 30-minute window, still trusted.
    expect(azure(feed('Sat, 01 Aug 2026 00:00:00 Z')).severity).toBe(SEVERITY.OPERATIONAL);

    // 4.5 hours old: the feed has stopped proving it is alive, so its
    // emptiness means nothing and must not be reported as health.
    const stale = azure(feed('Fri, 31 Jul 2026 20:00:00 Z'));
    expect(stale.severity).toBe(SEVERITY.UNKNOWN);
    expect(stale.warnings.join(' ') + stale.description).toMatch(/not been rebuilt/i);
  });

  it('fails closed when lastBuildDate is missing or unparseable', () => {
    expect(azure('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>').severity).toBe(
      SEVERITY.UNKNOWN,
    );
    expect(azure(feed('not a date')).severity).toBe(SEVERITY.UNKNOWN);
  });

  it('fails closed on a non-RSS body', () => {
    for (const bad of ['<html>nope</html>', '{"json":true}', '', null, undefined]) {
      expect(azure(bad).severity).toBe(SEVERITY.UNKNOWN);
    }
  });

  it('reports active incidents, classified by their titles', () => {
    const items =
      '<item><title>Azure Storage - West Europe - Service Unavailable</title></item>' +
      '<item><title>Elevated latency in East US</title></item>';
    const r = azure(feed('Sat, 01 Aug 2026 00:24:00 Z', items));
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE); // worst of the two
    expect(r.components).toHaveLength(2);
    expect(r.description).toMatch(/2 active issues/);
  });

  it('never classifies an unrecognised incident title as healthy', () => {
    // An item EXISTS, so something is being reported. Failing through to
    // operational because the wording is unfamiliar would be a false green.
    const r = azure(feed('Sat, 01 Aug 2026 00:24:00 Z', '<item><title>Something unusual</title></item>'));
    expect(r.severity).not.toBe(SEVERITY.OPERATIONAL);
  });
});

describe('azure devops health api', () => {
  it('reads the recorded live payload as operational with every service listed', () => {
    const r = ado(adoLive);
    expect(r.severity).toBe(SEVERITY.OPERATIONAL);
    expect(r.components.length).toBeGreaterThanOrEqual(6);
    expect(r.components.map((c) => c.name)).toContain('Pipelines');
  });

  it('collapses 8 geographies per service into one component', () => {
    // 7 services x 8 regions would be 56 near-identical rows -- the same
    // PoP-versus-service problem solved for Zoom, Docusign and Tableau.
    const r = ado(adoLive);
    expect(r.components.length).toBeLessThan(10);
    for (const c of r.components) expect(c.name).not.toMatch(/United States|Europe|Asia/);
  });

  it('surfaces the worst geography and names the affected regions', () => {
    const payload = {
      services: [
        {
          id: 'Pipelines',
          geographies: [
            { id: 'US', name: 'United States', health: 'healthy' },
            { id: 'EU', name: 'Europe', health: 'unhealthy' },
          ],
        },
      ],
    };
    const r = ado(payload);
    expect(r.severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(r.components[0].description).toMatch(/Europe/);
  });

  it('maps the health vocabulary, including advisory', () => {
    const one = (health) => ado({ services: [{ id: 'S', geographies: [{ id: 'US', health }] }] }).severity;
    expect(one('healthy')).toBe(SEVERITY.OPERATIONAL);
    expect(one('advisory')).toBe(SEVERITY.DEGRADED);
    expect(one('degraded')).toBe(SEVERITY.DEGRADED);
    expect(one('unhealthy')).toBe(SEVERITY.MAJOR_OUTAGE);
  });

  it('fails closed on unknown vocabulary and malformed payloads', () => {
    expect(ado({ services: [{ id: 'S', geographies: [{ id: 'US', health: 'sparkly' }] }] }).severity).toBe(
      SEVERITY.UNKNOWN,
    );
    for (const bad of [null, undefined, {}, { services: [] }, { services: 'nope' }]) {
      expect(ado(bad).severity).toBe(SEVERITY.UNKNOWN);
    }
  });

  it('treats a service with no geographies as unknown, not healthy', () => {
    expect(ado({ services: [{ id: 'S' }] }).severity).toBe(SEVERITY.UNKNOWN);
  });
});
