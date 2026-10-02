import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../../src/worker/index.js';
import { makeD1 } from '../helpers/d1.js';
import { selectShard, shardDueAt, SHARD_COUNT } from '../../src/engine/shard.js';
import vendorConfig from '../../config/vendors.json';

// Audit finding M4: src/worker/index.js was excluded from coverage entirely,
// so the scheduled() handler — shard selection, storage write, the
// self-monitoring alerts — had no gate at all. These tests exercise it through
// the real engine and real SQLite, stubbing only the network.

// scheduledTime chosen so shardDueAt lands on shard 1 (hash-assigned
// statuspage vendors). Derived, not hardcoded, so a SHARD_COUNT change moves
// the fixture instead of silently emptying it.
const SHARD = 1;
const AT_MS = (SHARD_COUNT + SHARD) * 60_000;

// The stub must carry a component matching Cloudflare's configured scope
// ("Cloudflare Sites and Services"): since the US-focus change, a scoped
// vendor whose scope matches NOTHING fails closed to unknown instead of
// silently reading operational (worst-of-empty was a false-green hole this
// test had unknowingly depended on). Unscoped vendors just see one healthy
// leaf, which is equivalent to the old empty list for their purposes.
const GREEN_STATUSPAGE = JSON.stringify({
  page: { url: 'https://status.example.com' },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [
    { id: 'g1', name: 'Cloudflare Sites and Services', group: true },
    { id: 'c1', name: 'Service', status: 'operational', group_id: 'g1' },
  ],
});

const shardVendors = selectShard(vendorConfig.vendors, SHARD, SHARD_COUNT);

describe('scheduled() — one shard collected, written, self-monitored', () => {
  let db, logs, errors;

  beforeEach(() => {
    db = makeD1();
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('sanity: the chosen slot maps to the shard under test, and it has vendors', () => {
    expect(shardDueAt(new Date(AT_MS), SHARD_COUNT, 1)).toBe(SHARD);
    expect(shardVendors.length).toBeGreaterThan(0);
  });

  it('writes one row per shard vendor and reports collection_complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => GREEN_STATUSPAGE,
    })));

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    const rows = (await db.prepare('SELECT * FROM snapshot').all()).results;
    expect(rows.map((r) => r.vendor).sort()).toEqual(shardVendors.map((v) => v.name).sort());
    for (const r of rows) expect(r.severity).toBe('operational');

    const events = logs.mock.calls.map(([line]) => JSON.parse(line));
    const complete = events.find((e) => e.event === 'collection_complete');
    expect(complete).toBeDefined();
    expect(complete.shard).toBe(SHARD);
    expect(complete.unknown).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('a vendor that fails twice and answers the third try is written green, and the run log counts it', async () => {
    // Worklist #129. Chosen by predicate, not position, so a config change
    // that reorders the shard cannot break this test.
    const stalled = shardVendors.find((v) => v.type === 'statuspage' && typeof v.url === 'string');
    expect(stalled).toBeDefined();
    const tries = {};
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      tries[url] = (tries[url] ?? 0) + 1;
      if (url === stalled.url && tries[url] <= 2) throw new Error('The operation was aborted due to timeout');
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => GREEN_STATUSPAGE };
    }));

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    const rows = (await db.prepare('SELECT * FROM snapshot').all()).results;
    for (const r of rows) expect(r.severity).toBe('operational');
    expect((await db.prepare('SELECT * FROM vendor_health').all()).results).toEqual([]);

    const events = logs.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.find((e) => e.event === 'collection_complete')).toMatchObject({ unknown: 0, retried_ok: 1 });
    expect(events.filter((e) => e.event === 'fetch_retried_ok')).toEqual([
      { event: 'fetch_retried_ok', shard: SHARD, url: stalled.url, attempt: 3, ms: expect.any(Number) },
    ]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('the Worker runs with the production deadlines: the third try gets 25 s', { timeout: 20_000 }, async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db, RELOOK_DELAY_MS: 0 });
    const deadlines = spy.mock.calls.map(([ms]) => ms);
    expect(deadlines).toContain(25_000);
    expect(new Set(deadlines)).toEqual(new Set([10_000, 25_000]));
  });

  it('still logs a recovered fetch when the D1 write then fails', async () => {
    // The recovered-fetch line is the only trace of a stall. A run that waits
    // out a stall and then loses its write must not lose that line too.
    const stalled = shardVendors.find((v) => v.type === 'statuspage' && typeof v.url === 'string');
    const tries = {};
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      tries[url] = (tries[url] ?? 0) + 1;
      if (url === stalled.url && tries[url] <= 2) throw new Error('The operation was aborted due to timeout');
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => GREEN_STATUSPAGE };
    }));
    const broken = { ...db, batch: async () => { throw new Error('D1 is down'); } };

    await expect(worker.scheduled({ scheduledTime: AT_MS }, { DB: broken })).rejects.toThrow('D1 is down');

    const events = logs.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.some((e) => e.event === 'fetch_retried_ok' && e.url === stalled.url)).toBe(true);
  });

  it('raises unknown_rate_high at ERROR when the whole shard fails — infrastructure, not coincidence', { timeout: 20_000 }, async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db, RELOOK_DELAY_MS: 0 });

    const rows = (await db.prepare('SELECT * FROM snapshot').all()).results;
    for (const r of rows) expect(r.severity).toBe('unknown');

    const alerts = errors.mock.calls.map(([line]) => JSON.parse(line));
    expect(alerts.some((a) => a.alert === 'unknown_rate_high')).toBe(true);
  });
});

// Worklist #129, part two. The patient last try cut unknown checks from 0.41%
// to 0.06% (2 of 3,451 in the first 16 hours), but a stall longer than ~46 s
// still put a vendor on the board as `unknown` until its batch came round
// again, 15 minutes later, although the feed was back within a minute or two.
// So the run that saw the failure looks again itself, a minute later and a
// minute after that.
// Generous timeout on purpose: a test here can run three full failing passes
// (the batch and two re-looks) on the engine's real, jittered retry backoff,
// up to ~1.9 s a pass. The 5 s default would make them flaky.
describe('scheduled() — a vendor whose fetch failed is looked at again by the same run, a minute later', { timeout: 20_000 }, () => {
  let db, logs, errors;
  const OK = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => GREEN_STATUSPAGE });
  const env = (over = {}) => ({ DB: db, RELOOK_DELAY_MS: 0, ...over });
  const own = shardVendors.find((v) => v.type === 'statuspage' && typeof v.url === 'string' && !v.scope);
  const events = () => logs.mock.calls.map(([line]) => JSON.parse(line));
  const alerts = () => errors.mock.calls.map(([line]) => JSON.parse(line));
  const relooks = () => events().filter((e) => e.event === 'recheck_complete');
  const health = async () => (await db.prepare('SELECT vendor, failures FROM vendor_health ORDER BY vendor').all()).results;
  const snap = async (name) => db.prepare('SELECT severity, checked_at, warnings FROM snapshot WHERE vendor = ?').bind(name).first();
  const history = async (name) =>
    (await db.prepare('SELECT severity FROM history WHERE vendor = ? ORDER BY id').bind(name).all()).results.map((r) => r.severity);
  /**
   * Stub fetch. `plan(n)` is asked for each call to `own.url` with its 1-based
   * call number: return 'stall', a status code, or nothing for a green 200.
   */
  const stubOwn = (plan) => {
    const calls = { own: 0, others: [] };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url !== own.url) { calls.others.push(url); return OK(); }
      calls.own += 1;
      const what = plan(calls.own);
      if (what === 'stall') throw new Error('The operation was aborted due to timeout');
      if (typeof what === 'number') return { ok: false, status: what, headers: { get: () => '' }, text: async () => '' };
      return OK();
    }));
    return calls;
  };

  beforeEach(() => {
    db = makeD1();
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The engine jitters its retry backoff with Math.random. Pin it to the
    // shortest wait: these tests are about re-looks, not about jitter, and a
    // fixed value makes their duration the same on every run.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a feed that is back a minute later is read by the first re-look and written green', async () => {
    const calls = stubOwn((n) => (n <= 3 ? 'stall' : undefined)); // the batch's three tries stall

    await worker.scheduled({ scheduledTime: AT_MS }, env());

    expect(calls.own).toBe(4);
    expect((await snap(own.name)).severity).toBe('operational');
    expect(await health()).toEqual([]);
    expect(await history(own.name)).toEqual(['unknown', 'operational']); // the board DID say unknown in between
    expect(events().find((e) => e.event === 'collection_complete')).toMatchObject({ unknown: 1 });
    expect(relooks()).toEqual([
      expect.objectContaining({ event: 'recheck_complete', shard: SHARD, look: 1, recovered: [own.name], still_unknown: [] }),
    ]);
  });

  it('a feed that comes back two minutes later is read by the second re-look', async () => {
    const calls = stubOwn((n) => (n <= 6 ? 'stall' : undefined));

    await worker.scheduled({ scheduledTime: AT_MS }, env());

    expect(calls.own).toBe(7);
    expect((await snap(own.name)).severity).toBe('operational');
    expect(relooks().map((e) => [e.look, e.recovered, e.still_unknown])).toEqual([
      [1, [], [own.name]],
      [2, [own.name], []],
    ]);
  });

  it('a vendor still silent after both re-looks is left exactly as the batch wrote it', async () => {
    // A re-look may improve a row; it never writes `unknown`. So nothing it
    // does can undo a status, and the history keeps one row per real change.
    const calls = stubOwn(() => 'stall');

    await worker.scheduled({ scheduledTime: AT_MS }, env());

    expect(calls.own).toBe(9); // the batch, then two re-looks, and no third
    const row = await snap(own.name);
    expect(row.severity).toBe('unknown');
    expect(await history(own.name)).toEqual(['unknown']);
    expect(await health()).toEqual([{ vendor: own.name, failures: 1 }]); // re-looks are not failed batch checks
    expect(relooks().map((e) => [e.look, e.still_unknown])).toEqual([[1, [own.name]], [2, [own.name]]]);
    expect(alerts().some((a) => a.alert === 'unknown_rate_high')).toBe(false); // one vendor of four is not the batch failing
  });

  it("a multi-feed vendor that answers only in part on a re-look keeps the outage its batch verified", async () => {
    // US Government is four feeds. In the batch, Login.gov reports a major
    // outage and Social Security stalls. On the re-look Login.gov stalls and
    // Social Security answers "degraded". Writing that partial re-read would
    // replace a verified major outage with "degraded". It must not be written.
    const gov = vendorConfig.vendors.find((v) => v.name === 'US Government');
    const [login, ssa] = gov.sources.map((s) => s.url);
    const SHARD_GOV = shardDueAt(new Date(0), SHARD_COUNT, 1) === 0
      ? [...Array(SHARD_COUNT).keys()].find((i) => selectShard(vendorConfig.vendors, i, SHARD_COUNT).includes(gov))
      : undefined;
    expect(SHARD_GOV).toBeDefined();
    const page = (indicator, status) => JSON.stringify({
      page: { url: 'https://status.example.com' },
      status: { indicator, description: 'x' },
      components: [{ id: 'c1', name: 'Service', status }],
    });
    const body = (text) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => text });
    const n = {};
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      n[url] = (n[url] ?? 0) + 1;
      if (url === login) {
        if (n[url] === 1) return body(page('critical', 'major_outage')); // the batch
        throw new Error('The operation was aborted due to timeout'); // every re-look
      }
      if (url === ssa) {
        if (n[url] <= 3) throw new Error('The operation was aborted due to timeout'); // the batch's three tries
        return body(page('minor', 'degraded_performance')); // the re-looks
      }
      return OK();
    }));

    await worker.scheduled({ scheduledTime: (SHARD_COUNT + SHARD_GOV) * 60_000 }, env());

    expect((await snap(gov.name)).severity).toBe('major_outage');
    expect(await history(gov.name)).toEqual(['major_outage']);
    expect(relooks().map((e) => [e.look, e.recovered, e.still_unknown])).toEqual([
      [1, [], [gov.name]],
      [2, [], [gov.name]],
    ]);
  });

  it('re-collects only the vendor that failed, never the healthy ones beside it', async () => {
    const calls = stubOwn((n) => (n <= 3 ? 'stall' : undefined));

    await worker.scheduled({ scheduledTime: AT_MS }, env());

    const others = shardVendors.filter((v) => v.name !== own.name && typeof v.url === 'string');
    for (const v of others) expect(calls.others.filter((u) => u === v.url)).toHaveLength(1);
  });

  it.each([
    ['a 404', 404, 1],
    ['a 429, after its three tries', 429, 3],
  ])('does not look again at %s: waiting cannot fix it', async (_label, code, expectedCalls) => {
    const calls = stubOwn(() => code);

    await worker.scheduled({ scheduledTime: AT_MS }, env());

    expect(calls.own).toBe(expectedCalls);
    expect(relooks()).toEqual([]);
    expect((await snap(own.name)).severity).toBe('unknown');
  });

  it('stops looking once the stall has turned into something waiting cannot fix', async () => {
    const calls = stubOwn((n) => (n <= 3 ? 'stall' : 404)); // the first re-look gets a 404

    await worker.scheduled({ scheduledTime: AT_MS }, env());

    expect(calls.own).toBe(4); // no second re-look
    expect(relooks()).toEqual([expect.objectContaining({ look: 1, recovered: [], still_unknown: [] })]);
    expect((await snap(own.name)).severity).toBe('unknown');
    expect(await history(own.name)).toEqual(['unknown']);
  });

  it('a healthy batch takes no re-look and does not wait', async () => {
    stubOwn(() => undefined);
    const started = Date.now();

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db }); // production delay: must not be reached

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(relooks()).toEqual([]);
  });

  it("a re-look does not stamp the run clock: 'last collection' stays the batch's", async () => {
    stubOwn((n) => (n <= 3 ? 'stall' : undefined));

    await worker.scheduled({ scheduledTime: AT_MS }, env());

    const meta = await db.prepare('SELECT * FROM run_meta WHERE id = 1').first();
    const batch = events().find((e) => e.event === 'collection_complete');
    expect(meta.checked_at).toBe(batch.checked_at);
    expect(meta.unknown).toBe(0); // the counts are current
  });

  it('a re-look that breaks is loud, names the vendors and the look, and costs the batch nothing', async () => {
    stubOwn((n) => (n <= 3 ? 'stall' : undefined));
    let writes = 0;
    const flaky = {
      ...db,
      batch: async (statements) => {
        writes += 1;
        if (writes === 2) throw new Error('D1 hiccup'); // the re-look's write
        return db.batch(statements);
      },
    };

    await worker.scheduled({ scheduledTime: AT_MS }, env({ DB: flaky }));

    const rows = (await db.prepare('SELECT vendor, severity FROM snapshot').all()).results;
    expect(rows).toHaveLength(shardVendors.length); // the batch's write stands
    expect(alerts()).toEqual([
      expect.objectContaining({
        event: 'collection_alert', recheck: true, alert: 'recheck_failed', look: 1, vendors: [own.name],
        detail: expect.stringContaining('D1 hiccup'),
      }),
    ]);
  });

  it('a batch whose own write fails takes no re-look: its error escapes as before', async () => {
    const calls = stubOwn(() => 'stall');
    const broken = { ...db, batch: async () => { throw new Error('D1 is down'); } };

    await expect(worker.scheduled({ scheduledTime: AT_MS }, env({ DB: broken }))).rejects.toThrow('D1 is down');

    expect(calls.own).toBe(3);
    expect(relooks()).toEqual([]);
  });

  it('waits one minute before each re-look in production', async () => {
    vi.useFakeTimers();
    const calls = stubOwn(() => 'stall');
    const done = worker.scheduled({ scheduledTime: AT_MS }, { DB: db }); // no override

    await vi.advanceTimersByTimeAsync(55_000); // the batch (with its retry backoff) is long over
    expect(calls.own).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000); // past one minute after the batch
    expect(calls.own).toBe(6);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(calls.own).toBe(6);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.own).toBe(9);
    await done;
  });
});

describe('fetch() — routing and response headers', () => {
  const env = (db) => ({ DB: db, BASE_PATH: '/service-status' });

  it('serves /api/status under the base path with the wire shape', async () => {
    const db = makeD1();
    const res = await worker.fetch(new Request('https://x/service-status/api/status'), env(db));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('records');
    expect(body).toHaveProperty('meta');
  });

  it('serves the dashboard with the nonce-gated CSP and hardening headers', async () => {
    const db = makeD1();
    const res = await worker.fetch(new Request('https://x/service-status/'), env(db));
    expect(res.status).toBe(200);
    const csp = res.headers.get('Content-Security-Policy');
    // The CSP is the second line of defence behind esc() (audit M4 of the
    // extraction audit); a regression here is a security regression.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[0-9a-f]+'/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain('<h1>Service Status</h1>');
    // The US-focus policy must be STATED on the page (operator decision
    // 2026-08-03): a green row judged from US regions only is honest solely
    // because the page says that is the vantage point.
    expect(html).toContain('US vantage point');
  });

  it('404s anything else', async () => {
    const res = await worker.fetch(new Request('https://x/service-status/nope'), env(makeD1()));
    expect(res.status).toBe(404);
  });
});
