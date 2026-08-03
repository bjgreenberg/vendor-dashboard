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
