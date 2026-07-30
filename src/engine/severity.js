/**
 * Severity vocabulary and ordering.
 *
 * Runtime-agnostic: no Worker, GCP, or Apps Script APIs. Pure functions only.
 *
 * Resolves audit finding M1. The predecessor collapsed every vendor state into
 * a binary `Operational | Degraded`, which discarded the gradations Statuspage
 * already publishes. Two consequences: a total outage and a cosmetic blip
 * rendered identically, and severity-ordered sorting was impossible because the
 * severity had been thrown away before it reached storage.
 */

/**
 * @typedef {'major_outage'|'partial_outage'|'degraded'|'unknown'|'maintenance'|'operational'} Severity
 */

/** @type {Readonly<Record<string, Severity>>} */
export const SEVERITY = Object.freeze({
  MAJOR_OUTAGE: 'major_outage',
  PARTIAL_OUTAGE: 'partial_outage',
  DEGRADED: 'degraded',
  UNKNOWN: 'unknown',
  MAINTENANCE: 'maintenance',
  OPERATIONAL: 'operational',
});

/**
 * Ordinal rank. Higher is more severe; this is the sort key.
 *
 * Two placements are deliberate and worth stating:
 *
 * - `UNKNOWN` outranks `OPERATIONAL`. A check that failed is not evidence of
 *   health. Ranking them equal would recreate audit finding H4, where a network
 *   error rendered as a green row.
 * - `UNKNOWN` outranks `MAINTENANCE`. Planned maintenance is a *known*, benign
 *   state; "we could not reach the vendor" is genuine uncertainty and deserves
 *   more of the reader's attention.
 *
 * @type {Readonly<Record<Severity, number>>}
 */
const RANK = Object.freeze({
  [SEVERITY.MAJOR_OUTAGE]: 5,
  [SEVERITY.PARTIAL_OUTAGE]: 4,
  [SEVERITY.DEGRADED]: 3,
  [SEVERITY.UNKNOWN]: 2,
  [SEVERITY.MAINTENANCE]: 1,
  [SEVERITY.OPERATIONAL]: 0,
});

/**
 * @param {Severity} severity
 * @returns {number} ordinal rank; unrecognised input ranks as UNKNOWN
 */
export function rank(severity) {
  return RANK[severity] ?? RANK[SEVERITY.UNKNOWN];
}

/**
 * Vendor vocabularies mapped onto the enum.
 *
 * Statuspage speaks two dialects and they overlap confusingly: `components[].status`
 * uses `major_outage`/`partial_outage`/..., while page-level `status.indicator`
 * uses `critical`/`major`/`minor`/`none`. Note `major` (indicator) is NOT
 * `major_outage` (component) — the indicator's `critical` is the total-outage
 * signal. Getting that backwards would systematically over- or under-report
 * every Statuspage vendor.
 *
 * @type {Readonly<Record<string, Severity>>}
 */
const VOCABULARY = Object.freeze({
  // components[].status
  major_outage: SEVERITY.MAJOR_OUTAGE,
  partial_outage: SEVERITY.PARTIAL_OUTAGE,
  degraded_performance: SEVERITY.DEGRADED,
  under_maintenance: SEVERITY.MAINTENANCE,
  operational: SEVERITY.OPERATIONAL,

  // status.indicator
  critical: SEVERITY.MAJOR_OUTAGE,
  major: SEVERITY.PARTIAL_OUTAGE,
  minor: SEVERITY.DEGRADED,
  maintenance: SEVERITY.MAINTENANCE,
  none: SEVERITY.OPERATIONAL,
});

/**
 * Normalize a vendor-supplied status string.
 *
 * Fails closed: anything unrecognised, empty, or nullish becomes `UNKNOWN`,
 * never `OPERATIONAL`. A vendor that renames a status value must surface as
 * uncertainty rather than silently reporting health (audit findings H4, M2).
 *
 * @param {unknown} raw
 * @returns {Severity}
 */
export function normalizeSeverity(raw) {
  if (typeof raw !== 'string') return SEVERITY.UNKNOWN;
  const key = raw.trim().toLowerCase();
  return VOCABULARY[key] ?? SEVERITY.UNKNOWN;
}

/**
 * Most severe of a set. An empty set is operational — nothing wrong was found.
 *
 * @param {Severity[]} severities
 * @returns {Severity}
 */
export function worst(severities) {
  let result = SEVERITY.OPERATIONAL;
  for (const s of severities) {
    if (rank(s) > rank(result)) result = s;
  }
  return result;
}

/**
 * Comparator implementing the requested ordering: most severe first, then
 * vendor name A-Z. Case-insensitive so `zapier` does not sort after `Zoom`.
 *
 * @param {{vendor: string, severity: Severity}} a
 * @param {{vendor: string, severity: Severity}} b
 * @returns {number}
 */
export function compareRecords(a, b) {
  const bySeverity = rank(b.severity) - rank(a.severity);
  if (bySeverity !== 0) return bySeverity;
  return String(a.vendor).localeCompare(String(b.vendor), 'en', { sensitivity: 'base' });
}
