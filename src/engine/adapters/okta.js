/**
 * Okta status adapter.
 *
 * Okta runs its status page on Salesforce Experience Cloud. There is no public
 * JSON API — `status.okta.com/api/v2/summary.json`, `/index.json`,
 * `/history.atom` and `/history.rss` all return **401** (verified 2026-07-31) —
 * but the rendered page embeds its incident records as JSON: an array of
 * Salesforce `Incident__c` objects.
 *
 * This replaces an earlier implementation that read the legacy FeedBurner Atom
 * feed. That feed still returned 200, which is exactly what made it dangerous:
 * its newest entry was **456 days old**, so it reported "operational"
 * indefinitely while looking perfectly healthy. That is the same silent-rot
 * failure as audit findings H6 and H7, and it would have gone unnoticed for as
 * long as anyone trusted the row. The embedded source is current — its newest
 * incident was seven days old at the time of writing.
 *
 * PARSING NOTE: the page is ~347 KB and the Workers free plan allows 10 ms of
 * CPU per cron invocation, so extraction deliberately avoids regex backtracking
 * across the whole document. It locates the array with `indexOf`, then walks
 * brackets in a single linear pass.
 */

import { SEVERITY, rank } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://status.okta.com';

/** The embedded array always begins with this exact marker. */
const MARKER = '[{"attributes":{"type":"Incident__c"';

/** Statuses meaning "no longer affecting anyone". */
const CLOSED = new Set(['resolved', 'completed', 'closed']);

/**
 * Okta's `Category__c` values mapped onto our vocabulary.
 * @type {Record<string, import('../severity.js').Severity>}
 */
const CATEGORY = {
  'major service disruption': SEVERITY.MAJOR_OUTAGE,
  'service disruption': SEVERITY.PARTIAL_OUTAGE,
  'minor service disruption': SEVERITY.DEGRADED,
  'feature disruption': SEVERITY.DEGRADED,
  'service degradation': SEVERITY.DEGRADED,
  'performance issue': SEVERITY.DEGRADED,
};

/**
 * Extract the embedded JSON array in one linear pass.
 *
 * A `.*?` regex across 347 KB risks both CPU burn and catastrophic
 * backtracking. Bracket-walking is O(n) with no backtracking, and it correctly
 * handles the nested objects and arrays inside each record — including brackets
 * that appear inside string values.
 *
 * @param {string} html
 * @returns {any[]|null}
 */
export function extractIncidents(html) {
  const start = html.indexOf(MARKER);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * @param {any} incident
 * @returns {import('../severity.js').Severity}
 */
function severityOf(incident) {
  const category = String(incident?.Category__c ?? '')
    .toLowerCase()
    .trim();
  return CATEGORY[category] ?? SEVERITY.DEGRADED;
}

/**
 * @param {unknown} html raw status.okta.com page
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseOkta(html, options) {
  const { vendor, serviceCatalog, now } = options ?? {};

  if (typeof html !== 'string') {
    return unknownRecord(vendor, 'input was not HTML', { now, sourceUrl: SOURCE_URL });
  }

  const incidents = extractIncidents(html);
  if (!Array.isArray(incidents)) {
    return unknownRecord(
      vendor,
      'embedded incident data not found; the status page structure may have changed',
      { now, sourceUrl: SOURCE_URL },
    );
  }

  const open = incidents.filter(
    (i) => !CLOSED.has(String(i?.Status__c ?? '').toLowerCase().trim()),
  );

  const warnings = [];

  // Worst severity per named sub-service, from the open incidents.
  const affected = new Map();
  for (const i of open) {
    const name = toPlainText(i?.Okta_Sub_Service__c ?? i?.Service_Feature__c ?? '') || 'Okta';
    const sev = severityOf(i);
    const prev = affected.get(name);
    if (!prev || rank(sev) > rank(prev.severity)) {
      affected.set(name, { name, severity: sev, description: toPlainText(i?.Incident_Title__c ?? '') });
    }
  }

  // Okta renders its service list client-side from a Salesforce Aura endpoint
  // that is not reachable without a browser, so the catalogue is DECLARED in
  // config rather than discovered. That is a manually-maintained list, which is
  // exactly the kind of thing that rots silently — so drift is detected: if an
  // incident names a service the catalogue does not contain, we warn.
  const catalog = Array.isArray(serviceCatalog) ? serviceCatalog : null;
  for (const name of affected.keys()) {
    if (catalog && name !== 'Okta' && !catalog.includes(name)) {
      warnings.push(
        `incident names sub-service "${name}", which is absent from the configured Okta service catalog — the catalog may be out of date`,
      );
    }
  }

  const components = catalog
    ? catalog.map((name) => affected.get(name) ?? { name, severity: SEVERITY.OPERATIONAL })
    : [...affected.values()];

  if (open.length === 0) {
    return makeRecord({
      vendor,
      severity: SEVERITY.OPERATIONAL,
      description: 'All systems operational.',
      sourceUrl: SOURCE_URL,
      components,
      warnings,
      now,
    });
  }

  const openSeverities = [...affected.values()].map((c) => c.severity);
  const worstChild = openSeverities.includes(SEVERITY.MAJOR_OUTAGE)
    ? SEVERITY.MAJOR_OUTAGE
    : openSeverities.includes(SEVERITY.PARTIAL_OUTAGE)
      ? SEVERITY.PARTIAL_OUTAGE
      : SEVERITY.DEGRADED;

  const primary = open[0];
  return makeRecord({
    vendor,
    severity: worstChild,
    incidentName: toPlainText(primary?.Incident_Title__c ?? '') || 'Active incident',
    description:
      toPlainText(primary?.Incident_Title__c ?? '') ||
      `${open.length} open incident${open.length === 1 ? '' : 's'} reported by Okta.`,
    sourceUrl: SOURCE_URL,
    components,
    warnings,
    now,
  });
}

/** Back-compat alias; the Atom implementation is gone. */
export { parseOkta as parseOktaAtom };
