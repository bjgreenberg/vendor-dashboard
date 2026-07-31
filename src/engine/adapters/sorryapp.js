/**
 * SorryApp status-page adapter (used for iorad).
 *
 * Source: <status host>/api/v1/status.json
 * Shape: `{ page: { state, name, url, links: {...} } }` where `state` is the
 * single overall signal.
 */

import { SEVERITY, normalizeSeverity } from '../severity.js';
import { makeRecord, unknownRecord } from '../record.js';

/**
 * @param {any} payload
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseSorryApp(payload, options) {
  const { vendor, now } = options ?? {};
  const page = payload?.page;
  if (!page || typeof page.state !== 'string') {
    return unknownRecord(vendor, 'payload had no page.state', { now });
  }

  const sourceUrl = typeof page.url === 'string' ? page.url : '';

  if (page.state.toLowerCase() === 'operational') {
    return makeRecord({
      vendor,
      severity: SEVERITY.OPERATIONAL,
      description: 'Systems operational.',
      sourceUrl,
      now,
    });
  }

  // Any non-operational state maps through the shared vocabulary; an
  // unrecognised state becomes UNKNOWN rather than silently healthy.
  const severity = normalizeSeverity(page.state);
  return makeRecord({
    vendor,
    severity: severity === SEVERITY.OPERATIONAL ? SEVERITY.DEGRADED : severity,
    incidentName: typeof page.state_text === 'string' ? page.state_text : 'Active issue',
    description: page.state_text || `Vendor reports state: ${page.state}.`,
    sourceUrl,
    now,
  });
}
