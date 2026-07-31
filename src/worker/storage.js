import { compareRecords } from '../engine/severity.js';

/**
 * D1 persistence for the Worker runtime.
 *
 * This is the ONLY module that knows about Cloudflare bindings; the engine
 * stays runtime-agnostic so the same collection logic can run elsewhere.
 */

/**
 * Write a completed collection run.
 *
 * The snapshot replacement and the run metadata go in ONE batch, which D1
 * executes as a transaction. Audit finding M3: the predecessor cleared its
 * output and then wrote, so a failure between the two left an EMPTY board —
 * worse than a stale one, because empty renders as "nothing is wrong".
 *
 * @param {D1Database} db
 * @param {{records: any[], checkedAt: string, total: number, impacted: number, unknown: number, warnings: string[]}} run
 */
export async function writeRun(db, run) {
  // Replace ONLY the rows this run actually checked.
  //
  // `DELETE FROM snapshot` was correct while every run collected every vendor.
  // Under sharding it would delete the other two shards' rows and leave the
  // board showing a third of the services -- the same class of failure as
  // finding M3, arrived at from the opposite direction.
  const touched = run.records.map((r) => r.vendor);
  const placeholders = touched.map(() => '?').join(',');

  const statements = [
    db.prepare(`DELETE FROM snapshot WHERE vendor IN (${placeholders})`).bind(...touched),
    ...run.records.map((r) =>
      db
        .prepare(
          `INSERT INTO snapshot
             (vendor, service, severity, incident_name, description, source_url, components, warnings, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          r.vendor,
          r.service ?? r.vendor,
          r.severity,
          r.incidentName ?? '',
          r.description ?? '',
          r.sourceUrl ?? '',
          JSON.stringify(r.components ?? []),
          JSON.stringify(r.warnings ?? []),
          r.checkedAt ?? run.checkedAt,
        ),
    ),
    ...run.records.map((r) =>
      db
        .prepare('INSERT INTO history (vendor, severity, checked_at) VALUES (?, ?, ?)')
        .bind(r.vendor, r.severity, r.checkedAt ?? run.checkedAt),
    ),
    // Counts are computed FROM the snapshot table, not from `run`, because a
    // sharded run only knows about its own third of the board. Binding the
    // run's own totals here would make the headline read "14 services" and
    // report the other 27 as neither healthy nor impacted.
    //
    // Runs last in the batch, so it sees this run's inserts. D1 executes a
    // batch sequentially inside one transaction.
    //
    // `WHERE true` is REQUIRED, not decorative. SQLite cannot parse
    // `INSERT ... SELECT ... ON CONFLICT` without a WHERE clause on the SELECT
    // -- the parser cannot tell the upsert clause from a join constraint, and
    // fails with `near "DO": syntax error`. Shipped without it on 2026-07-31
    // and every cron threw for 25 minutes; the unit test missed it because a
    // mock `batch()` never executes SQL. See test/worker/storage.test.js, which
    // now asserts against real SQLite.
    db
      .prepare(
        `INSERT INTO run_meta (id, checked_at, total, impacted, unknown, warnings)
         SELECT 1, ?,
                COUNT(*),
                SUM(CASE WHEN severity NOT IN ('operational', 'unknown') THEN 1 ELSE 0 END),
                SUM(CASE WHEN severity = 'unknown' THEN 1 ELSE 0 END),
                ?
           FROM snapshot
          WHERE true
         ON CONFLICT(id) DO UPDATE SET
           checked_at = excluded.checked_at,
           total      = excluded.total,
           impacted   = excluded.impacted,
           unknown    = excluded.unknown,
           warnings   = excluded.warnings`,
      )
      .bind(run.checkedAt, JSON.stringify(run.warnings ?? [])),
  ];

  await db.batch(statements);
}

/**
 * Read the current board.
 * @param {D1Database} db
 * @returns {Promise<{records: any[], meta: any|null}>}
 */
export async function readSnapshot(db) {
  const [rows, meta] = await Promise.all([
    db.prepare('SELECT * FROM snapshot').all(),
    db.prepare('SELECT * FROM run_meta WHERE id = 1').first(),
  ]);

  // Sort HERE, not at write time.
  //
  // collect() sorts its records and writeRun inserted them in that order, so a
  // bare `SELECT *` used to come back sorted purely because rowid order matched
  // — an accident, not a contract. Sharding broke it on 2026-07-31: each shard
  // deletes its own rows and re-appends them, so the board became ordered by
  // whichever shard ran most recently and impacted services stopped floating to
  // the top. Ordering is the reader's job, because the reader is the only place
  // that sees the whole board.
  //
  // Not an `ORDER BY`: severity ordering is a domain rule (`unknown` outranks
  // `operational`) that lives in the engine. Encoding it as a SQL CASE ladder
  // would duplicate it, and the two copies would drift.
  const records = (rows?.results ?? []).map((r) => ({
    vendor: r.vendor,
    service: r.service,
    severity: r.severity,
    incidentName: r.incident_name,
    description: r.description,
    sourceUrl: r.source_url,
    components: safeParse(r.components, []),
    warnings: safeParse(r.warnings, []),
    checkedAt: r.checked_at,
  }));

  records.sort(compareRecords);

  return { records, meta: meta ?? null };
}

/** @param {unknown} text @param {any} fallback */
function safeParse(text, fallback) {
  try {
    return JSON.parse(String(text));
  } catch {
    return fallback;
  }
}
