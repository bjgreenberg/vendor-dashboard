/**
 * Oracle Cloud Infrastructure adapter — ocistatus.oraclecloud.com.
 *
 * Two endpoints exist and the choice between them matters:
 *
 *   /api/v2/status.json          173 B, page-level indicator ONLY, no services
 *   /api/v2/components_v2.json   1.63 MB, 90 regions x 97 services
 *
 * The first was used initially because it is Atlassian-Statuspage-shaped and
 * needed no code. It produced a row with ZERO components — technically correct
 * and useless, because a reader cannot see WHICH Oracle service is affected.
 *
 * This adapter uses the second. Measured on the real payload, `JSON.parse`
 * costs 3.17 ms — affordable against the 10 ms free-plan budget, unlike IBM's
 * 2.44 MB document which needed a targeted scan. Measure before assuming;
 * these two payloads are similar sizes and land on opposite sides of the line
 * because Oracle's is a flatter structure.
 *
 * SERVICES, NOT REGIONS. The payload is 8,730 region-service pairs across 90
 * regions. Emitting those directly would repeat the points-of-presence problem
 * already solved for Zoom, NetSuite, Docusign, Jamf, OutSystems and Azure
 * DevOps: a reader wants to know that Object Storage is degraded, not that it
 * is degraded in each of eleven regions. Each service therefore appears ONCE,
 * carrying the worst status across every region, with the affected regions
 * named in its description.
 */

import { SEVERITY, worst, rank } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://ocistatus.oraclecloud.com/';
const SERVICE_LABEL = 'Oracle Cloud (OCI)';

/**
 * Oracle's vocabulary. Unrecognised values fail closed to UNKNOWN so a renamed
 * status surfaces as uncertainty rather than silently reading healthy.
 */
const STATUS = Object.freeze(
  Object.assign(Object.create(null), {
    normalperformance: SEVERITY.OPERATIONAL,
    normal: SEVERITY.OPERATIONAL,
    available: SEVERITY.OPERATIONAL,
    operational: SEVERITY.OPERATIONAL,
    informational: SEVERITY.OPERATIONAL,
    degradedperformance: SEVERITY.DEGRADED,
    degraded: SEVERITY.DEGRADED,
    performanceissue: SEVERITY.DEGRADED,
    partialservicedisruption: SEVERITY.PARTIAL_OUTAGE,
    partialoutage: SEVERITY.PARTIAL_OUTAGE,
    servicedisruption: SEVERITY.MAJOR_OUTAGE,
    majoroutage: SEVERITY.MAJOR_OUTAGE,
    unavailable: SEVERITY.MAJOR_OUTAGE,
    maintenance: SEVERITY.MAINTENANCE,
    plannedmaintenance: SEVERITY.MAINTENANCE,
  }),
);

/** @param {unknown} raw */
export function oracleSeverityOf(raw) {
  const key = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return key ? (STATUS[key] ?? SEVERITY.UNKNOWN) : SEVERITY.UNKNOWN;
}

/**
 * @param {any} payload parsed components_v2.json
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseOracle(payload, options) {
  const { vendor, now } = options ?? {};
  const opts = { now, sourceUrl: SOURCE_URL, service: SERVICE_LABEL };

  const regions = payload?.regionHealthReports;
  if (!Array.isArray(regions) || regions.length === 0) {
    return unknownRecord(vendor, 'payload had no regionHealthReports', opts);
  }

  /** @type {Map<string, {severity: string, bad: string[]}>} */
  const services = new Map();

  for (const region of regions) {
    const regionName = toPlainText(region?.regionName ?? region?.regionId ?? '');
    for (const s of region?.serviceHealthReports ?? []) {
      const name = toPlainText(s?.serviceName ?? '');
      if (!name) continue;
      const severity = oracleSeverityOf(s?.serviceStatus);

      const entry = services.get(name) ?? { severity: SEVERITY.OPERATIONAL, bad: [] };
      if (rank(severity) > rank(entry.severity)) entry.severity = severity;
      if (severity !== SEVERITY.OPERATIONAL && regionName) entry.bad.push(regionName);
      services.set(name, entry);
    }
  }

  if (services.size === 0) {
    return unknownRecord(vendor, 'payload contained no service health reports', opts);
  }

  const components = [...services.entries()]
    .map(([name, v]) => ({
      name,
      severity: v.severity,
      // Regions belong in the DESCRIPTION, never the name: naming them would
      // recreate the points-of-presence list this roll-up exists to remove.
      description: v.bad.length
        ? `Affected regions: ${[...new Set(v.bad)].slice(0, 6).join(', ')}${v.bad.length > 6 ? '…' : ''}.`
        : '',
    }))
    .sort((a, b) => rank(b.severity) - rank(a.severity) || a.name.localeCompare(b.name));

  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  return makeRecord({
    vendor,
    service: SERVICE_LABEL,
    severity: worst(components.map((c) => c.severity)),
    incidentName: unhealthy.length ? 'Service issue' : '',
    description: unhealthy.length
      ? `Affected: ${unhealthy.slice(0, 4).map((c) => c.name).join(', ')}.`
      : `All ${components.length} services report normal performance.`,
    sourceUrl: SOURCE_URL,
    components,
    warnings: [],
    now,
  });
}
