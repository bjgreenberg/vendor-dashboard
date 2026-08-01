/**
 * SorryApp status-page adapter (used for iorad).
 *
 * Source: <status host>/api/v1/status.json
 * Shape: `{ page: { state, name, url, links: {...} } }` where `state` is the
 * single overall signal.
 */

import { SEVERITY, normalizeSeverity, worst, rank } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

/**
 * SorryApp publishes components on a SEPARATE endpoint, advertised in the page
 * payload as `links.components.href`. collect.js fetches it when a
 * `componentsUrl` is configured and attaches the array as `payload.components`.
 *
 * Names REPEAT — iorad lists two "iorad editor" and two "iorad player" entries,
 * one per environment. Deduping by name keeping the worst avoids a list that
 * shows the same service twice with different statuses, which reads as a bug.
 *
 * @param {any[]} list
 * @returns {{name: string, severity: string, description: string}[]}
 */
function toComponents(list) {
  const byName = new Map();
  for (const c of list) {
    const name = toPlainText(c?.name ?? '');
    if (!name) continue;
    const severity = normalizeSeverity(c?.state ?? c?.status);
    const prev = byName.get(name);
    if (!prev || rank(severity) > rank(prev.severity)) {
      byName.set(name, { name, severity, description: '' });
    }
  }
  return [...byName.values()];
}

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
  const components = Array.isArray(payload?.components) ? toComponents(payload.components) : [];

  if (page.state.toLowerCase() === 'operational') {
    // Components can still disagree with a green page-level state, so the row
    // takes the worst of the two rather than trusting the summary.
    const severity = components.length
      ? worst([SEVERITY.OPERATIONAL, ...components.map((c) => c.severity)])
      : SEVERITY.OPERATIONAL;
    const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);
    return makeRecord({
      vendor,
      severity,
      incidentName: unhealthy.length ? 'Component issue' : '',
      description: unhealthy.length
        ? `Affected: ${unhealthy.map((c) => c.name).join(', ')}.`
        : components.length
          ? `All ${components.length} components operational.`
          : 'Systems operational.',
      sourceUrl,
      components,
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
    components,
    now,
  });
}
