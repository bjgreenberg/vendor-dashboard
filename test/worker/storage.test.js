import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { writeRun } from '../../src/worker/storage.js';

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

const SCHEMA = readFileSync('db/schema.sql', 'utf8');

/** Minimal D1-compatible shim over node:sqlite. */
function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  return {
    sqlite,
    prepare(sql) {
      // Prepare eagerly so a syntax error throws here, exactly as D1 does.
      const stmt = sqlite.prepare(sql);
      const run = (...args) => stmt.run(...args);
      return { bind: (...args) => ({ run: () => run(...args) }), run: () => run() };
    },
    async batch(statements) {
      this.sqlite.exec('BEGIN');
      try {
        for (const s of statements) s.run();
        this.sqlite.exec('COMMIT');
      } catch (e) {
        this.sqlite.exec('ROLLBACK');
        throw e;
      }
      return [];
    },
  };
}

const rec = (vendor, severity, over = {}) => ({
  vendor,
  service: vendor,
  severity,
  incidentName: '',
  description: '',
  sourceUrl: '',
  components: [],
  warnings: [],
  checkedAt: '2026-07-31T23:30:00.000Z',
  ...over,
});

const run = (records, over = {}) => ({
  records,
  checkedAt: '2026-07-31T23:30:00.000Z',
  total: records.length,
  impacted: 0,
  unknown: 0,
  warnings: [],
  ...over,
});

describe('writeRun against real SQLite', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });

  const meta = () => db.sqlite.prepare('SELECT * FROM run_meta WHERE id = 1').get();
  const snap = () =>
    db.sqlite.prepare('SELECT vendor, severity FROM snapshot ORDER BY vendor').all();

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
