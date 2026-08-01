/**
 * Concur per-service status, from `open.concur.com/api/open/status_history`.
 *
 * REPLACES the incidents feed, which is 23.3 MB — the complete incident history
 * back to 2013, re-downloaded and re-parsed every cycle to find the handful
 * that are open. No filter exists: `?open=true`, `?status=open`, `?limit=25`
 * and `?days=7` all return the identical 23,354,922 bytes. Parsing it measured
 * 69 ms of CPU against a 10 ms per-invocation ceiling, and was the single
 * largest contributor to the 2026-08-01 outage.
 *
 * status_history was found in the status page's network log. It is keyed by
 * SERVICE and carries a `Current Status` for each, which is exactly what the
 * board needs, at 35–300 KB per data centre.
 *
 * Shape:
 *   { data: { Expense: { Service: "Expense",
 *                        "Current Status": { status: "normal", incidents: [] },
 *                        "2026-08-01T-0500": {...} } } }
 *
 * ALL FOUR data centres are read and merged, worst-wins. Reading only us2
 * would report Concur healthy while EU customers were down — the false green
 * this project exists to prevent — and the four together are still 38x cheaper
 * than the feed they replace.
 */

import { SEVERITY, worst, rank } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://open.concur.com/';
const SERVICE_LABEL = 'Concur';

/** Concur's vocabulary. Anything unrecognised fails closed. */
const STATUS = Object.freeze(
  Object.assign(Object.create(null), {
    normal: SEVERITY.OPERATIONAL,
    operational: SEVERITY.OPERATIONAL,
    available: SEVERITY.OPERATIONAL,
    degraded: SEVERITY.DEGRADED,
    degradation: SEVERITY.DEGRADED,
    warning: SEVERITY.DEGRADED,
    partial: SEVERITY.PARTIAL_OUTAGE,
    major: SEVERITY.MAJOR_OUTAGE,
    outage: SEVERITY.MAJOR_OUTAGE,
    unavailable: SEVERITY.MAJOR_OUTAGE,
    maintenance: SEVERITY.MAINTENANCE,
  }),
);

/** @param {unknown} raw */
export function concurSeverityOf(raw) {
  const key = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return key ? (STATUS[key] ?? SEVERITY.UNKNOWN) : SEVERITY.UNKNOWN;
}

/**
 * @param {any} payloads one parsed status_history document per data centre
 * @param {{vendor: string, banner?: any, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseConcurStatus(payloads, options) {
  const { vendor, banner, now } = options ?? {};
  const opts = { now, sourceUrl: SOURCE_URL, service: SERVICE_LABEL };

  const docs = (Array.isArray(payloads) ? payloads : [payloads]).filter(
    (d) => d && typeof d === 'object' && d.data && typeof d.data === 'object',
  );
  if (docs.length === 0) {
    return unknownRecord(vendor, 'no usable status_history payload', opts);
  }

  /** @type {Map<string, {severity: string, bad: string[]}>} */
  const services = new Map();
  for (const doc of docs) {
    for (const [name, entry] of Object.entries(doc.data)) {
      const current = entry?.['Current Status'];
      if (!current) continue;
      const severity = concurSeverityOf(current.status);
      const clean = toPlainText(entry?.Service ?? name);
      const prev = services.get(clean) ?? { severity: SEVERITY.OPERATIONAL, bad: [] };
      if (rank(severity) > rank(prev.severity)) prev.severity = severity;
      if (severity !== SEVERITY.OPERATIONAL) prev.bad.push(String(current.status ?? ''));
      services.set(clean, prev);
    }
  }

  if (services.size === 0) {
    return unknownRecord(vendor, 'status_history carried no services', opts);
  }

  const components = [...services.entries()]
    .map(([name, v]) => ({ name, severity: v.severity, description: '' }))
    .sort((a, b) => rank(b.severity) - rank(a.severity) || a.name.localeCompare(b.name));

  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  // Concur's own banner is a "something is wrong" flag; treat it as a FLOOR so
  // a problem announced there is never reported as fully healthy.
  const bannerActive = banner?.data?.display === true;
  const severity = worst([
    ...components.map((c) => c.severity),
    bannerActive ? SEVERITY.DEGRADED : SEVERITY.OPERATIONAL,
  ]);

  return makeRecord({
    vendor,
    service: SERVICE_LABEL,
    severity,
    incidentName: unhealthy.length ? 'Service issue' : bannerActive ? 'Status banner displayed' : '',
    description: unhealthy.length
      ? `Affected: ${unhealthy.map((c) => c.name).join(', ')}.`
      : bannerActive
        ? 'Concur is displaying a status banner.'
        : `All ${components.length} services report normal.`,
    sourceUrl: SOURCE_URL,
    components,
    warnings: [],
    now,
  });
}
