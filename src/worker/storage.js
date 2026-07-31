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
  const statements = [
    db.prepare('DELETE FROM snapshot'),
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
    db
      .prepare(
        `INSERT INTO run_meta (id, checked_at, total, impacted, unknown, warnings)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           checked_at = excluded.checked_at,
           total      = excluded.total,
           impacted   = excluded.impacted,
           unknown    = excluded.unknown,
           warnings   = excluded.warnings`,
      )
      .bind(run.checkedAt, run.total, run.impacted, run.unknown, JSON.stringify(run.warnings ?? [])),
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
