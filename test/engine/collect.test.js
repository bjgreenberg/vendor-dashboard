import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { collect } from '../../src/engine/collect.js';
import { SEVERITY } from '../../src/engine/severity.js';

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');
const now = () => new Date('2026-07-30T12:00:00Z');

/** A fetchFn stub: maps url -> {status, body} or throws. */
const stubFetch = (routes) => async (url) => {
  const hit = routes[url];
  if (hit === undefined) throw new Error(`unexpected url ${url}`);
  if (hit instanceof Error) throw hit;
  return {
    ok: hit.status === undefined || hit.status < 400,
    status: hit.status ?? 200,
    text: async () => hit.body,
  };
};

const GITHUB = fixture('GitHub.json');

const cfg = (vendors) => ({ vendors });

describe('collect — happy path', () => {
  it('returns one record per configured vendor', async () => {
    const config = cfg([
      { name: 'GitHub', type: 'statuspage', url: 'https://gh/api' },
      { name: 'Other', type: 'statuspage', url: 'https://ot/api' },
    ]);
    const res = await collect(config, {
      fetchFn: stubFetch({ 'https://gh/api': { body: GITHUB }, 'https://ot/api': { body: GITHUB } }),
      now,
    });
    expect(res.records).toHaveLength(2);
    expect(res.records.map((r) => r.vendor).sort()).toEqual(['GitHub', 'Other']);
  });

  it('sorts records most severe first, then alphabetically', async () => {
    const down = JSON.stringify({
      page: { url: 'https://d' },
      status: { indicator: 'critical', description: 'Major Outage' },
      components: [],
      incidents: [],
    });
    const config = cfg([
      { name: 'Zulu', type: 'statuspage', url: 'https://z' },
      { name: 'Alpha', type: 'statuspage', url: 'https://a' },
      { name: 'Broken', type: 'statuspage', url: 'https://b' },
    ]);
    const res = await collect(config, {
      fetchFn: stubFetch({
        'https://z': { body: GITHUB },
        'https://a': { body: GITHUB },
        'https://b': { body: down },
      }),
      now,
    });
    expect(res.records.map((r) => r.vendor)).toEqual(['Broken', 'Alpha', 'Zulu']);
  });
});

// Audit finding H4 + the isolation property the predecessor got right:
// one vendor's failure must degrade one row, never the run.
describe('collect — failure isolation (H4)', () => {
  it('a thrown fetch yields an UNKNOWN row, not a lost row and not a green one', async () => {
    const config = cfg([
      { name: 'Good', type: 'statuspage', url: 'https://good' },
      { name: 'Broken', type: 'statuspage', url: 'https://broken' },
    ]);
    const res = await collect(config, {
      fetchFn: stubFetch({ 'https://good': { body: GITHUB }, 'https://broken': new Error('ECONNRESET') }),
      now,
      retryDelayMs: 0,
    });
    expect(res.records).toHaveLength(2);
    const broken = res.records.find((r) => r.vendor === 'Broken');
    expect(broken.severity).toBe(SEVERITY.UNKNOWN);
    expect(broken.severity).not.toBe(SEVERITY.OPERATIONAL);
    expect(res.records.find((r) => r.vendor === 'Good').severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('a non-200 response yields UNKNOWN rather than being parsed', async () => {
    const config = cfg([{ name: 'V', type: 'statuspage', url: 'https://v' }]);
    const res = await collect(config, {
      fetchFn: stubFetch({ 'https://v': { status: 503, body: 'gateway error' } }),
      now,
      retryDelayMs: 0,
    });
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
    expect(res.records[0].warnings.join(' ')).toMatch(/503/);
  });

  it('unparseable JSON yields UNKNOWN, never OPERATIONAL', async () => {
    const config = cfg([{ name: 'V', type: 'statuspage', url: 'https://v' }]);
    const res = await collect(config, {
      fetchFn: stubFetch({ 'https://v': { body: '<html>not json</html>' } }),
      now,
    });
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
  });

  it('an unknown adapter type is reported, not silently skipped', async () => {
    const config = cfg([{ name: 'V', type: 'not-a-real-adapter', url: 'https://v' }]);
    const res = await collect(config, { fetchFn: stubFetch({ 'https://v': { body: '{}' } }), now });
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
    expect(res.records[0].warnings.join(' ')).toMatch(/adapter/i);
  });
});

describe('collect — fails closed on bad configuration', () => {
  it('throws on an empty vendor list rather than reporting an all-clear board', async () => {
    // A run that monitors nothing must never render as "everything is fine".
    await expect(collect(cfg([]), { fetchFn: stubFetch({}), now })).rejects.toThrow(/no vendors/i);
  });

  it('throws when config is missing entirely', async () => {
    await expect(collect(null, { fetchFn: stubFetch({}), now })).rejects.toThrow();
  });
});

describe('collect — concurrency and timeouts (M5)', () => {
  it('fetches vendors in parallel, not serially', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowFetch = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true, status: 200, text: async () => GITHUB };
    };
    const config = cfg(
      Array.from({ length: 6 }, (_, i) => ({ name: `V${i}`, type: 'statuspage', url: `https://v${i}` })),
    );
    await collect(config, { fetchFn: slowFetch, now });
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('passes an abort signal so a hung vendor cannot stall the run', async () => {
    const seen = [];
    const fetchFn = async (url, init) => {
      seen.push(init?.signal);
      return { ok: true, status: 200, text: async () => GITHUB };
    };
    await collect(cfg([{ name: 'V', type: 'statuspage', url: 'https://v' }]), {
      fetchFn,
      now,
      timeoutMs: 1234,
    });
    expect(seen[0]).toBeDefined();
  });
});

describe('collect — run metadata', () => {
  it('reports counts the operator can alert on', async () => {
    const config = cfg([
      { name: 'Good', type: 'statuspage', url: 'https://good' },
      { name: 'Broken', type: 'statuspage', url: 'https://broken' },
    ]);
    const res = await collect(config, {
      fetchFn: stubFetch({ 'https://good': { body: GITHUB }, 'https://broken': new Error('boom') }),
      now,
      retryDelayMs: 0,
    });
    expect(res.checkedAt).toBe('2026-07-30T12:00:00.000Z');
    expect(res.total).toBe(2);
    expect(res.unknown).toBe(1);
    expect(res.impacted).toBe(0);
  });

  it('applies per-vendor scope from config', async () => {
    const cloudflare = fixture('Cloudflare.json');
    const config = cfg([
      {
        name: 'Cloudflare',
        type: 'statuspage',
        url: 'https://cf',
        scope: { groups: ['Cloudflare Sites and Services'] },
      },
    ]);
    const res = await collect(config, { fetchFn: stubFetch({ 'https://cf': { body: cloudflare } }), now });
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
  });
});

// Live finding, 2026-07-31: Microsoft's status endpoint is ~50% flaky. The same
// URL returned 200 then 404 then 404 seconds apart, and admin.microsoft.com
// (same backend) alternated 404/200/404/200. Without a retry, a healthy vendor
// renders UNKNOWN roughly half the time - technically fail-closed, but noise
// that trains you to ignore the board.
//
// Retries are bounded by a SHARED budget, not just per-vendor, because the
// free-plan subrequest ceiling is 50 per invocation and 34 vendors each
// retrying twice would be 102.
describe('collect — bounded retry for transient failures', () => {
  const GH = readFileSync(new URL('../fixtures/GitHub.json', import.meta.url), 'utf8');

  it('retries a transient 404 and succeeds on the second attempt', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => GH };
    };
    const res = await collect(cfg([{ name: 'Flaky', type: 'statuspage', url: 'https://f' }]), {
      fetchFn,
      now,
      retryDelayMs: 0,
    });
    expect(calls).toBe(2);
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('retries a network error', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return { ok: true, status: 200, text: async () => GH };
    };
    const res = await collect(cfg([{ name: 'Flaky', type: 'statuspage', url: 'https://f' }]), {
      fetchFn,
      now,
      retryDelayMs: 0,
    });
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('gives up after the attempt cap and reports UNKNOWN, never OPERATIONAL', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: false, status: 404, text: async () => '' };
    };
    const res = await collect(cfg([{ name: 'Dead', type: 'statuspage', url: 'https://d' }]), {
      fetchFn,
      now,
      retryDelayMs: 0,
    });
    expect(calls).toBeLessThanOrEqual(3);
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
  });

  it('does NOT retry a 200 that simply fails to parse — that is not transient', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => '<html>not json</html>' };
    };
    const res = await collect(cfg([{ name: 'V', type: 'statuspage', url: 'https://v' }]), {
      fetchFn,
      now,
      retryDelayMs: 0,
    });
    expect(calls).toBe(1);
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
  });

  it('caps TOTAL retries across the run so the subrequest ceiling cannot be blown', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: false, status: 503, text: async () => '' };
    };
    const vendors = Array.from({ length: 20 }, (_, i) => ({
      name: `V${i}`,
      type: 'statuspage',
      url: `https://v${i}`,
    }));
    const res = await collect(cfg(vendors), { fetchFn, now, retryDelayMs: 0, retryBudget: 5 });
    // 20 first attempts + at most 5 retries.
    expect(calls).toBeLessThanOrEqual(25);
    expect(res.records).toHaveLength(20);
    expect(res.unknown).toBe(20);
  });
});

// Instatus splits page state and components across two endpoints, so a vendor
// on that platform needs an optional secondary fetch to expose its component
// list — mirroring Concur's optional banner.
describe('collect — optional secondary fetches', () => {
  it('merges an instatus components endpoint into the payload', async () => {
    const res = await collect(
      cfg([{ name: 'P', type: 'instatus', url: 'https://p/summary', componentsUrl: 'https://p/components' }]),
      {
        fetchFn: stubFetch({
          'https://p/summary': { body: JSON.stringify({ page: { status: 'UP', url: 'https://p' } }) },
          'https://p/components': {
            body: JSON.stringify({ components: [{ name: 'API', status: 'OPERATIONAL', isParent: false }] }),
          },
        }),
        now,
        retryDelayMs: 0,
      },
    );
    expect(res.records[0].components.map((c) => c.name)).toEqual(['API']);
  });

  it('still reports page status when the components fetch fails', async () => {
    const res = await collect(
      cfg([{ name: 'P', type: 'instatus', url: 'https://p/summary', componentsUrl: 'https://p/components' }]),
      {
        fetchFn: stubFetch({
          'https://p/summary': { body: JSON.stringify({ page: { status: 'UP', url: 'https://p' } }) },
          'https://p/components': new Error('boom'),
        }),
        now,
        retryDelayMs: 0,
      },
    );
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
  });
});

// Microsoft publishes the same payload at two addresses whose failures are only
// partly correlated: measured over six rounds each failed ~half the time, but
// both failed together only twice.
describe('collect — fallback URLs', () => {
  const GH = readFileSync(new URL('../fixtures/GitHub.json', import.meta.url), 'utf8');

  it('falls back to the second URL when the first exhausts its retries', async () => {
    const seen = [];
    const fetchFn = async (url) => {
      seen.push(url);
      if (url === 'https://primary') return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => GH };
    };
    const res = await collect(
      cfg([{ name: 'V', type: 'statuspage', url: 'https://primary', fallbackUrls: ['https://backup'] }]),
      { fetchFn, now, retryDelayMs: 0 },
    );
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
    expect(seen).toContain('https://backup');
  });

  it('does not touch the fallback when the primary succeeds', async () => {
    const seen = [];
    const fetchFn = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => GH }; };
    await collect(
      cfg([{ name: 'V', type: 'statuspage', url: 'https://primary', fallbackUrls: ['https://backup'] }]),
      { fetchFn, now, retryDelayMs: 0 },
    );
    expect(seen).toEqual(['https://primary']);
  });

  it('still yields UNKNOWN when every URL fails', async () => {
    const fetchFn = async () => ({ ok: false, status: 404, text: async () => '' });
    const res = await collect(
      cfg([{ name: 'V', type: 'statuspage', url: 'https://a', fallbackUrls: ['https://b'] }]),
      { fetchFn, now, retryDelayMs: 0 },
    );
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
  });
});
