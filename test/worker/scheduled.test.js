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

/**
 * Run a scheduled() call to completion under fake timers.
 *
 * A run that sees a failed fetch waits (retry backoff, then a minute before
 * each re-look). With fake timers those waits cost nothing and never make a
 * test slow or flaky; this drains them until the run settles.
 */
async function settle(promise) {
  let state = 'pending';
  const tracked = promise.then(
    (value) => { state = 'done'; return value; },
    (error) => { state = 'failed'; throw error; },
  );
  tracked.catch(() => {}); // the caller awaits `tracked`; this only stops an unhandled-rejection warning
  while (state === 'pending') await vi.advanceTimersByTimeAsync(1_000);
  return tracked;
}

describe('scheduled() — one shard collected, written, self-monitored', () => {
  let db, logs, errors;

  beforeEach(() => {
    vi.useFakeTimers();
    db = makeD1();
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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

    await settle(worker.scheduled({ scheduledTime: AT_MS }, { DB: db }));

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

  it('the Worker runs with the production deadlines: the third try gets 25 s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await settle(worker.scheduled({ scheduledTime: AT_MS }, { DB: db }));
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

    await expect(settle(worker.scheduled({ scheduledTime: AT_MS }, { DB: broken }))).rejects.toThrow('D1 is down');

    const events = logs.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.some((e) => e.event === 'fetch_retried_ok' && e.url === stalled.url)).toBe(true);
  });

  it('raises unknown_rate_high at ERROR when the whole shard fails — infrastructure, not coincidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await settle(worker.scheduled({ scheduledTime: AT_MS }, { DB: db }));

    const rows = (await db.prepare('SELECT * FROM snapshot').all()).results;
    for (const r of rows) expect(r.severity).toBe('unknown');

    const alerts = errors.mock.calls.map(([line]) => JSON.parse(line));
    expect(alerts.some((a) => a.alert === 'unknown_rate_high')).toBe(true);
  });

  it('a whole batch stalling together still gets its re-looks: feeds on one host stall together', async () => {
    // Statuspage stalls are correlated, and two batches hold nothing but
    // Statuspage vendors. Skipping re-looks when "everyone failed" would skip
    // them in exactly the case they exist for. An outage on OUR side costs
    // each batch its two re-looks once, and no more (the streak cap).
    const fetched = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      fetched.push(url);
      throw new Error('The operation was aborted due to timeout');
    }));

    await settle(worker.scheduled({ scheduledTime: AT_MS }, { DB: db }));

    for (const v of shardVendors) expect(fetched.filter((u) => u === v.url)).toHaveLength(9); // the batch, then two re-looks
    const events = logs.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.filter((e) => e.event === 'relook_complete').map((e) => e.look)).toEqual([1, 2]);
  });
});

// Worklist #129, part two. The patient last try cut unknown checks from 0.41%
// to 0.06% (2 of 3,451 in the first 16 hours), but a stall longer than ~46 s
// still put a vendor on the board as `unknown` until its batch came round
// again, 15 minutes later, although the feed was back within a minute or two.
// So the run that saw the failure looks again itself, a minute later and a
// minute after that.
describe('scheduled() — a vendor whose fetch failed is looked at again by the same run, a minute later', () => {
  let db, logs, errors;
  const OK = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => GREEN_STATUSPAGE });
  const own = shardVendors.find((v) => v.type === 'statuspage' && typeof v.url === 'string' && !v.scope);
  const events = () => logs.mock.calls.map(([line]) => JSON.parse(line));
  const alerts = () => errors.mock.calls.map(([line]) => JSON.parse(line));
  const relooks = () => events().filter((e) => e.event === 'relook_complete');
  const outcome = (e) => [e.look, e.recovered, e.still_failing, e.gave_up];
  const health = async () => (await db.prepare('SELECT vendor, failures FROM vendor_health ORDER BY vendor').all()).results;
  const snap = async (name) => db.prepare('SELECT severity, checked_at, warnings FROM snapshot WHERE vendor = ?').bind(name).first();
  const history = async (name) =>
    (await db.prepare('SELECT severity FROM history WHERE vendor = ? ORDER BY id').bind(name).all()).results.map((r) => r.severity);
  const run = (env = { DB: db }, at = AT_MS) => settle(worker.scheduled({ scheduledTime: at }, env));
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
    vi.useFakeTimers();
    db = makeD1();
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a feed that is back a minute later is read by the first re-look and written green', async () => {
    const calls = stubOwn((n) => (n <= 3 ? 'stall' : undefined)); // the batch's three tries stall

    await run();

    expect(calls.own).toBe(4);
    expect((await snap(own.name)).severity).toBe('operational');
    expect(await health()).toEqual([]);
    expect(await history(own.name)).toEqual(['unknown', 'operational']); // the board DID say unknown in between
    expect(events().find((e) => e.event === 'collection_complete')).toMatchObject({ unknown: 1 });
    expect(relooks().map(outcome)).toEqual([[1, [own.name], [], []]]);
    expect(relooks()[0]).toMatchObject({ event: 'relook_complete', shard: SHARD });
  });

  it('a feed that comes back two minutes later is read by the second re-look', async () => {
    const calls = stubOwn((n) => (n <= 6 ? 'stall' : undefined));

    await run();

    expect(calls.own).toBe(7);
    expect((await snap(own.name)).severity).toBe('operational');
    expect(relooks().map(outcome)).toEqual([
      [1, [], [own.name], []],
      [2, [own.name], [], []],
    ]);
  });

  it('a vendor still silent after both re-looks is left exactly as the batch wrote it', async () => {
    // A re-look may improve a row; it never writes `unknown`. So nothing it
    // does can undo a status, and the history keeps one row per real change.
    const calls = stubOwn(() => 'stall');

    await run();

    expect(calls.own).toBe(9); // the batch, then two re-looks, and no third
    expect((await snap(own.name)).severity).toBe('unknown');
    expect(await history(own.name)).toEqual(['unknown']);
    expect(await health()).toEqual([{ vendor: own.name, failures: 1 }]); // re-looks are not failed batch checks
    expect(relooks().map(outcome)).toEqual([
      [1, [], [own.name], []],
      [2, [], [own.name], []],
    ]);
    expect(alerts().some((a) => a.alert === 'unknown_rate_high')).toBe(false); // one vendor of four is not the batch failing
  });

  it('an outage gets its re-looks once: a vendor that was already unknown is not looked at again', async () => {
    // Otherwise a vendor that is down for hours would be collected three
    // times a cycle, and hold its run open four minutes, until someone fixed it.
    const calls = stubOwn(() => 'stall');
    await run(); // the outage begins: batch + two re-looks
    expect(calls.own).toBe(9);

    await run({ DB: db }, AT_MS + 15 * 60_000); // the same batch, 15 minutes on, still down

    expect(calls.own).toBe(12); // the batch's three tries and nothing more
    expect(await health()).toEqual([{ vendor: own.name, failures: 2 }]);
    expect(relooks()).toHaveLength(2); // both from the first run
  });

  it('a new outage, after a recovery, gets its re-looks again', async () => {
    let down = true;
    const calls = stubOwn(() => (down ? 'stall' : undefined));
    await run();
    down = false;
    await run({ DB: db }, AT_MS + 15 * 60_000); // recovers in its own batch
    expect(await health()).toEqual([]);
    down = true;
    const before = calls.own;

    await run({ DB: db }, AT_MS + 30 * 60_000);

    expect(calls.own - before).toBe(9);
  });

  it('a multi-feed vendor that answers only in part on a re-look is not written', async () => {
    // US Government is four feeds. In the batch Social Security stalls, so the
    // row is unknown. On each re-look Social Security answers "degraded", but
    // Login.gov gives no status: it stalls on the first re-look and answers
    // 429 on the second. "degraded" outranks "unknown", so the re-read's row
    // would say degraded while one feed was never read. A reading with a feed
    // missing is not an improvement, and it must not be written — whether the
    // missing feed failed in a waitable way (the stall) or not (the 429).
    const gov = vendorConfig.vendors.find((v) => v.name === 'US Government');
    const [login, ssa] = gov.sources.map((s) => s.url);
    const shardGov = [...Array(SHARD_COUNT).keys()].find((i) => selectShard(vendorConfig.vendors, i, SHARD_COUNT).includes(gov));
    const degraded = JSON.stringify({
      page: { url: 'https://status.example.com' },
      status: { indicator: 'minor', description: 'x' },
      components: [{ id: 'c1', name: 'Service', status: 'degraded_performance' }],
    });
    const n = {};
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      n[url] = (n[url] ?? 0) + 1;
      if (url === login) {
        if (n[url] === 1) return OK(); // the batch: healthy
        if (n[url] <= 4) throw new Error('The operation was aborted due to timeout'); // re-look 1
        return { ok: false, status: 429, headers: { get: () => '' }, text: async () => '' }; // re-look 2
      }
      if (url === ssa) {
        if (n[url] <= 3) throw new Error('The operation was aborted due to timeout'); // the batch's three tries
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => degraded };
      }
      return OK();
    }));

    await run({ DB: db }, (SHARD_COUNT + shardGov) * 60_000);

    expect((await snap(gov.name)).severity).toBe('unknown'); // as the batch wrote it
    expect(await history(gov.name)).toEqual(['unknown']);
    expect(relooks().map(outcome)).toEqual([
      [1, [], [gov.name], []], // Login.gov stalled: still worth a look
      [2, [], [], [gov.name]], // Login.gov said 429: not read in full, and not waitable
    ]);
  });

  it('re-collects only the vendor that failed, never the healthy ones beside it', async () => {
    const calls = stubOwn((n) => (n <= 3 ? 'stall' : undefined));

    await run();

    const others = shardVendors.filter((v) => v.name !== own.name && typeof v.url === 'string');
    for (const v of others) expect(calls.others.filter((u) => u === v.url)).toHaveLength(1);
  });

  it.each([
    ['a 404', 404, 1],
    ['a 429, after its three tries', 429, 3],
  ])('does not look again at %s: waiting cannot fix it', async (_label, code, expectedCalls) => {
    const calls = stubOwn(() => code);

    await run();

    expect(calls.own).toBe(expectedCalls);
    expect(relooks()).toEqual([]);
    expect((await snap(own.name)).severity).toBe('unknown');
  });

  it('stops looking once the stall has turned into something waiting cannot fix, and says it gave up', async () => {
    const calls = stubOwn((n) => (n <= 3 ? 'stall' : 404)); // the first re-look gets a 404

    await run();

    expect(calls.own).toBe(4); // no second re-look
    expect(relooks().map(outcome)).toEqual([[1, [], [], [own.name]]]);
    expect((await snap(own.name)).severity).toBe('unknown');
    expect(await history(own.name)).toEqual(['unknown']);
  });

  it('a healthy batch takes no re-look and sets no timer', async () => {
    stubOwn(() => undefined);

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db }); // not settle(): it must finish with no timer advanced

    expect(vi.getTimerCount()).toBe(0);
    expect(relooks()).toEqual([]);
  });

  it("a re-look does not stamp the run clock or prune: 'last collection' stays the batch's", async () => {
    stubOwn((n) => (n <= 3 ? 'stall' : undefined));
    // A row for a vendor this (old) code does not know. A deploy can add one
    // while a run is waiting to re-look; the re-look's write must not prune it.
    await db.prepare("INSERT INTO snapshot (vendor, service, severity, checked_at) VALUES ('AddedByNewerDeploy', 'x', 'operational', '2026-10-02T12:00:00.000Z')").run();
    let batchWrites = 0;
    const afterBatch = {
      ...db,
      batch: async (statements) => {
        const result = await db.batch(statements);
        batchWrites += 1;
        // The batch's own write prunes unknown names, as it always has. Put
        // the row back, as the newer deploy's next batch would.
        if (batchWrites === 1) {
          db.sqlite.exec("INSERT OR REPLACE INTO snapshot (vendor, service, severity, checked_at) VALUES ('AddedByNewerDeploy', 'x', 'operational', '2026-10-02T12:00:00.000Z')");
        }
        return result;
      },
    };

    await run({ DB: afterBatch });

    const meta = await db.prepare('SELECT * FROM run_meta WHERE id = 1').first();
    const batch = events().find((e) => e.event === 'collection_complete');
    expect(meta.checked_at).toBe(batch.checked_at);
    expect(meta.unknown).toBe(0); // the counts are current
    expect((await snap(own.name)).severity).toBe('operational');
    expect(await snap('AddedByNewerDeploy')).not.toBeNull();
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

    await run({ DB: flaky });

    const rows = (await db.prepare('SELECT vendor, severity FROM snapshot').all()).results;
    expect(rows).toHaveLength(shardVendors.length); // the batch's write stands
    expect(alerts()).toEqual([
      expect.objectContaining({
        event: 'collection_alert', relook: true, alert: 'relook_failed', look: 1, vendors: [own.name],
        detail: expect.stringContaining('D1 hiccup'),
      }),
    ]);
    // The reading that could not be written is not lost: the vendor keeps
    // its place, the second look reads it again and that write goes through.
    expect((await snap(own.name)).severity).toBe('operational');
    expect(relooks().map(outcome)).toEqual([
      [1, [], [], []], // read, but not written: it is in the alert, not in `recovered`
      [2, [own.name], [], []],
    ]);
    for (const e of relooks()) expect(Object.keys(e)).toEqual(expect.arrayContaining(['recovered', 'still_failing', 'gave_up', 'not_checked']));
  });

  it('a re-look that cannot read the streaks is loud and takes no look', async () => {
    const calls = stubOwn(() => 'stall');
    const broken = {
      ...db,
      prepare: (sql) => {
        if (/FROM vendor_health\s+WHERE failures = 1/.test(sql)) throw new Error('D1 read failed');
        return db.prepare(sql);
      },
    };

    await run({ DB: broken });

    expect(calls.own).toBe(3);
    expect(alerts()).toEqual([
      expect.objectContaining({ alert: 'relook_failed', look: 0, vendors: [own.name], detail: expect.stringContaining('D1 read failed') }),
    ]);
  });

  it('leaves alone a vendor whose status comes from several voting documents', async () => {
    // Zscaler reads one document per cloud and keeps going when one is
    // missing, so a partial reading of it looks like a full one (worklist
    // #132). A re-look that wrote it could turn a row green on a part of the
    // truth. Until the adapters can say "partial", it gets no re-look.
    const zscaler = vendorConfig.vendors.find((v) => v.name === 'Zscaler');
    const shardZ = [...Array(SHARD_COUNT).keys()].find((i) => selectShard(vendorConfig.vendors, i, SHARD_COUNT).includes(zscaler));
    let primary = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === zscaler.url) {
        primary += 1;
        throw new Error('The operation was aborted due to timeout');
      }
      return OK();
    }));

    await run({ DB: db }, (SHARD_COUNT + shardZ) * 60_000);

    expect((await snap(zscaler.name)).severity).toBe('unknown');
    expect(await health()).toContainEqual({ vendor: zscaler.name, failures: 1 }); // a fresh streak, and still no re-look
    expect(primary).toBe(3);
    expect(relooks().flatMap((e) => [...e.recovered, ...e.still_failing, ...e.gave_up])).not.toContain(zscaler.name);
  });

  it('a batch whose own write fails takes no re-look: its error escapes as before', async () => {
    const calls = stubOwn(() => 'stall');
    const broken = { ...db, batch: async () => { throw new Error('D1 is down'); } };

    await expect(run({ DB: broken })).rejects.toThrow('D1 is down');

    expect(calls.own).toBe(3);
    expect(relooks()).toEqual([]);
  });

  it('waits one minute before each re-look', async () => {
    const calls = stubOwn(() => 'stall');
    const done = worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    await vi.advanceTimersByTimeAsync(55_000); // the batch (with its retry backoff) is long over
    expect(calls.own).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000); // past one minute after the batch
    expect(calls.own).toBe(6);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(calls.own).toBe(6);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.own).toBe(9);
    await settle(done);
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
