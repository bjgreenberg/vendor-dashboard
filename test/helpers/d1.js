/**
 * A D1-compatible shim over node:sqlite, for tests that must execute REAL SQL.
 *
 * WHY THIS EXISTS. Storage was previously tested against a hand-rolled mock
 * whose `batch()` resolved to `[]`. A mock that never executes SQL cannot fail
 * on invalid SQL — so on 2026-07-31 a `run_meta` upsert missing the `WHERE
 * true` that SQLite requires before `ON CONFLICT` passed the whole suite,
 * deployed, and made every cron throw `near "DO": syntax error` for 25 minutes.
 * The board silently froze on its last good snapshot.
 *
 * testing.md §1: a consumer's mock must encode what the producer ACTUALLY
 * does. D1 is SQLite, and node:sqlite ships with Node, so this shim executes
 * the same dialect production parses at no dependency cost.
 *
 * It is deliberately NOT a general D1 emulator — it implements exactly the
 * surface src/worker/storage.js uses (prepare/bind/run/all/first + batch), so
 * a storage change that reaches for an unimplemented D1 feature fails loudly
 * here rather than passing against a permissive mock.
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = readFileSync('db/schema.sql', 'utf8');

/** @returns {{sqlite: DatabaseSync, prepare: Function, batch: Function}} */
export function makeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);

  return {
    sqlite,

    prepare(sql) {
      // Prepared eagerly so a syntax error throws HERE, exactly as D1 does —
      // this is the line that would have caught the ON CONFLICT bug.
      const stmt = sqlite.prepare(sql);
      const wrap = (args) => ({
        run: () => stmt.run(...args),
        all: async () => ({ results: stmt.all(...args) }),
        first: async () => stmt.get(...args) ?? null,
      });
      return { bind: (...args) => wrap(args), ...wrap([]) };
    },

    /** D1 executes a batch sequentially inside one transaction. */
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        for (const s of statements) s.run();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
      return [];
    },
  };
}

/** Factory for a status record with sane defaults (testing.md §4). */
export const record = (vendor, severity = 'operational', over = {}) => ({
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

/** Factory for a completed run wrapping the given records. */
export const runOf = (records, over = {}) => ({
  records,
  checkedAt: '2026-07-31T23:30:00.000Z',
  total: records.length,
  impacted: 0,
  unknown: 0,
  warnings: [],
  ...over,
});
