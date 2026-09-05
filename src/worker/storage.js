import { compareRecords } from '../engine/severity.js';

/**
 * How long history rows live (audit finding L4). ~4,000 rows/day at 46
 * vendors; unbounded would take years to matter on D1's free tier, but
 * unbounded-growth-nobody-owns is a liability, not a plan. 90 days keeps a
 * full quarter of uptime/MTTR raw material — revisit if longer-horizon
 * analytics ever ship.
 */
const HISTORY_RETENTION_DAYS = 90;

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
export async function writeRun(db, run, options = {}) {
  // Replace ONLY the rows this run actually checked.
  //
  // `DELETE FROM snapshot` was correct while every run collected every vendor.
  // Under sharding it would delete the other two shards' rows and leave the
  // board showing a third of the services -- the same class of failure as
  // finding M3, arrived at from the opposite direction.
  const touched = run.records.map((r) => r.vendor);
  const placeholders = touched.map(() => '?').join(',');

  // Prune vendors that are no longer configured at all.
  //
  // Shard-scoped deletes fixed one bug and created another: `DELETE ... WHERE
  // vendor IN (checked)` only touches vendors this run checked, so a vendor
  // REMOVED from config is never checked again and its row is orphaned
  // forever. It keeps its last severity, freezes its timestamp, and still
  // counts toward run_meta -- stale data presented as current. Observed live
  // 2026-08-01: consolidating five Microsoft rows into one left all five on
  // the board, 45 rows for 41 configured vendors.
  //
  // `knownVendors` is the FULL configured list, not the shard, and is optional
  // so a caller that does not know the full list cannot accidentally wipe the
  // other shards.
  const known = Array.isArray(options.knownVendors) ? options.knownVendors : null;
  const prune =
    known && known.length > 0
      ? [
          db
            .prepare(`DELETE FROM snapshot WHERE vendor NOT IN (${known.map(() => '?').join(',')})`)
            .bind(...known),
          // A vendor removed from config must lose its streak row too, or the
          // watchdog alarms forever on a row nothing will ever clear.
          db
            .prepare(
              `DELETE FROM vendor_health WHERE vendor NOT IN (${known.map(() => '?').join(',')})`,
            )
            .bind(...known),
        ]
      : [];

  const statements = [
    ...prune,
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
    // ENDPOINT-ROT WATCHDOG. Streaks ride the same transactional batch as the
    // snapshot so board and streaks can never disagree. ON CONFLICT
    // deliberately leaves failing_since alone — it marks the FIRST unknown of
    // the streak. Skipped wholesale on budget-exhausted runs: those unknowns
    // are an operator fault (see collection_alert), not vendor rot, and must
    // neither start nor clear a streak.
    ...(run.budgetExhausted
      ? []
      : run.records.map((r) =>
          r.severity === 'unknown'
            ? db
                .prepare(
                  `INSERT INTO vendor_health (vendor, failing_since, failures)
                   VALUES (?, ?, 1)
                   ON CONFLICT(vendor) DO UPDATE SET failures = failures + 1`,
                )
                .bind(r.vendor, r.checkedAt ?? run.checkedAt)
            : db.prepare('DELETE FROM vendor_health WHERE vendor = ?').bind(r.vendor),
        )),
    // Retention rides along in the same transactional batch — no separate job
    // to forget. The cutoff derives from the RUN's clock, not Date.now(), so
    // storage stays deterministic; ISO-8601 strings compare lexicographically,
    // which is what makes the < on TEXT correct.
    db
      .prepare('DELETE FROM history WHERE checked_at < ?')
      .bind(
        new Date(
          Date.parse(run.checkedAt) - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString(),
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
 * Read only the run metadata — the cheap freshness probe for /health.
 * @param {D1Database} db
 * @returns {Promise<any|null>}
 */
/**
 * Persist the external truth-check's stamp (spec:
 * docs/superpowers/specs/2026-09-05-truth-check-design.md). Single row,
 * upserted; the reader treats an absent row as "never checked" and a stale
 * one as the alarm.
 * @param {D1Database} db
 * @param {{checkedAt: string, covered: number, total: number, agreed: number, disagreements: number, falseGreen: string[]}} stamp
 */
export async function writeTruthCheck(db, stamp) {
  await db
    .prepare(
      `INSERT INTO truth_check (id, checked_at, covered, total, agreed, disagreements, detail)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         checked_at = excluded.checked_at, covered = excluded.covered, total = excluded.total,
         agreed = excluded.agreed, disagreements = excluded.disagreements, detail = excluded.detail`,
    )
    .bind(
      stamp.checkedAt,
      stamp.covered,
      stamp.total,
      stamp.agreed,
      stamp.disagreements,
      JSON.stringify({ falseGreen: stamp.falseGreen ?? [] }),
    )
    .run();
}

/**
 * The last truth-check stamp, or null when the board has never been checked.
 * @param {D1Database} db
 * @returns {Promise<{checkedAt: string, covered: number, total: number, agreed: number, disagreements: number, falseGreen: string[]}|null>}
 */
export async function readTruthCheck(db) {
  const row = await db.prepare('SELECT * FROM truth_check WHERE id = 1').first();
  if (!row) return null;
  const detail = safeParse(row.detail, {});
  return {
    checkedAt: row.checked_at,
    covered: row.covered,
    total: row.total,
    agreed: row.agreed,
    disagreements: row.disagreements,
    falseGreen: Array.isArray(detail?.falseGreen) ? detail.falseGreen.map(String) : [],
  };
}

export async function readMeta(db) {
  const meta = await db.prepare('SELECT * FROM run_meta WHERE id = 1').first();
  return meta ?? null;
}

/**
 * Read the current board.
 * @param {D1Database} db
 * @returns {Promise<{records: any[], meta: any|null, truthCheck: any|null}>}
 */
export async function readSnapshot(db) {
  const [rows, meta, health, truthCheck] = await Promise.all([
    db.prepare('SELECT * FROM snapshot').all(),
    db.prepare('SELECT * FROM run_meta WHERE id = 1').first(),
    db.prepare('SELECT vendor, failing_since FROM vendor_health').all(),
    readTruthCheck(db),
  ]);

  // Streak start per currently-failing vendor (endpoint-rot watchdog). The
  // field is ABSENT for healthy vendors rather than null, so the record shape
  // is unchanged for every existing reader.
  const failingSince = new Map(
    (health?.results ?? []).map((h) => [h.vendor, h.failing_since]),
  );

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
    ...(failingSince.has(r.vendor) ? { unknownSince: failingSince.get(r.vendor) } : {}),
  }));

  records.sort(compareRecords);

  return { records, meta: meta ?? null, truthCheck };
}

/** @param {unknown} text @param {any} fallback */
function safeParse(text, fallback) {
  try {
    return JSON.parse(String(text));
  } catch {
    return fallback;
  }
}
