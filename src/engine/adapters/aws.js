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

import { SEVERITY, worst, rank } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';
import AWS_SERVICES from '../../../config/aws-services.json';

const SOURCE_URL = 'https://health.aws.amazon.com/health/status';
// Label carries BOTH names deliberately. The dashboard filter indexes the
// vendor and service labels, so a row named only "Amazon Web Services" cannot
// be found by typing "AWS" -- which is what everyone actually calls it, and
// what it was asked for by. Reported 2026-08-01: the row was on the board,
// degraded, and still looked missing.
const SERVICE_LABEL = 'AWS (Amazon Web Services)';

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

/**
 * A readable excerpt of a long AWS log message.
 *
 * NOT the first sentence. AWS opens with boilerplate -- "We are providing an
 * update on the ongoing service disruption." -- and the substance is in the
 * NEXT sentence: "The Middle East (UAE) Region (ME-CENTRAL-1) has suffered
 * damage... and is currently unable to reliably support customer
 * applications." A first-sentence excerpt produced two impacted regions
 * described identically and uselessly.
 *
 * A fixed window keeps both regions' detail inside one description, and cuts
 * on a word boundary so it does not end mid-token.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function excerpt(text, limit = 240) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const at = cut.lastIndexOf(' ');
  return `${(at > limit * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Newest message from an event's log.
 *
 * Entries are ordered oldest-first and carry a unix `timestamp`; the newest is
 * the current state of the incident, and the oldest is usually a generic "we
 * are investigating". Picking by timestamp rather than position survives AWS
 * reordering them.
 *
 * @param {any} event
 * @returns {string}
 */
function latestLogMessage(event) {
  const log = Array.isArray(event?.event_log) ? event.event_log : [];
  let best = null;
  for (const entry of log) {
    const message = toPlainText(entry?.message ?? '');
    if (!message) continue;
    const at = Number(entry?.timestamp) || 0;
    if (!best || at >= best.at) best = { at, message };
  }
  return best?.message ?? '';
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

  // The catalogue, so the row lists SERVICES even when nothing is wrong.
  // currentevents publishes only ACTIVE events, so without this AWS showed no
  // services at all on a healthy day -- the same gap found on Oracle, IBM,
  // Concur, Seismic, Iorad and Stormboard.
  // Catalogue comes from a BUILD-TIME snapshot (config/aws-services.json),
  // not a live fetch.
  //
  // The live document is 1.25 MB of 5,848 service-region pairs; reading it in
  // the collector cost a subrequest and ~1.7 ms of CPU every cycle, against a
  // 10 ms per-invocation ceiling that production was already exceeding. The
  // list of AWS services changes when AWS launches one, so it does not need
  // re-reading every fifteen minutes. Refresh with
  // `node scripts/fetch-aws-catalogue.mjs`.
  const catalogue = Array.isArray(AWS_SERVICES?.services) ? AWS_SERVICES.services : [];

  // SERVICES, not regions.
  //
  // AWS events are per service PER REGION, so the same service appears once
  // for every region it is degraded in. Naming components "S3 — Bahrain"
  // turned the row into a list of points of presence, which is the same
  // problem already solved for Zoom, NetSuite, Docusign, OutSystems, Azure
  // DevOps and Oracle: a reader wants to know WHICH SERVICE is affected, and
  // the region is detail that belongs in the description.
  //
  // Each service therefore appears once, carrying the worst severity across
  // its regions, with the affected regions listed underneath it.
  const byService = new Map();
  for (const e of active) {
    const name = toPlainText(e?.service_name ?? '') || 'AWS';
    const region = toPlainText(e?.region_name ?? '');
    const severity = awsSeverityOf(e?.summary);
    const entry = byService.get(name) ?? { severity: SEVERITY.OPERATIONAL, regions: [], details: [] };
    if (rank(severity) > rank(entry.severity)) entry.severity = severity;
    if (region) entry.regions.push(region);

    // Per-region DETAIL, from the newest event_log entry.
    //
    // The top-level `summary` is a headline ("Increased Error Rates") and says
    // nothing about what is actually broken. AWS's real information is in the
    // event log: "connectivity and power issues affecting APIs and instances
    // in a single Availability Zone (mec1-az2)". Reported 2026-08-01 -- the row
    // named two impacted things and described neither.
    //
    // This matters most for MULTIPLE_SERVICES events, where AWS deliberately
    // does not enumerate services because the incident is region- or
    // AZ-wide. The log message is the only place the scope is stated.
    const latest = excerpt(latestLogMessage(e)) || toPlainText(e?.summary ?? '');
    const detail = `${region ? `${region} — ` : ''}${latest}`;
    if (detail && !entry.details.includes(detail)) entry.details.push(detail);
    byService.set(name, entry);
  }

  // Each affected region contributes ONE sentence. A single event's latest log
  // message can run to several hundred characters, so joining them whole meant
  // the second region was truncated away entirely -- the row named two impacted
  // regions and described only the first.
  const describe = (v) => v.details.join('  ·  ').slice(0, 600);

  const components = [];
  for (const name of catalogue) {
    const hit = byService.get(name);
    components.push({
      name,
      severity: hit ? hit.severity : SEVERITY.OPERATIONAL,
      description: hit ? describe(hit) : '',
    });
  }
  // An event naming a service absent from the catalogue must still appear --
  // AWS labels multi-service incidents "Multiple services", which is not a
  // catalogue entry, and dropping it would hide a real outage.
  for (const [name, v] of byService) {
    if (!components.some((c) => c.name === name)) {
      components.push({ name, severity: v.severity, description: describe(v) });
    }
  }
  components.sort((a, b) => rank(b.severity) - rank(a.severity) || a.name.localeCompare(b.name));

  if (active.length === 0) {
    return makeRecord({
      vendor,
      service: SERVICE_LABEL,
      severity: SEVERITY.OPERATIONAL,
      description: components.length
        ? `All ${components.length} services report no active events.`
        : 'No active AWS service events are published.',
      sourceUrl: SOURCE_URL,
      components,
      warnings: [],
      now,
    });
  }

  return makeRecord({
    vendor,
    service: SERVICE_LABEL,
    severity: worst(components.map((c) => c.severity)),
    incidentName: toPlainText(active[0]?.summary ?? 'Service event').slice(0, 120),
    // Name the AFFECTED services, not the first few components. Once the
    // catalogue was added, `components` became all 268 services sorted worst
    // first, so slicing it listed healthy ones as though they were impacted.
    description: `${active.length} active event${active.length === 1 ? '' : 's'}: ${[...byService.keys()]
      .slice(0, 4)
      .join(', ')}.`,
    sourceUrl: SOURCE_URL,
    components,
    warnings: [],
    now,
  });
}
