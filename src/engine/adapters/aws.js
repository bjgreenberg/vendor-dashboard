/**
 * AWS Health adapter — health.aws.amazon.com/public/currentevents.
 *
 * This is the feed behind the AWS Health Dashboard. It returns an array of
 * CURRENT events; an empty array means nothing is being reported.
 *
 * Two things about it are unusual and both bit on first contact:
 *
 * 1. It is served as `application/json;charset=utf-16` with a BOM. The fetch
 *    spec makes `response.text()` decode as UTF-8 unconditionally, so the body
 *    arrived as mojibake and every parse failed closed. Handled centrally in
 *    collect.js (`decodeBody`), not here.
 * 2. RESOLVED events stay in the feed. Filtering only on presence of an event
 *    would report AWS degraded over an incident that closed hours ago.
 *
 * Observed shape (2026-08-01):
 *   { status: "0", summary: "[RESOLVED] Elevated Packet Loss",
 *     end_time: 1785524075, service_name: "AWS Direct Connect",
 *     region_name: "Mumbai", event_log: [...] }
 *   { status: "3", summary: "Increased Error Rates", end_time: null,
 *     service_name: "Multiple services", region_name: "UAE" }
 *
 * An event is ACTIVE when it has no `end_time` and its summary is not marked
 * resolved. Both conditions are required: relying on `status` alone would mean
 * trusting an undocumented integer code, and relying on the text alone would
 * miss an event closed without the marker.
 */

import { SEVERITY, worst } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://health.aws.amazon.com/health/status';
const SERVICE_LABEL = 'Amazon Web Services';

/**
 * Classify an active event from its summary.
 *
 * AWS writes these as prose. Anything active but unclassifiable is DEGRADED,
 * never operational: the event exists, so something is being reported, and
 * falling through to healthy because the wording is unfamiliar would be the
 * false green this project exists to prevent.
 *
 * @param {string} summary
 * @returns {import('../severity.js').Severity}
 */
export function awsSeverityOf(summary) {
  const s = String(summary ?? '').toLowerCase();
  if (/unavailab|outage|down|not able to|failure/.test(s)) return SEVERITY.MAJOR_OUTAGE;
  if (/degrad|elevated|increased error|packet loss|latency|delay|impair|slow/.test(s)) {
    return SEVERITY.DEGRADED;
  }
  if (/maintenance/.test(s)) return SEVERITY.MAINTENANCE;
  if (/informational|advisory/.test(s)) return SEVERITY.DEGRADED;
  return SEVERITY.DEGRADED;
}

/** @param {any} e */
function isActive(e) {
  const resolved = /^\s*\[?resolved\]?/i.test(String(e?.summary ?? ''));
  const ended = e?.end_time !== null && e?.end_time !== undefined && e?.end_time !== '';
  return !resolved && !ended;
}

/**
 * @param {any} payload parsed currentevents array
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseAws(payload, options) {
  const { vendor, now } = options ?? {};
  const opts = { now, sourceUrl: SOURCE_URL, service: SERVICE_LABEL };

  const events = Array.isArray(payload) ? payload : payload?.events;
  if (!Array.isArray(events)) {
    return unknownRecord(vendor, 'payload was not an event array', opts);
  }

  const active = events.filter(isActive);

  if (active.length === 0) {
    return makeRecord({
      vendor,
      service: SERVICE_LABEL,
      severity: SEVERITY.OPERATIONAL,
      description: 'No active AWS service events are published.',
      sourceUrl: SOURCE_URL,
      components: [],
      warnings: [],
      now,
    });
  }

  // One component per active event, named service + region. AWS events are
  // inherently regional, and a reader needs to know WHERE before the row means
  // anything -- "Increased Error Rates" alone could be one region or all of them.
  const components = active.map((e) => {
    const service = toPlainText(e?.service_name ?? 'AWS');
    const region = toPlainText(e?.region_name ?? '');
    return {
      name: region ? `${service} — ${region}` : service,
      severity: awsSeverityOf(e?.summary),
      description: toPlainText(e?.summary ?? '').slice(0, 200),
    };
  });

  return makeRecord({
    vendor,
    service: SERVICE_LABEL,
    severity: worst(components.map((c) => c.severity)),
    incidentName: toPlainText(active[0]?.summary ?? 'Service event').slice(0, 120),
    description: `${active.length} active event${active.length === 1 ? '' : 's'}: ${components
      .map((c) => c.name)
      .slice(0, 3)
      .join(', ')}.`,
    sourceUrl: SOURCE_URL,
    components,
    warnings: [],
    now,
  });
}
