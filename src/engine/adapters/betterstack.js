/**
 * Better Stack status-page adapter (used for Stormboard).
 *
 * Resolves audit finding H6. Stormboard migrated off Atlassian Statuspage to
 * Better Stack, so the configured `/api/v2/summary.json` now returns HTML. The
 * predecessor's HTML fallback tested:
 *
 *     /\boperational\b/i.test(html)
 *
 * against the WHOLE document. That word appears 7 times in Better Stack's
 * markup regardless of actual status, so Stormboard reported Operational
 * unconditionally for an unknown period.
 *
 * Better Stack exposes no machine-readable API on a public status page
 * (`index.json`, `status.json`, `api/v2/summary.json` all serve HTML;
 * `badge.json` advertises JSON but returns a badge widget -- all verified
 * 2026-07-30). So this parses the ONE structural marker the page carries:
 *
 *     class="status-page__overview-icon status-page__overview-icon--<state>"
 *
 * and fails closed when that marker is absent. Never reintroduce a loose
 * document-wide word match.
 */

import { SEVERITY } from '../severity.js';
import { makeRecord, unknownRecord } from '../record.js';

/** Better Stack's overview modifier -> our vocabulary. */
const STATE = Object.freeze({
  operational: SEVERITY.OPERATIONAL,
  downtime: SEVERITY.MAJOR_OUTAGE,
  degraded: SEVERITY.DEGRADED,
  maintenance: SEVERITY.MAINTENANCE,
});

const MARKER = /status-page__overview-icon--([a-z_]+)/i;

/**
 * @param {unknown} html raw page HTML
 * @param {{vendor: string, sourceUrl?: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseBetterStack(html, options) {
  const { vendor, sourceUrl = '', now } = options ?? {};
  if (typeof html !== 'string') {
    return unknownRecord(vendor, 'input was not HTML', { now, sourceUrl });
  }

  const match = html.match(MARKER);
  if (!match) {
    return unknownRecord(
      vendor,
      'Better Stack overview marker not found; page structure may have changed',
      { now, sourceUrl },
    );
  }

  const state = match[1].toLowerCase();
  const severity = STATE[state];

  if (severity === undefined) {
    return unknownRecord(vendor, `unrecognised Better Stack state "${state}"`, { now, sourceUrl });
  }

  return makeRecord({
    vendor,
    severity,
    description:
      severity === SEVERITY.OPERATIONAL
        ? 'Systems operational.'
        : `Vendor status page reports: ${state}.`,
    incidentName: severity === SEVERITY.OPERATIONAL ? '' : 'Active issue',
    sourceUrl,
    now,
  });
}
