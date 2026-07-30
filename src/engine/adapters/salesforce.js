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

  const degraded = production.filter((i) => String(i?.status ?? '').toUpperCase() !== 'OK');

  if (degraded.length === 0) {
    return makeRecord({
      vendor,
      service: payload.name ?? vendor,
      severity: SEVERITY.OPERATIONAL,
      description: `All ${production.length} production instances operational.`,
      sourceUrl: SOURCE_URL,
      now,
    });
  }

  const components = degraded.map((i) => ({
    name: `${i.location ?? 'Unknown'} (${i.key ?? '?'})`,
    severity: /MAJOR|OUTAGE/i.test(String(i.status)) ? SEVERITY.MAJOR_OUTAGE : SEVERITY.PARTIAL_OUTAGE,
    description: `Instance status: ${i.status}.`,
  }));

  return makeRecord({
    vendor,
    service: payload.name ?? vendor,
    severity: components.some((c) => c.severity === SEVERITY.MAJOR_OUTAGE)
      ? SEVERITY.MAJOR_OUTAGE
      : SEVERITY.PARTIAL_OUTAGE,
    incidentName: 'Instance issue',
    description: `${degraded.length} of ${production.length} production instances affected.`,
    sourceUrl: SOURCE_URL,
    components,
    now,
  });
}
