import { describe, it, expect, beforeEach } from 'vitest';
import { writeRun, readSnapshot } from '../../src/worker/storage.js';
import { makeD1, record as rec, runOf as run } from '../helpers/d1.js';

// These tests execute the REAL SQL against REAL SQLite.
//
// That is the entire point. The previous storage tests used a mock `db` whose
// `batch()` resolved to []. A mock that never executes SQL cannot fail on
// invalid SQL, so on 2026-07-31 an `INSERT ... SELECT ... ON CONFLICT` missing
// its required `WHERE true` passed every test, deployed, and made every cron
// throw `near "DO": syntax error` for 25 minutes. The board silently froze on
// its last good snapshot while reporting nothing wrong.
//
// node:sqlite ships with Node, so this costs no dependency. D1 is SQLite, so
// the dialect is the same one production parses.

let db;
const meta = () => db.sqlite.prepare('SELECT * FROM run_meta WHERE id = 1').get();
const snap = () => db.sqlite.prepare('SELECT vendor, severity FROM snapshot ORDER BY vendor').all();

beforeEach(() => {
  db = makeD1();
});

describe('writeRun against real SQLite', () => {

  it('executes without a SQL syntax error', async () => {
    // The regression. Every statement is prepared and executed for real.
    await expect(writeRun(db, run([rec('A', 'operational')]))).resolves.not.toThrow();
  });

  it('replaces only the vendors this run checked', async () => {
    // Shard 1 writes, then shard 2 writes. Shard 1's rows must survive --
    // a wholesale DELETE would leave the board showing a third of the services.
    await writeRun(db, run([rec('A', 'operational'), rec('B', 'degraded')]));
    await writeRun(db, run([rec('C', 'operational')]));
    expect(snap().map((r) => r.vendor)).toEqual(['A', 'B', 'C']);
  });

  it('updates a vendor in place rather than duplicating it', async () => {
    await writeRun(db, run([rec('A', 'operational')]));
    await writeRun(db, run([rec('A', 'major_outage')]));
    expect(snap()).toEqual([{ vendor: 'A', severity: 'major_outage' }]);
  });

  it('counts the WHOLE board, not just the shard that just ran', async () => {
    // The failure this guards: a 14-vendor shard reporting total=14 would make
    // the headline read "14 services" and drop the other 27 from the counts.
    await writeRun(db, run([rec('A', 'operational'), rec('B', 'unknown')]));
    await writeRun(db, run([rec('C', 'degraded')]));

    const m = meta();
    expect(m.total).toBe(3); // not 1
    expect(m.unknown).toBe(1); // from the earlier shard
    expect(m.impacted).toBe(1); // degraded, from this shard
  });

  it('records history for every write, append-only', async () => {
    await writeRun(db, run([rec('A', 'operational')]));
    await writeRun(db, run([rec('A', 'degraded')]));
    const rows = db.sqlite.prepare('SELECT vendor, severity FROM history').all();
    expect(rows.length).toBe(2);
  });

  it('leaves the previous snapshot intact when the batch fails', async () => {
    // Finding M3: clearing output and then failing left an EMPTY board, which
    // renders as "nothing is wrong". The transaction must roll back whole.
    await writeRun(db, run([rec('A', 'operational')]));
    const bad = run([rec('B', 'operational')]);
    bad.records.push({ ...rec('C', 'operational'), vendor: null }); // NOT NULL violation
    await expect(writeRun(db, bad)).rejects.toThrow();
    expect(snap()).toEqual([{ vendor: 'A', severity: 'operational' }]);
  });
});

describe('writeRun defensive defaults', () => {

  it('fills every optional field rather than writing NULL', async () => {
    // Adapters are allowed to omit optional fields. NOT NULL columns would
    // reject the row, and one bad adapter would abort the whole shard's
    // transaction -- taking 13 healthy vendors down with it.
    const bare = {
      vendor: 'Bare',
      severity: 'operational',
      checkedAt: '2026-07-31T23:30:00.000Z',
    };
    await expect(
      writeRun(db, {
        records: [bare],
        checkedAt: '2026-07-31T23:30:00.000Z',
        total: 1,
        impacted: 0,
        unknown: 0,
      }),
    ).resolves.not.toThrow();

    const row = db.sqlite.prepare('SELECT * FROM snapshot WHERE vendor = ?').get('Bare');
    expect(row.service).toBe('Bare'); // falls back to the vendor name
    expect(row.incident_name).toBe('');
    expect(row.description).toBe('');
    expect(row.source_url).toBe('');
    expect(row.components).toBe('[]');
    expect(row.warnings).toBe('[]');
  });

  it('falls back to the run timestamp when a record carries none', async () => {
    await writeRun(db, {
      records: [{ vendor: 'NoTime', severity: 'unknown' }],
      checkedAt: '2026-07-31T23:30:00.000Z',
      total: 1,
      impacted: 0,
      unknown: 1,
    });
    const row = db.sqlite.prepare('SELECT checked_at FROM snapshot WHERE vendor = ?').get('NoTime');
    expect(row.checked_at).toBe('2026-07-31T23:30:00.000Z');
  });

  it('writes an empty warnings array when the run reports none', async () => {
    await writeRun(db, {
      records: [rec('A', 'operational')],
      checkedAt: '2026-07-31T23:30:00.000Z',
      total: 1,
      impacted: 0,
      unknown: 0,
    });
    expect(meta().warnings).toBe('[]');
  });
});

describe('readSnapshot', () => {
  it('returns empty results and null meta on a fresh database', async () => {
    const { records, meta: m } = await readSnapshot(makeD1());
    expect(records).toEqual([]);
    expect(m).toBeNull();
  });

  it('degrades a corrupt JSON column to an empty array instead of throwing', async () => {
    await writeRun(db, {
      records: [rec('A', 'operational')],
      checkedAt: '2026-07-31T23:30:00.000Z',
      total: 1,
      impacted: 0,
      unknown: 0,
    });
    db.sqlite.prepare("UPDATE snapshot SET components='oops', warnings='{'").run();
    const { records } = await readSnapshot(db);
    expect(records[0].components).toEqual([]);
    expect(records[0].warnings).toEqual([]);
  });
});

describe('read order is guaranteed by the reader, not by insertion order', () => {
  // REGRESSION (2026-07-31). collect() sorts its records and writeRun inserted
  // them in that order, so a bare `SELECT *` came back sorted purely because
  // rowid order happened to match. Sharding broke that: each shard deletes its
  // own rows and re-appends them, so the board became ordered by "whichever
  // shard ran most recently" and impacted services stopped floating to the top.
  //
  // The ordering contract now belongs to readSnapshot, which is the only place
  // that can honour it no matter how the rows were written.
  it('sorts most-severe first regardless of which shard wrote last', async () => {
    // Written in three shards, deliberately worst-last.
    await writeRun(db, run([rec('Alpha', 'operational'), rec('Bravo', 'operational')]));
    await writeRun(db, run([rec('Charlie', 'degraded')]));
    await writeRun(db, run([rec('Delta', 'major_outage'), rec('Echo', 'unknown')]));

    const { records } = await readSnapshot(db);
    expect(records.map((r) => r.vendor)).toEqual([
      'Delta', // major_outage
      'Charlie', // degraded
      'Echo', // unknown  (outranks operational: a failed check is not health)
      'Alpha', // operational, then A-Z
      'Bravo',
    ]);
  });

  it('re-sorts after a healthy vendor becomes impacted in a later shard', async () => {
    await writeRun(db, run([rec('Zulu', 'operational'), rec('Alpha', 'operational')]));
    await writeRun(db, run([rec('Zulu', 'major_outage')]));
    const { records } = await readSnapshot(db);
    expect(records[0].vendor).toBe('Zulu');
  });

  it('breaks ties case-insensitively by vendor name', async () => {
    await writeRun(db, run([rec('zapier', 'operational'), rec('Zoom', 'operational')]));
    const { records } = await readSnapshot(db);
    expect(records.map((r) => r.vendor)).toEqual(['zapier', 'Zoom']);
  });
});

describe('pruning vendors removed from config', () => {
  // REGRESSION (2026-08-01). Shard-scoped deletes fixed one bug and created
  // another: `DELETE ... WHERE vendor IN (checked)` only touches vendors the
  // run checked, so a vendor REMOVED from config is never checked again and
  // its row is orphaned forever. It keeps its last severity, freezes its
  // timestamp, and still counts toward run_meta totals -- stale data presented
  // as current, which is the whole failure class this project exists to
  // prevent. Observed live: consolidating five Microsoft rows into one left
  // all five on the board, showing 45 rows for 41 configured vendors.
  it('removes rows for vendors no longer configured', async () => {
    await writeRun(db, run([rec('Keep', 'operational'), rec('Dropped', 'operational')]));
    // A later run of a DIFFERENT shard, with 'Dropped' no longer in config.
    await writeRun(db, run([rec('Other', 'operational')]), { knownVendors: ['Keep', 'Other'] });
    expect(snap().map((r) => r.vendor)).toEqual(['Keep', 'Other']);
  });

  it('keeps vendors that are configured but simply not in this shard', async () => {
    // The critical distinction. Only 1/3 of vendors are checked per run; the
    // other two thirds must survive untouched.
    await writeRun(db, run([rec('ShardA', 'operational')]));
    await writeRun(db, run([rec('ShardB', 'operational')]), {
      knownVendors: ['ShardA', 'ShardB', 'ShardC'],
    });
    expect(snap().map((r) => r.vendor)).toEqual(['ShardA', 'ShardB']);
  });

  it('corrects run_meta totals after a prune', async () => {
    await writeRun(db, run([rec('Keep', 'operational'), rec('Dropped', 'unknown')]));
    expect(meta().total).toBe(2);
    await writeRun(db, run([rec('Keep', 'operational')]), { knownVendors: ['Keep'] });
    expect(meta().total).toBe(1);
    expect(meta().unknown).toBe(0);
  });

  it('prunes nothing when knownVendors is not supplied', async () => {
    // Back-compatible: a caller that does not know the full list must not
    // accidentally wipe the other shards.
    await writeRun(db, run([rec('A', 'operational'), rec('B', 'operational')]));
    await writeRun(db, run([rec('A', 'operational')]));
    expect(snap().map((r) => r.vendor)).toEqual(['A', 'B']);
  });
});

describe('history retention (audit L4)', () => {
  // history was append-only with no cap: ~4,000 rows/day at 46 vendors on a
  // 1-minute cron. Years from D1's free 5 GB, but "unbounded growth nobody
  // owns" is how that story always ends. 90 days keeps a full quarter of
  // uptime/MTTR raw material; revisit if longer-horizon analytics ever ship.
  const day = 24 * 60 * 60 * 1000;
  const at = (offsetDays) =>
    new Date(Date.parse('2026-07-31T23:30:00.000Z') + offsetDays * day).toISOString();

  it('prunes history older than 90 days as part of the write batch', async () => {
    db.sqlite
      .prepare('INSERT INTO history (vendor, severity, checked_at) VALUES (?, ?, ?)')
      .run('Ancient', 'operational', at(-100));
    db.sqlite
      .prepare('INSERT INTO history (vendor, severity, checked_at) VALUES (?, ?, ?)')
      .run('Recent', 'operational', at(-10));

    await writeRun(db, run([rec('Fresh', 'operational')]));

    const vendors = db.sqlite
      .prepare('SELECT vendor FROM history ORDER BY vendor')
      .all()
      .map((r) => r.vendor);
    expect(vendors).toEqual(['Fresh', 'Recent']);
  });

  it('the cutoff derives from the run clock, not wall time', async () => {
    // A backfill or a test with a fixed clock must prune relative to ITS
    // checkedAt; storage stays deterministic with no Date.now() of its own.
    db.sqlite
      .prepare('INSERT INTO history (vendor, severity, checked_at) VALUES (?, ?, ?)')
      .run('Boundary', 'operational', at(-89));

    await writeRun(db, run([rec('Fresh', 'operational')]));

    const vendors = db.sqlite
      .prepare('SELECT vendor FROM history ORDER BY vendor')
      .all()
      .map((r) => r.vendor);
    expect(vendors).toContain('Boundary');
  });
});

// ENDPOINT-ROT WATCHDOG (spec: docs/superpowers/specs/2026-08-12-endpoint-rot-
// watchdog-design.md). Streaks ride writeRun's transactional batch; a row in
// vendor_health means "currently failing since failing_since". The SendGrid
// rot of 2026-08-12 sat at `unknown` for hours with nothing counting.
describe('vendor_health — endpoint-rot streak tracking', () => {
  const health = () =>
    db.sqlite.prepare('SELECT * FROM vendor_health ORDER BY vendor').all();
  const at = (ts) => ({ checkedAt: ts });

  it('an unknown collection starts a streak at that run time', async () => {
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    expect(health()).toEqual([
      { vendor: 'SendGrid', failing_since: '2026-07-31T23:30:00.000Z', failures: 1 },
    ]);
  });

  it('a repeat unknown increments failures but keeps failing_since', async () => {
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    await writeRun(db, run([rec('SendGrid', 'unknown', at('2026-07-31T23:45:00.000Z'))]));
    expect(health()).toEqual([
      { vendor: 'SendGrid', failing_since: '2026-07-31T23:30:00.000Z', failures: 2 },
    ]);
  });

  it('recovery clears the streak', async () => {
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    await writeRun(db, run([rec('SendGrid', 'degraded', at('2026-07-31T23:45:00.000Z'))]));
    expect(health()).toEqual([]);
  });

  it('a budget-exhausted run neither starts nor clears streaks', async () => {
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    // Exhausted run: SendGrid "recovers" and Zoom "fails" — neither may count.
    // 17 unknowns from a spent budget are an operator fault, not vendor rot.
    await writeRun(db, run(
      [rec('SendGrid', 'operational', at('2026-07-31T23:45:00.000Z')),
       rec('Zoom', 'unknown', at('2026-07-31T23:45:00.000Z'))],
      { budgetExhausted: true },
    ));
    expect(health()).toEqual([
      { vendor: 'SendGrid', failing_since: '2026-07-31T23:30:00.000Z', failures: 1 },
    ]);
  });

  it('a vendor removed from config loses its streak row (no orphaned alarms)', async () => {
    await writeRun(db, run([rec('Ghost', 'unknown')]));
    await writeRun(db, run([rec('Zoom', 'operational', at('2026-07-31T23:45:00.000Z'))]), {
      knownVendors: ['Zoom'],
    });
    expect(health()).toEqual([]);
  });

  it('readSnapshot carries unknownSince only for vendors with an active streak', async () => {
    await writeRun(db, run([rec('SendGrid', 'unknown'), rec('Zoom', 'operational')]));
    const { records } = await readSnapshot(db);
    const sg = records.find((r) => r.vendor === 'SendGrid');
    const zoom = records.find((r) => r.vendor === 'Zoom');
    expect(sg.unknownSince).toBe('2026-07-31T23:30:00.000Z');
    // ABSENT, not null: the field's absence is the healthy case, so old
    // clients and the renderer see an unchanged record shape.
    expect('unknownSince' in zoom).toBe(false);
  });

  it('a shard only touches its own vendors’ streaks', async () => {
    await writeRun(db, run([rec('SendGrid', 'unknown')]));
    await writeRun(db, run([rec('Zoom', 'operational', at('2026-07-31T23:45:00.000Z'))]));
    expect(health().map((r) => r.vendor)).toEqual(['SendGrid']);
  });
});
