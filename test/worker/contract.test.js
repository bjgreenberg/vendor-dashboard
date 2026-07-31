import { describe, it, expect, beforeEach } from 'vitest';
import { writeRun, readSnapshot } from '../../src/worker/storage.js';
import { makeD1 } from '../helpers/d1.js';

// Contract tests (testing.md §1): prove the WIRE SHAPE, not just the logic.
//
// /api/status is consumed by two things I control but which live in other
// repos and other runtimes: briangreenberg.net's `_data/serviceStatus.js`
// (Eleventy, build-time) and any monitoring that reads the board. A key rename
// here is a silent break there -- the site's build falls back to "no number"
// and simply omits the count, with nothing red anywhere.
//
// This is not hypothetical: while debugging on 2026-07-31 I read `meta.checkedAt`
// and got `undefined`, because the wire key is the snake_case `checked_at` that
// comes straight off the D1 column. The shape had never been asserted, so
// nothing distinguished "the collector is stalled" from "I used the wrong key".

const rec = (vendor, severity, over = {}) => ({
  vendor,
  service: `${vendor} Service`,
  severity,
  incidentName: 'Something',
  description: 'Details',
  sourceUrl: 'https://status.example.com',
  components: [{ name: 'API', severity }],
  warnings: ['a warning'],
  checkedAt: '2026-07-31T23:30:00.000Z',
  ...over,
});

describe('/api/status wire contract', () => {
  let db;
  beforeEach(async () => {
    db = makeD1();
    await writeRun(db, {
      records: [rec('Alpha', 'operational'), rec('Beta', 'degraded')],
      checkedAt: '2026-07-31T23:30:00.000Z',
      total: 2,
      impacted: 1,
      unknown: 0,
      warnings: ['collector: something'],
    });
  });

  it('meta uses snake_case keys, straight off the D1 columns', async () => {
    const { meta } = await readSnapshot(db);
    // Pinned deliberately. Renaming these to camelCase would silently break
    // the site's build-time fetch, which fails soft and omits the count.
    expect(Object.keys(meta).sort()).toEqual(
      ['checked_at', 'id', 'impacted', 'total', 'unknown', 'warnings'].sort(),
    );
    expect(meta.checked_at).toBe('2026-07-31T23:30:00.000Z');
    expect(typeof meta.total).toBe('number');
  });

  it('records use camelCase and expose every field the renderer reads', async () => {
    const { records } = await readSnapshot(db);
    expect(records.length).toBe(2);
    for (const r of records) {
      expect(Object.keys(r).sort()).toEqual(
        [
          'checkedAt',
          'components',
          'description',
          'incidentName',
          'service',
          'severity',
          'sourceUrl',
          'vendor',
          'warnings',
        ].sort(),
      );
    }
  });

  it('re-hydrates components and warnings as arrays, not JSON strings', async () => {
    // They are stored as TEXT. A consumer receiving a string where it expects
    // an array gets `.length` of the JSON source -- a plausible-looking number.
    const { records } = await readSnapshot(db);
    for (const r of records) {
      expect(Array.isArray(r.components)).toBe(true);
      expect(Array.isArray(r.warnings)).toBe(true);
    }
    expect(records[0].components[0]).toMatchObject({ name: 'API' });
  });

  it('survives corrupt JSON in a TEXT column without throwing', async () => {
    // Fail closed: a malformed row must degrade to an empty list, not take the
    // whole endpoint down and blank the board.
    db.sqlite.prepare("UPDATE snapshot SET components = '{not json' WHERE vendor = 'Alpha'").run();
    const { records } = await readSnapshot(db);
    const alpha = records.find((r) => r.vendor === 'Alpha');
    expect(alpha.components).toEqual([]);
  });

  it('severity is always one of the declared enum values', async () => {
    const { records } = await readSnapshot(db);
    const allowed = ['major_outage', 'partial_outage', 'degraded', 'unknown', 'maintenance', 'operational'];
    for (const r of records) expect(allowed).toContain(r.severity);
  });

  it('returns meta: null on a virgin database rather than inventing a run', async () => {
    // An empty board must not render as "all systems operational" -- the bug
    // caught on the first live deploy.
    const fresh = makeD1();
    const { records, meta } = await readSnapshot(fresh);
    expect(records).toEqual([]);
    expect(meta).toBeNull();
  });
});

describe('the site consumer reads what this actually returns', () => {
  // testing.md §1: "a consumer's mock must encode what the producer actually
  // returns". briangreenberg.net/_data/serviceStatus.js derives its count from
  // `meta.total`, falling back to `records.length`. Both paths are asserted
  // here so a rename cannot pass unnoticed on this side of the seam.
  it('exposes a count the site can read by either documented path', async () => {
    const db = makeD1();
    await writeRun(db, {
      records: [rec('Alpha', 'operational')],
      checkedAt: '2026-07-31T23:30:00.000Z',
      total: 1,
      impacted: 0,
      unknown: 0,
      warnings: [],
    });
    const payload = await readSnapshot(db);
    const count = Number(payload.meta?.total) || payload.records.length;
    expect(count).toBe(1);
  });
});
