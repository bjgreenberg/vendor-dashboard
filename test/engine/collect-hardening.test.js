// Mutation-hardening tests for src/engine/collect.js — each test pins a
// behavior a surviving Stryker mutant proved was unasserted (2026-08-25 run:
// collect.js scored 44.3% while every sibling file sat above 86%). The
// clusters: transport contract (headers, UTF-16 decode), the per-vendor
// secondary-fetch wiring, composite record fields, and collect()'s tail.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { collect, USER_AGENT } from '../../src/engine/collect.js';
import { SEVERITY } from '../../src/engine/severity.js';

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');
const now = () => new Date('2026-08-25T12:00:00Z');

const GITHUB = fixture('GitHub.json');

/** A recording fetch stub: routes url -> {status, body, contentType, bytes};
 *  every call's url + init is captured for wiring assertions. */
const recordingFetch = (routes) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const hit = routes[url];
    if (hit === undefined) throw new Error(`unexpected url ${url}`);
    if (hit instanceof Error) throw hit;
    return {
      ok: (hit.status ?? 200) < 400,
      status: hit.status ?? 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (hit.contentType ?? null) : null) },
      text: async () => hit.body,
      arrayBuffer: async () => (hit.bytes ?? new TextEncoder().encode(hit.body)).buffer,
    };
  };
  fn.calls = calls;
  return fn;
};

const cfg = (vendors) => ({ vendors });

const utf16 = (s, littleEndian, bom) => {
  const units = [...(bom ? '﻿' : ''), ...s].map((c) => c.charCodeAt(0));
  const buf = new Uint8Array(units.length * 2);
  const view = new DataView(buf.buffer);
  units.forEach((u, i) => view.setUint16(i * 2, u, littleEndian));
  return buf;
};

describe('transport contract', () => {
  it('sends the exact User-Agent and Accept headers on the primary fetch', async () => {
    const fetchFn = recordingFetch({ 'https://gh/api': { body: GITHUB } });
    await collect(cfg([{ name: 'GitHub', type: 'statuspage', url: 'https://gh/api' }]), {
      fetchFn,
      now,
    });
    expect(fetchFn.calls[0].init.headers).toEqual({
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/xml, text/html',
    });
    expect(USER_AGENT).toContain('vendor-dashboard/');
    expect(USER_AGENT).toContain('briangreenberg.net/service-status');
  });

  it('decodes a UTF-16LE (BOM) body declared by content-type', async () => {
    const fetchFn = recordingFetch({
      'https://u16/api': { body: '', bytes: utf16(GITHUB, true, true), contentType: 'application/json; charset=utf-16' },
    });
    const res = await collect(cfg([{ name: 'U16', type: 'statuspage', url: 'https://u16/api' }]), {
      fetchFn,
      now,
    });
    expect(res.records[0].severity).not.toBe(SEVERITY.UNKNOWN);
  });

  it('decodes a UTF-16BE (BOM) body declared by content-type', async () => {
    const fetchFn = recordingFetch({
      'https://u16be/api': { body: '', bytes: utf16(GITHUB, false, true), contentType: 'text/json; charset=UTF-16' },
    });
    const res = await collect(cfg([{ name: 'U16BE', type: 'statuspage', url: 'https://u16be/api' }]), {
      fetchFn,
      now,
    });
    expect(res.records[0].severity).not.toBe(SEVERITY.UNKNOWN);
  });

  it('decodes BOM-less declared UTF-16 as little-endian', async () => {
    const fetchFn = recordingFetch({
      'https://nobom/api': { body: '', bytes: utf16(GITHUB, true, false), contentType: 'application/json; charset=utf-16' },
    });
    const res = await collect(cfg([{ name: 'NoBom', type: 'statuspage', url: 'https://nobom/api' }]), {
      fetchFn,
      now,
    });
    expect(res.records[0].severity).not.toBe(SEVERITY.UNKNOWN);
  });

  it('reads a plain body via text(), not the byte path', async () => {
    const fetchFn = recordingFetch({
      'https://plain/api': { body: GITHUB, bytes: new TextEncoder().encode('NOT JSON'), contentType: 'application/json' },
    });
    // If the byte path were (wrongly) taken, the body would be "NOT JSON" and
    // the row would fail closed to unknown.
    const res = await collect(cfg([{ name: 'Plain', type: 'statuspage', url: 'https://plain/api' }]), {
      fetchFn,
      now,
    });
    expect(res.records[0].severity).not.toBe(SEVERITY.UNKNOWN);
  });
});

// The componentsUrl/statusUrls/clouds side-channels: a mutated type guard or
// dropped header object silently skips the secondary fetch and the row still
// renders — only asserting the CALLS pins the wiring.
describe('secondary-fetch wiring', () => {
  const secondaryHeaders = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

  it('betterstack fetches its sections fragment with the JSON Accept header', async () => {
    const fetchFn = recordingFetch({
      'https://bs/page': { body: fixture('Stormboard-betterstack.html') },
      'https://bs/sections': { body: '<div></div>' },
    });
    await collect(
      cfg([{ name: 'Stormboard', type: 'betterstack', url: 'https://bs/page', componentsUrl: 'https://bs/sections' }]),
      { fetchFn, now },
    );
    const sec = fetchFn.calls.find((c) => c.url === 'https://bs/sections');
    expect(sec).toBeDefined();
    expect(sec.init.headers).toEqual(secondaryHeaders);
  });

  it('google fetches its product catalogue and the row still stands if it fails', async () => {
    const ok = recordingFetch({
      'https://g/incidents': { body: fixture('Google-appsstatus.json') },
      'https://g/products': { body: '[]' },
    });
    await collect(
      cfg([{ name: 'Google', type: 'google', url: 'https://g/incidents', componentsUrl: 'https://g/products' }]),
      { fetchFn: ok, now },
    );
    const sec = ok.calls.find((c) => c.url === 'https://g/products');
    expect(sec).toBeDefined();
    expect(sec.init.headers).toEqual(secondaryHeaders);

    const failing = recordingFetch({
      'https://g/incidents': { body: fixture('Google-appsstatus.json') },
      'https://g/products': new Error('catalogue down'),
    });
    const res = await collect(
      cfg([{ name: 'Google', type: 'google', url: 'https://g/incidents', componentsUrl: 'https://g/products' }]),
      { fetchFn: failing, now },
    );
    expect(res.records[0].severity).not.toBe(SEVERITY.UNKNOWN);
  });

  it('sorryapp accepts both a bare array and a {components} wrapper from its components endpoint', async () => {
    for (const body of ['[]', '{"components": []}']) {
      const fetchFn = recordingFetch({
        'https://sa/api': { body: fixture('Iorad-sorryapp.json') },
        'https://sa/components': { body },
      });
      const res = await collect(
        cfg([{ name: 'Iorad', type: 'sorryapp', url: 'https://sa/api', componentsUrl: 'https://sa/components' }]),
        { fetchFn, now },
      );
      expect(fetchFn.calls.some((c) => c.url === 'https://sa/components')).toBe(true);
      expect(res.records).toHaveLength(1);
    }
  });

  it('concur-status fetches every declared statusUrl', async () => {
    const fetchFn = recordingFetch({
      'https://c/incidents': { body: fixture('Concur-incidents.json') },
      'https://c/s1': { body: '{}' },
      'https://c/s2': { body: '{}' },
    });
    await collect(
      cfg([
        {
          name: 'Concur',
          type: 'concur-status',
          url: 'https://c/incidents',
          statusUrls: ['https://c/s1', 'https://c/s2'],
        },
      ]),
      { fetchFn, now },
    );
    for (const u of ['https://c/s1', 'https://c/s2']) {
      const call = fetchFn.calls.find((c) => c.url === u);
      expect(call, u).toBeDefined();
      expect(call.init.headers).toEqual(secondaryHeaders);
    }
  });

  it('zscaler reuses the primary payload for the cloud matching vendor.url — no duplicate fetch', async () => {
    const fetchFn = recordingFetch({
      'https://z/zdx': { body: fixture('Zscaler-zdx.json') },
      'https://z/zpa': { body: fixture('Zscaler-zpa.json') },
    });
    await collect(
      cfg([
        {
          name: 'Zscaler',
          type: 'zscaler',
          url: 'https://z/zdx',
          clouds: [
            { label: 'ZDX', url: 'https://z/zdx' },
            { label: 'ZPA', url: 'https://z/zpa' },
          ],
        },
      ]),
      { fetchFn, now },
    );
    expect(fetchFn.calls.filter((c) => c.url === 'https://z/zdx')).toHaveLength(1);
    expect(fetchFn.calls.filter((c) => c.url === 'https://z/zpa')).toHaveLength(1);
  });

  it('concur fetches BOTH the components endpoint and the advisory banner', async () => {
    const fetchFn = recordingFetch({
      'https://c/api': { body: fixture('Concur-incidents.json') },
      'https://c/components': { body: '{}' },
      'https://c/banner': { body: fixture('Concur-banner.json') },
    });
    await collect(
      cfg([
        {
          name: 'Concur',
          type: 'concur',
          url: 'https://c/api',
          componentsUrl: 'https://c/components',
          bannerUrl: 'https://c/banner',
        },
      ]),
      { fetchFn, now },
    );
    expect(fetchFn.calls.some((c) => c.url === 'https://c/components')).toBe(true);
    expect(fetchFn.calls.some((c) => c.url === 'https://c/banner')).toBe(true);
  });
});

describe('composite record fields', () => {
  const consumer = (status) =>
    JSON.stringify([{ ServiceDisplayName: 'Outlook.com', Status: status }]);
  const composite = (over = {}) => ({
    name: 'Microsoft',
    type: 'composite',
    pageUrl: 'https://status.example',
    sources: [{ type: 'microsoft-consumer', url: 'https://ms/api', group: 'Consumer' }],
    ...over,
  });

  it("a healthy composite has an EMPTY incidentName and the vendor's own healthy description", async () => {
    const res = await collect(cfg([composite()]), {
      fetchFn: recordingFetch({ 'https://ms/api': { body: consumer('Operational') } }),
      now,
    });
    const r = res.records[0];
    expect(r.incidentName).toBe('');
    expect(r.description).toBe('All 1 monitored Microsoft services report healthy.');
  });

  it("an affected composite is titled 'Service issue' and lists EXACTLY the affected groups", async () => {
    const res = await collect(cfg([composite()]), {
      fetchFn: recordingFetch({ 'https://ms/api': { body: consumer('ServiceDegradation') } }),
      now,
    });
    const r = res.records[0];
    expect(r.incidentName).toBe('Service issue');
    expect(r.description).toBe('Affected: Consumer.');
  });

  it('service falls back to the vendor name and honors an explicit override', async () => {
    const routes = { 'https://ms/api': { body: consumer('Operational') } };
    const fallback = await collect(cfg([composite()]), { fetchFn: recordingFetch(routes), now });
    expect(fallback.records[0].service).toBe('Microsoft');
    const explicit = await collect(cfg([composite({ service: 'M365' })]), {
      fetchFn: recordingFetch(routes),
      now,
    });
    expect(explicit.records[0].service).toBe('M365');
  });

  it('sourceUrl is the pageUrl, and empty (never undefined) without one', async () => {
    const routes = { 'https://ms/api': { body: consumer('Operational') } };
    const withPage = await collect(cfg([composite()]), { fetchFn: recordingFetch(routes), now });
    expect(withPage.records[0].sourceUrl).toBe('https://status.example');
    const noPage = await collect(cfg([composite({ pageUrl: undefined })]), {
      fetchFn: recordingFetch(routes),
      now,
    });
    expect(noPage.records[0].sourceUrl).toBe('');
  });

  it('a no-sources composite reports the exact refusal reason', async () => {
    const res = await collect(cfg([composite({ sources: [] })]), {
      fetchFn: recordingFetch({}),
      now,
    });
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
    expect(res.records[0].warnings).toContain('composite vendor declared no sources');
  });
});

describe('collect tail', () => {
  it('a null vendor entry yields an UNKNOWN row and leaves the rest of the board alive', async () => {
    // Every vendor read is optional-chained, so even a null entry degrades to
    // one unknown row instead of crashing the run.
    const res = await collect(cfg([null, { name: 'GitHub', type: 'statuspage', url: 'https://gh/api' }]), {
      fetchFn: recordingFetch({ 'https://gh/api': { body: GITHUB } }),
      now,
    });
    expect(res.records).toHaveLength(2);
    const nulled = res.records.find((r) => r.vendor === 'unknown');
    expect(nulled.severity).toBe(SEVERITY.UNKNOWN);
    expect(String(nulled.warnings)).toContain('no adapter registered');
    expect(res.records.find((r) => r.vendor === 'GitHub').severity).not.toBe(SEVERITY.UNKNOWN);
  });

  it('attention counts neither operational NOR unknown rows', async () => {
    const res = await collect(cfg([{ name: 'Broken', type: 'statuspage', url: 'https://b/api' }]), {
      fetchFn: recordingFetch({ 'https://b/api': { body: 'not json' } }),
      now,
    });
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
    expect(res.impacted).toBe(0);
  });

  it('run-level warnings carry the vendor prefix', async () => {
    // A composite source with an unregistered type deterministically warns;
    // the run hoists it as "<vendor>: <group>: <reason>".
    const res = await collect(
      cfg([
        {
          name: 'Odd',
          type: 'composite',
          sources: [{ type: 'no-such-adapter', url: 'https://o/api', group: 'Core' }],
        },
      ]),
      { fetchFn: recordingFetch({}), now },
    );
    expect(res.warnings.length).toBeGreaterThan(0);
    for (const w of res.warnings) expect(w).toMatch(/^Odd: /);
    expect(res.warnings[0]).toContain('Core:');
  });

  it('refuses a config without a vendors array, naming the contract', async () => {
    await expect(collect({}, { fetchFn: recordingFetch({}), now })).rejects.toThrow(
      'collect: config.vendors must be an array',
    );
  });

  it('refuses a missing fetchFn rather than reaching for global fetch', async () => {
    await expect(collect(cfg([{ name: 'X' }]), { now })).rejects.toThrow(/fetchFn/);
  });
});
