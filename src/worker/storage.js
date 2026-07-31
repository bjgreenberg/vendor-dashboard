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
    db
      .prepare(
        `INSERT INTO run_meta (id, checked_at, total, impacted, unknown, warnings)
         SELECT 1, ?,
                COUNT(*),
                SUM(CASE WHEN severity NOT IN ('operational', 'unknown') THEN 1 ELSE 0 END),
                SUM(CASE WHEN severity = 'unknown' THEN 1 ELSE 0 END),
                ?
           FROM snapshot
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
