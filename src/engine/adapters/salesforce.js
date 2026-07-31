/**
 * Salesforce product status adapter (used for Tableau).
 *
 * Source: https://api.status.salesforce.com/v1/products/<Product>
 * Shape: `{ key, name, Instances: [...] }` where each instance carries
 * `environment`, `isActive`, `status` and a location.
 *
 * Only ACTIVE PRODUCTION instances count. Sandbox and retired instances would
 * otherwise raise false alarms about environments nobody uses.
 *
 * COMPONENTS: Salesforce publishes a product as a set of per-region INSTANCES
 * ("10AYPD", "DUB01PD") with no sub-service breakdown. Listing raw instance keys
 * is infrastructure noise — 21 rows of opaque identifiers.
 *
 * They do, however, carry a `location`, and grouping by it produces something a
 * reader can use: NA, EMEA, APAC — regional availability, worst status per
 * region. That is the honest middle ground between 21 instance keys and nothing
 * at all. Set `exposeInstances` to list the raw instances instead.
 */

import { SEVERITY, rank } from '../severity.js';
import { makeRecord, unknownRecord } from '../record.js';

const SOURCE_URL = 'https://status.salesforce.com';

/**
 * @param {any} payload
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseSalesforce(payload, options) {
  const { vendor, exposeInstances = false, now } = options ?? {};
  if (!payload || !Array.isArray(payload.Instances)) {
    return unknownRecord(vendor, 'payload had no Instances array', { now, sourceUrl: SOURCE_URL });
  }

  const production = payload.Instances.filter(
    (i) => i?.environment === 'production' && i?.isActive === true,
  );

  if (production.length === 0) {
    return unknownRecord(vendor, 'no active production instances found', { now, sourceUrl: SOURCE_URL });
  }

  const severityOfInstance = (i) =>
    String(i?.status ?? '').toUpperCase() === 'OK'
      ? SEVERITY.OPERATIONAL
      : /MAJOR|OUTAGE/i.test(String(i.status))
        ? SEVERITY.MAJOR_OUTAGE
        : SEVERITY.PARTIAL_OUTAGE;

  const instances = production.map((i) => ({
    name: `${i.location ?? 'Unknown'} (${i.key ?? '?'})`,
    severity: severityOfInstance(i),
    description: `Instance status: ${i.status}.`,
  }));

  // Group by region, worst status wins: 21 opaque instance keys become NA /
  // EMEA / APAC, which is what a reader can actually act on.
  const byRegion = new Map();
  for (const i of production) {
    const region = String(i?.location ?? 'Unknown');
    const sev = severityOfInstance(i);
    const prev = byRegion.get(region);
    if (!prev || rank(sev) > rank(prev.severity)) {
      byRegion.set(region, {
        name: region,
        severity: sev,
        description: `${production.filter((x) => x.location === region).length} production instances.`,
      });
    }
  }
  const components = exposeInstances ? instances : [...byRegion.values()];
  const degraded = instances.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  if (degraded.length === 0) {
    return makeRecord({
      vendor,
      service: payload.name ?? vendor,
      severity: SEVERITY.OPERATIONAL,
      description: `All ${production.length} production instances operational.`,
      sourceUrl: SOURCE_URL,
      components,
      now,
    });
  }

  return makeRecord({
    vendor,
    service: payload.name ?? vendor,
    severity: degraded.some((c) => c.severity === SEVERITY.MAJOR_OUTAGE)
      ? SEVERITY.MAJOR_OUTAGE
      : SEVERITY.PARTIAL_OUTAGE,
    incidentName: 'Instance issue',
    description: `${degraded.length} of ${production.length} production instances affected.`,
    sourceUrl: SOURCE_URL,
    components,
    now,
  });
}
