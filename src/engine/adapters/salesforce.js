/**
 * Salesforce product status adapter (used for Tableau).
 *
 * Source: https://api.status.salesforce.com/v1/products/<Product>
 * Shape: `{ key, name, Instances: [...] }` where each instance carries
 * `environment`, `isActive`, `status` and a location.
 *
 * Only ACTIVE PRODUCTION instances count. Sandbox and retired instances would
 * otherwise raise false alarms about environments nobody uses.
 */

import { SEVERITY } from '../severity.js';
import { makeRecord, unknownRecord } from '../record.js';

const SOURCE_URL = 'https://status.salesforce.com';

/**
 * @param {any} payload
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseSalesforce(payload, options) {
  const { vendor, now } = options ?? {};
  if (!payload || !Array.isArray(payload.Instances)) {
    return unknownRecord(vendor, 'payload had no Instances array', { now, sourceUrl: SOURCE_URL });
  }

  const production = payload.Instances.filter(
    (i) => i?.environment === 'production' && i?.isActive === true,
  );

  if (production.length === 0) {
    return unknownRecord(vendor, 'no active production instances found', { now, sourceUrl: SOURCE_URL });
  }

  // Every active production instance, healthy included, so the dashboard can
  // disclose the full regional list on demand.
  const components = production.map((i) => {
    const ok = String(i?.status ?? '').toUpperCase() === 'OK';
    return {
      name: `${i.location ?? 'Unknown'} (${i.key ?? '?'})`,
      severity: ok
        ? SEVERITY.OPERATIONAL
        : /MAJOR|OUTAGE/i.test(String(i.status))
          ? SEVERITY.MAJOR_OUTAGE
          : SEVERITY.PARTIAL_OUTAGE,
      description: `Instance status: ${i.status}.`,
    };
  });
  const degraded = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

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
