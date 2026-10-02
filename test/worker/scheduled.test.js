import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../../src/worker/index.js';
import { makeD1, record as rec, runOf } from '../helpers/d1.js';
import { writeRun } from '../../src/worker/storage.js';
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

  it('the Worker runs with the production deadlines: the third try gets 25 s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });
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

  it('raises unknown_rate_high at ERROR when the whole shard fails — infrastructure, not coincidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    const rows = (await db.prepare('SELECT * FROM snapshot').all()).results;
    for (const r of rows) expect(r.severity).toBe('unknown');

    const alerts = errors.mock.calls.map(([line]) => JSON.parse(line));
    expect(alerts.some((a) => a.alert === 'unknown_rate_high')).toBe(true);
  });
});

// Worklist #129, part two. The patient last try cut unknown checks from 0.41%
// to 0.06% (2 of 3,451 in the first 16 hours), but a stall longer than ~46 s
// still put a vendor on the board as `unknown` until its batch came round
// again, 15 minutes later. So a vendor whose streak has just begun is looked
// at again by the next minutes' runs.
describe('scheduled() — a vendor that just went unknown is re-checked by the next minutes, not 15 minutes later', () => {
  let db, logs, errors;
  const OK = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => GREEN_STATUSPAGE });
  const TIMEOUT = 'fetch failed: The operation was aborted due to timeout';
  const SEEDED_AT = '2026-10-02T12:51:18.000Z';
  const inShard = new Set(shardVendors.map((v) => v.name));
  // Plain Statuspage vendors from OTHER shards: no scope, so the green stub reads green.
  const outsiders = vendorConfig.vendors.filter(
    (v) => v.type === 'statuspage' && typeof v.url === 'string' && !v.scope && !v.componentLevel && !inShard.has(v.name),
  );
  const outsider = outsiders[0];
  const events = () => logs.mock.calls.map(([line]) => JSON.parse(line));
  const alerts = () => errors.mock.calls.map(([line]) => JSON.parse(line));
  const rechecks = () => events().filter((e) => e.event === 'recheck_complete');
  const health = async () => (await db.prepare('SELECT vendor, failures FROM vendor_health ORDER BY vendor').all()).results;
  const snap = async (name) => db.prepare('SELECT severity, checked_at FROM snapshot WHERE vendor = ?').bind(name).first();
  const history = async (name) =>
    (await db.prepare('SELECT severity FROM history WHERE vendor = ? ORDER BY id').bind(name).all()).results.map((r) => r.severity);
  /** Put `name` on the board as unknown, `times` checks in a row. */
  const seedUnknown = async (name, { times = 1, at = SEEDED_AT, reason = TIMEOUT } = {}) => {
    for (let i = 0; i < times; i += 1) {
      await writeRun(db, runOf([rec(name, 'unknown', { checkedAt: at, warnings: [reason] })], { checkedAt: at }));
    }
  };
  const fetchLog = (fail = () => false) => {
    const fetched = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      fetched.push(url);
      if (fail(url)) throw new Error('The operation was aborted due to timeout');
      return OK();
    }));
    return fetched;
  };

  beforeEach(() => {
    db = makeD1();
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('sanity: there are plain Statuspage vendors outside the shard under test', () => {
    expect(outsiders.length).toBeGreaterThanOrEqual(3);
  });

  it('end to end: a vendor that stalls in its own batch is read by the NEXT minute\'s run', async () => {
    // No seeding: the unknown row and its reason come from the real engine,
    // so this also pins that the re-check recognises the engine's own wording.
    const own = shardVendors.find((v) => v.type === 'statuspage' && typeof v.url === 'string' && !v.scope);
    let stalled = true;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (stalled && url === own.url) throw new Error('The operation was aborted due to timeout');
      return OK();
    }));

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });
    expect((await snap(own.name)).severity).toBe('unknown');
    expect(await health()).toEqual([{ vendor: own.name, failures: 1 }]);

    stalled = false; // the feed is back
    await worker.scheduled({ scheduledTime: AT_MS + 60_000 }, { DB: db });

    expect((await snap(own.name)).severity).toBe('operational');
    // (The next batch's own vendors are not all Statuspage, so the green stub
    // leaves some of them unknown. Only this vendor's streak is under test.)
    expect((await health()).map((h) => h.vendor)).not.toContain(own.name);
    expect(await history(own.name)).toEqual(['unknown', 'operational']);
    expect(rechecks()).toEqual([
      expect.objectContaining({ event: 'recheck_complete', vendor: own.name, outcome: 'recovered', severity: 'operational' }),
    ]);
  });

  it('re-checks a vendor from another batch whose streak just began, and writes it green when it answers', async () => {
    await seedUnknown(outsider.name);
    const fetched = fetchLog();

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    expect(fetched).toContain(outsider.url);
    expect((await snap(outsider.name)).severity).toBe('operational');
    expect(await health()).toEqual([]);
    expect(rechecks()).toEqual([expect.objectContaining({ vendor: outsider.name, outcome: 'recovered' })]);
    // The batch's own run is untouched by the extra vendor.
    expect(events().find((e) => e.event === 'collection_complete')).toMatchObject({ total: shardVendors.length, unknown: 0 });
    expect(errors).not.toHaveBeenCalled();
  });

  it('a re-check that fails again changes NOTHING on the board: it only counts one more failure', async () => {
    // A re-check may improve a row; it must never write `unknown`. That is
    // what makes two overlapping re-checks safe: a slow, failing one cannot
    // overwrite the green that a quicker one already wrote.
    await seedUnknown(outsider.name);
    fetchLog((url) => url === outsider.url);

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    expect(await snap(outsider.name)).toEqual({ severity: 'unknown', checked_at: SEEDED_AT }); // the row is the seeded one
    expect(await history(outsider.name)).toEqual(['unknown']); // no extra history row
    expect(await health()).toEqual([{ vendor: outsider.name, failures: 2 }]);
    expect(rechecks()).toEqual([expect.objectContaining({ vendor: outsider.name, outcome: 'still_unknown' })]);
    // One failing outsider must not read as "the whole batch failed".
    expect(alerts().some((a) => a.alert === 'unknown_rate_high')).toBe(false);
    expect(events().find((e) => e.event === 'collection_complete')).toMatchObject({ unknown: 0 });
  });

  it('stops after two extra looks: a streak of three waits for its own batch', async () => {
    await seedUnknown(outsider.name, { times: 3 });
    const fetched = fetchLog();

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    expect(fetched).not.toContain(outsider.url);
    expect((await snap(outsider.name)).severity).toBe('unknown');
    expect(rechecks()).toEqual([]);
  });

  it('re-checks ONE vendor per run: fewest failures first, then longest-failing', async () => {
    const [a, b, c] = outsiders;
    await seedUnknown(a.name, { times: 2, at: '2026-10-02T12:50:00.000Z' }); // oldest, but already had a look
    await seedUnknown(b.name, { at: '2026-10-02T12:51:00.000Z' });
    await seedUnknown(c.name, { at: '2026-10-02T12:52:00.000Z' });
    const fetched = fetchLog();

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    expect([a, b, c].map((v) => fetched.includes(v.url))).toEqual([false, true, false]);
    expect(rechecks()).toHaveLength(1);
  });

  it('only re-checks a vendor that got NO ANSWER: not a 429, not a parse failure, not our own budget', async () => {
    const [a, b, c] = outsiders;
    await seedUnknown(a.name, { reason: 'fetch returned HTTP 429' });
    await seedUnknown(b.name, { reason: 'response was not valid JSON' });
    await seedUnknown(c.name, { reason: 'fetch failed: subrequest budget exhausted' });
    const fetched = fetchLog();

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    expect([a, b, c].some((v) => fetched.includes(v.url))).toBe(false);
    expect(rechecks()).toEqual([]);
  });

  it("does not re-check a vendor that this minute's own batch has just checked", async () => {
    // The batch runs first. Its own vendor fails there (streak 1 -> 2), which
    // makes it "due"; the re-check must still leave it alone, or a vendor
    // would get two full sets of tries in one minute.
    const own = shardVendors.find((v) => v.type === 'statuspage' && typeof v.url === 'string');
    await seedUnknown(own.name);
    const fetched = fetchLog((url) => url === own.url);

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: db });

    expect(fetched.filter((u) => u === own.url)).toHaveLength(3); // one set of tries, not two
    expect(await health()).toEqual([{ vendor: own.name, failures: 2 }]);
    expect(rechecks()).toEqual([]);
  });

  it('a vendor that has left the config is skipped and cannot block the vendor behind it', async () => {
    // A removed vendor's rows are pruned by the next successful batch write,
    // so this only matters when that write fails. Then the stale name sits at
    // the head of the queue: it must be passed over, not collected (it has no
    // config) and not allowed to stop the real vendor behind it.
    await seedUnknown('Ghost', { at: '2026-10-02T12:00:00.000Z' }); // oldest, no config entry
    await seedUnknown(outsider.name);
    const fetched = fetchLog();
    const broken = { ...db, batch: async () => { throw new Error('D1 is down'); } };

    await expect(worker.scheduled({ scheduledTime: AT_MS }, { DB: broken })).rejects.toThrow('D1 is down');

    expect(fetched).toContain(outsider.url);
    // Its own write then fails too, loudly, and nothing was collected for Ghost.
    expect(alerts().filter((a) => a.alert === 'recheck_failed')).toHaveLength(1);
    expect(rechecks()).toEqual([]);
  });

  it('a failed re-check never costs the batch its own run: the batch is still written and the failure is loud', async () => {
    await seedUnknown(outsider.name);
    fetchLog();
    const broken = {
      ...db,
      prepare: (sql) => {
        if (/FROM vendor_health h/.test(sql)) throw new Error('D1 read failed');
        return db.prepare(sql);
      },
    };

    await worker.scheduled({ scheduledTime: AT_MS }, { DB: broken });

    const rows = (await db.prepare('SELECT vendor, severity FROM snapshot').all()).results;
    for (const v of shardVendors) expect(rows.find((r) => r.vendor === v.name)?.severity).toBe('operational');
    expect(alerts()).toEqual([
      expect.objectContaining({ event: 'collection_alert', alert: 'recheck_failed', detail: expect.stringContaining('D1 read failed') }),
    ]);
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
