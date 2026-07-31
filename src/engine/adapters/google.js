/**
 * Google Workspace / Cloud status adapter.
 *
 * Source: https://www.google.com/appsstatus/dashboard/incidents.json
 * Shape: a top-level ARRAY of incidents, each naming one `service_name`
 * (Gmail, Drive, Gemini, Google Voice...). There is no component list, so the
 * per-product children are derived from the open incidents themselves.
 */

import { SEVERITY } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://www.google.com/appsstatus/dashboard';

/** Statuses that mean "nothing wrong right now". */
const CLEARED = new Set(['AVAILABLE', 'RESOLVED', 'SERVICE_INFORMATION']);

/**
 * `status_impact` is the incident's peak historical impact; the live state is
 * on `most_recent_update.status`. Reading the wrong one reports resolved
 * incidents as ongoing forever.
 * @param {any} incident
 * @returns {string}
 */
function liveStatus(incident) {
  return String(incident?.most_recent_update?.status ?? incident?.status_impact ?? '').toUpperCase();
}

/**
 * @param {any} incident
 * @returns {import('../severity.js').Severity}
 */
function severityOf(incident) {
  const s = liveStatus(incident);
  if (s === 'SERVICE_OUTAGE') return SEVERITY.MAJOR_OUTAGE;
  if (s === 'SERVICE_DISRUPTION') return SEVERITY.PARTIAL_OUTAGE;
  return SEVERITY.DEGRADED;
}

/**
 * @param {any} payload parsed incidents.json (array)
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseGoogle(payload, options) {
  const { vendor, now } = options ?? {};
  const incidents = Array.isArray(payload) ? payload : payload?.incidents;
  if (!Array.isArray(incidents)) {
    return unknownRecord(vendor, 'payload was not an incident array', { now, sourceUrl: SOURCE_URL });
  }

  const open = incidents.filter((i) => !CLEARED.has(liveStatus(i)));

  // One child per affected product; keep the worst if a product appears twice.
  /** @type {Map<string, {name: string, severity: any, description: string}>} */
  const byService = new Map();
  for (const i of open) {
    const name = String(i?.service_name ?? 'Unknown service');
    const sev = severityOf(i);
    const existing = byService.get(name);
    if (!existing) {
      byService.set(name, {
        name,
        severity: sev,
        description: toPlainText(i?.most_recent_update?.text ?? i?.external_desc ?? ''),
      });
    }
  }
  const components = [...byService.values()];

  if (open.length === 0) {
    return makeRecord({
      vendor,
      severity: SEVERITY.OPERATIONAL,
      description: 'All services normal.',
      sourceUrl: SOURCE_URL,
      now,
    });
  }

  const primary = open[0];
  return makeRecord({
    vendor,
    severity: components.reduce(
      (acc, c) => (acc === SEVERITY.MAJOR_OUTAGE ? acc : c.severity),
      components[0]?.severity ?? SEVERITY.DEGRADED,
    ),
    incidentName: toPlainText(primary?.external_desc ?? '') || 'Service incident',
    description:
      toPlainText(primary?.most_recent_update?.text ?? primary?.external_desc ?? '') ||
      'Active incident reported by Google.',
    sourceUrl: SOURCE_URL,
    components,
    now,
  });
}
