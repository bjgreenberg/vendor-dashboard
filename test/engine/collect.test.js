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

  it('retries a transient 500 and succeeds on the second attempt', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, text: async () => '' };
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

  it('does NOT retry a 404 — a retired route cannot be waited out', async () => {
    // This test previously asserted the OPPOSITE. 404 was made retryable
    // because Microsoft's endpoint measured ~50% availability on 2026-07-31,
    // which looked like flapping. It was a progressive decommission: by
    // 2026-08-01 it answered 404 every time, and so did its configured
    // fallback. Retrying spent up to 3 subrequests per vendor from a budget
    // capped at 50 to reach the same `unknown` -- and on the free plan that
    // spend is precisely what starved other vendors.
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return { ok: false, status: 404, text: async () => '' };
    };
    const res = await collect(cfg([{ name: 'Gone', type: 'statuspage', url: 'https://g' }]), {
      fetchFn,
      now,
      retryDelayMs: 0,
    });
    expect(calls).toBe(1); // one attempt, no retries
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN); // still fails closed
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
  it('deadlines the secondary fetch too — a hung components endpoint cannot stall the shard', async () => {
    // Audit finding M3: the advisory calls (instatus/google/sorryapp
    // components, Concur banner + catalogue, concur-status per-DC docs,
    // BetterStack sections) passed no AbortSignal, so one hung endpoint held
    // the whole invocation open until the runtime killed it — nothing written,
    // no alert, the same silent-stall class as the 2026-08-01 CPU outage. The
    // deadline is enforced inside meteredFetch, so no call site (present or
    // future) can escape it — the same wrap-the-injected-function shape that
    // made the subrequest budget inescapable.
    const advisorySignals = [];
    const fetchFn = (url, init) => {
      if (url === 'https://p/summary') {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ page: { status: 'UP', url: 'https://p' } }),
        });
      }
      advisorySignals.push(init?.signal);
      // Never settles on its own; rejects only when the caller's deadline fires.
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by deadline')));
      });
    };

    const outcome = await Promise.race([
      collect(
        cfg([{ name: 'P', type: 'instatus', url: 'https://p/summary', componentsUrl: 'https://p/components' }]),
        { fetchFn, now, retryDelayMs: 0, timeoutMs: 25 },
      ),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1500)),
    ]);

    expect(outcome, 'collect() never returned — the advisory fetch has no deadline').not.toBe('HUNG');
    expect(advisorySignals[0], 'advisory fetch received no AbortSignal').toBeDefined();
    // The page-level verdict still stands; the lost component list is advisory.
    expect(outcome.records[0].severity).toBe('operational');
  });

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

  // Docusign (health.docusign.com) splits the product tree from the incident
  // list; an active incident must reach the parser through the second fetch.
  it('feeds the docusign incidents endpoint to the parser so an active incident votes', async () => {
    const incidents = JSON.parse(fixture('Docusign-incidents.json'));
    incidents.incidents[0].status = 'investigating';
    const res = await collect(
      cfg([{ name: 'Docusign', type: 'docusign', url: 'https://ds/components', incidentsUrl: 'https://ds/incidents' }]),
      {
        fetchFn: stubFetch({
          'https://ds/components': { body: fixture('Docusign-components.json') },
          'https://ds/incidents': { body: JSON.stringify(incidents) },
        }),
        now,
        retryDelayMs: 0,
      },
    );
    expect(res.records[0].severity).toBe(SEVERITY.DEGRADED);
    expect(res.records[0].incidentName).toMatch(/Incident 5692/);
    expect(res.records[0].warnings).toEqual([]);
  });

  it('still judges docusign on its components when the incidents fetch fails, with a warning', async () => {
    const res = await collect(
      cfg([{ name: 'Docusign', type: 'docusign', url: 'https://ds/components', incidentsUrl: 'https://ds/incidents' }]),
      {
        fetchFn: stubFetch({
          'https://ds/components': { body: fixture('Docusign-components.json') },
          'https://ds/incidents': new Error('boom'),
        }),
        now,
        retryDelayMs: 0,
      },
    );
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
    expect(res.records[0].warnings.join(' ')).toMatch(/incidents\.json unavailable/);
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

// The last try at a URL waits longer than the others.
//
// Found 2026-10-01 (worklist #129): Atlassian Statuspage's hosting sometimes
// accepts a request and then sends nothing. One measured stall: 0 bytes for
// 15 s, then 0.07 s on the next request. In production all three 10 s tries
// aborted and the vendor read `unknown` for a 15-minute cycle; 250 of 283
// unknown checks in 14 days were Statuspage vendors.
describe('collect — the last try is patient', () => {
  const GH = readFileSync(new URL('../fixtures/GitHub.json', import.meta.url), 'utf8');
  const ok = () => ({ ok: true, status: 200, text: async () => GH });

  /** Answers after `ms`, unless the caller's deadline aborts it first. */
  const slowFetch = (ms, log = []) => (url, init) =>
    new Promise((resolve, reject) => {
      log.push(url);
      const timer = setTimeout(() => resolve(ok()), ms);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal.reason ?? new Error('The operation was aborted due to timeout'));
      });
    });

  it('a feed slower than the normal deadline is read on the last try, not left unknown', async () => {
    // The regression: the feed needs 60 ms and the deadline is 20 ms, so tries
    // one and two abort. The third waits long enough.
    const calls = [];
    const res = await collect(cfg([{ name: 'Slow', type: 'statuspage', url: 'https://slow' }]), {
      fetchFn: slowFetch(60, calls),
      now,
      timeoutMs: 20,
      lastAttemptTimeoutMs: 500,
      retryDelayMs: 0,
    });
    expect(calls).toHaveLength(3); // no extra request: the third try is the patient one
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
    expect(res.unknown).toBe(0);
    expect(res.retriedOk).toBe(1);
  });

  it('only the last try is patient: the first two keep the normal deadline', async () => {
    // With no retry budget there is one try, and it must still abort at 20 ms
    // rather than wait the patient 500.
    const calls = [];
    const res = await collect(cfg([{ name: 'Slow', type: 'statuspage', url: 'https://slow' }]), {
      fetchFn: slowFetch(60, calls),
      now,
      timeoutMs: 20,
      lastAttemptTimeoutMs: 500,
      retryDelayMs: 0,
      retryBudget: 0,
    });
    expect(calls).toHaveLength(1);
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
    expect(res.retriedOk).toBe(0);
  });

  it('the last try is never LESS patient than the others', async () => {
    // A caller with a long normal deadline must not get a shorter last try.
    let calls = 0;
    const slow = slowFetch(60);
    const fetchFn = (url, init) => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error('ECONNRESET'));
      return slow(url, init);
    };
    const res = await collect(cfg([{ name: 'Slow', type: 'statuspage', url: 'https://slow' }]), {
      fetchFn,
      now,
      timeoutMs: 200,
      lastAttemptTimeoutMs: 20,
      retryDelayMs: 0,
    });
    expect(res.records[0].severity).toBe(SEVERITY.OPERATIONAL);
  });

  it('a feed that outlasts even the last try is UNKNOWN, never OPERATIONAL', async () => {
    const calls = [];
    const res = await collect(cfg([{ name: 'Stuck', type: 'statuspage', url: 'https://stuck' }]), {
      fetchFn: slowFetch(200, calls),
      now,
      timeoutMs: 10,
      lastAttemptTimeoutMs: 40,
      retryDelayMs: 0,
    });
    expect(calls).toHaveLength(3);
    expect(res.records[0].severity).toBe(SEVERITY.UNKNOWN);
    expect(res.records[0].warnings[0]).toMatch(/^fetch failed/);
    expect(res.retriedOk).toBe(0);
  });

  it('the production deadlines are 10 s, 10 s, 25 s when the caller overrides nothing', async () => {
    // Every other test here sets its own deadlines. This one pins the numbers
    // the Worker actually runs with, so a changed default cannot pass unseen.
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      await collect(cfg([{ name: 'Down', type: 'statuspage', url: 'https://down' }]), {
        fetchFn: async () => {
          throw new Error('ECONNRESET');
        },
        now,
        retryDelayMs: 0,
      });
      expect(spy.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000, 25_000]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a caller that tightens timeoutMs tightens the last try with it (2.5x)', async () => {
    // timeoutMs must stay the one knob that bounds a fetch: 20 ms means a
    // 50 ms last try, so a 40 ms feed is read and a 120 ms feed is not.
    const read = await collect(cfg([{ name: 'S', type: 'statuspage', url: 'https://s' }]), {
      fetchFn: slowFetch(40),
      now,
      timeoutMs: 20,
      retryDelayMs: 0,
    });
    expect(read.records[0].severity).toBe(SEVERITY.OPERATIONAL);
    const notRead = await collect(cfg([{ name: 'S', type: 'statuspage', url: 'https://s' }]), {
      fetchFn: slowFetch(120),
      now,
      timeoutMs: 20,
      retryDelayMs: 0,
    });
    expect(notRead.records[0].severity).toBe(SEVERITY.UNKNOWN);
  });

  it('a whole shard stalling together still reaches the patient try: eight feeds, default budgets', async () => {
    // The largest shards hold seven and eight feeds. With the old retry
    // budget of 10, the second tries used it up and most feeds never got a
    // third. Statuspage stalls are correlated, so this is the case that counts.
    const vendors = Array.from({ length: 8 }, (_, i) => ({ name: `V${i}`, type: 'statuspage', url: `https://v${i}` }));
    const res = await collect(cfg(vendors), {
      fetchFn: slowFetch(60),
      now,
      timeoutMs: 20,
      lastAttemptTimeoutMs: 500,
      retryDelayMs: 0,
    });
    expect(res.unknown).toBe(0);
    expect(res.retriedOk).toBe(8);
    expect(res.budgetExhausted).toBe(false);
  });

  it('records which try answered and how long it took, for each fetch that needed a retry', async () => {
    // The run log is the only place a recovered stall shows. `attempt: 3`
    // with a long `ms` is the patient try doing its job; `attempt: 2` is an
    // ordinary retry. Without both, the 25 s figure could never be checked.
    let t = 0;
    const clock = () => new Date(1_000_000 + t);
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls <= 2) throw new Error('ECONNRESET');
      t += 17_000; // the answering try took 17 s by the injected clock
      return ok();
    };
    const res = await collect(cfg([{ name: 'Slow', type: 'statuspage', url: 'https://slow' }]), {
      fetchFn,
      now: clock,
      retryDelayMs: 0,
    });
    expect(res.retried).toEqual([{ url: 'https://slow', attempt: 3, ms: 17_000 }]);
    expect(res.retriedOk).toBe(1);
  });

  it('counts each fetch that needed a retry to succeed, and none on a healthy run', async () => {
    let flaky = 0;
    const fetchFn = async (url) => {
      if (url === 'https://flaky') {
        flaky += 1;
        if (flaky === 1) throw new Error('ECONNRESET');
      }
      return ok();
    };
    const res = await collect(
      cfg([
        { name: 'Fine', type: 'statuspage', url: 'https://fine' },
        { name: 'Flaky', type: 'statuspage', url: 'https://flaky' },
      ]),
      { fetchFn, now, retryDelayMs: 0 },
    );
    expect(res.retriedOk).toBe(1);
    const healthy = await collect(cfg([{ name: 'Fine', type: 'statuspage', url: 'https://fine' }]), {
      fetchFn: async () => ok(),
      now,
    });
    expect(healthy.retriedOk).toBe(0);
  });
});

// `waitable`: the vendors whose required fetch failed in a way that asking
// again a minute later could fix. The Worker's re-look reads it (worklist
// #129). It is decided where the failure happens, from the failure itself,
// never by reading the reason text back.
describe('collect — which vendors are worth another look (waitable)', () => {
  const GH = readFileSync(new URL('../fixtures/GitHub.json', import.meta.url), 'utf8');
  const ok = () => ({ ok: true, status: 200, text: async () => GH });
  const status = (code) => async () => ({ ok: false, status: code, text: async () => '' });
  const one = (fetchFn, over = {}) =>
    collect(cfg([{ name: 'V', type: 'statuspage', url: 'https://v' }]), { fetchFn, now, retryDelayMs: 0, ...over });

  it.each([
    ['a network error or deadline', async () => { throw new Error('ECONNRESET'); }, ['V']],
    ['HTTP 503', status(503), ['V']],
    ['HTTP 504', status(504), ['V']],
    ['HTTP 408', status(408), ['V']],
    ['HTTP 429 (it asked us to slow down)', status(429), []],
    ['HTTP 404 (a retired route)', status(404), []],
    ['HTTP 401', status(401), []],
    ['a 200 that does not parse', async () => ({ ok: true, status: 200, text: async () => '<html>' }), []],
    ['a healthy answer', async () => ok(), []],
  ])('%s -> %j', async (_label, fetchFn, expected) => {
    expect((await one(fetchFn)).waitable).toEqual(expected);
  });

  it('a vendor that answered on a retry is not waitable: it was read', async () => {
    let calls = 0;
    const res = await one(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return ok();
    });
    expect(res.waitable).toEqual([]);
    expect(res.unknown).toBe(0);
  });

  it('a request our own budget refused is not the vendor failing to answer', async () => {
    const vendors = ['A', 'B', 'C'].map((n) => ({ name: n, type: 'statuspage', url: `https://${n}` }));
    const res = await collect(cfg(vendors), { fetchFn: async () => ok(), now, retryDelayMs: 0, subrequestBudget: 1 });
    expect(res.budgetExhausted).toBe(true);
    expect(res.unknown).toBe(2);
    expect(res.waitable).toEqual([]);
  });

  it('a stalled primary is waitable even when its fallback answers 404', async () => {
    const fetchFn = async (url) => {
      if (url === 'https://primary') throw new Error('The operation was aborted due to timeout');
      return { ok: false, status: 404, text: async () => '' };
    };
    const res = await collect(
      cfg([{ name: 'V', type: 'statuspage', url: 'https://primary', fallbackUrls: ['https://backup'] }]),
      { fetchFn, now, retryDelayMs: 0 },
    );
    expect(res.waitable).toEqual(['V']);
  });

  it('a composite vendor is waitable when any one of its sources is, even if the row is not unknown', async () => {
    const OUTAGE = JSON.stringify({
      page: { url: 'https://status.example.com' },
      status: { indicator: 'critical', description: 'Major System Outage' },
      components: [{ id: 'c1', name: 'API', status: 'major_outage' }],
    });
    const fetchFn = async (url) => {
      if (url === 'https://b') throw new Error('ECONNRESET');
      return { ok: true, status: 200, text: async () => OUTAGE };
    };
    const res = await collect(
      cfg([
        { name: 'Fine', type: 'statuspage', url: 'https://fine' },
        {
          name: 'Multi',
          type: 'composite',
          sources: [
            { group: 'A', type: 'statuspage', url: 'https://a' },
            { group: 'B', type: 'statuspage', url: 'https://b' },
          ],
        },
      ]),
      { fetchFn, now, retryDelayMs: 0 },
    );
    expect(res.records.find((r) => r.vendor === 'Multi').severity).toBe(SEVERITY.MAJOR_OUTAGE);
    expect(res.waitable).toEqual(['Multi']);
  });
});
