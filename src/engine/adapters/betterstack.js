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

import { SEVERITY, worst } from '../severity.js';
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

  // Per-resource detail, when collect.js supplied the /sections fragment.
  // A broken resource outranks a green page-level state: the summary is not
  // authoritative over its own parts.
  const components = parseBetterStackSections(options?.sections ?? '');
  const rowSeverity = components.length
    ? worst([severity, ...components.map((c) => c.severity)])
    : severity;
  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  return makeRecord({
    vendor,
    severity: rowSeverity,
    description:
      rowSeverity === SEVERITY.OPERATIONAL
        ? components.length
          ? `All ${components.length} monitored services operational.`
          : 'Systems operational.'
        : unhealthy.length
          ? `Affected: ${unhealthy.map((c) => c.name).join(', ')}.`
          : `Vendor status page reports: ${state}.`,
    incidentName: rowSeverity === SEVERITY.OPERATIONAL ? '' : 'Active issue',
    sourceUrl,
    components,
    now,
  });
}

/**
 * Per-resource status from BetterStack's /sections fragment.
 *
 * The status page renders its resource list from `<host>/sections`, found by
 * reading the network log — the main page HTML contains no resource names at
 * all, so the row previously had a page-level status and nothing underneath.
 *
 * The fragment is JSON-wrapped HTML. Each resource block carries its state in
 * an ICON FILENAME (`operational_small-<hash>.png`) and its name as bare text
 * after that image. Reading the icon rather than a colour or a label is
 * deliberate: the CSS colours are inline hex values that would silently change
 * with a theme tweak, whereas the filename is a state name.
 *
 * Names are the monitored URLs — Stormboard monitors endpoints rather than
 * naming products — so the host is used, which is what a reader recognises.
 *
 * @param {string} html
 * @returns {{name: string, severity: string, description: string}[]}
 */
export function parseBetterStackSections(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const text = html.replace(/\\n/g, '\n').replace(/\\"/g, '"');

  const out = [];
  const BLOCK = /status-page__resource-name'>([\s\S]{0,400}?)<\/div>/g;
  let m;
  while ((m = BLOCK.exec(text)) !== null) {
    const block = m[1];
    const icon = /status_pages\/([a-z_]+)_small/.exec(block);
    const raw = block.replace(/<[^>]+>/g, '').trim();
    if (!raw) continue;

    let name = raw;
    try {
      if (/^https?:\/\//.test(raw)) name = new URL(raw).host;
    } catch {
      /* keep the raw label */
    }

    out.push({ name, severity: BETTERSTACK_STATE[icon?.[1] ?? ''] ?? SEVERITY.UNKNOWN, description: raw });
  }
  return out;
}

/** Icon-filename states BetterStack ships. Unknown names fail closed. */
const BETTERSTACK_STATE = Object.freeze(
  Object.assign(Object.create(null), {
    operational: SEVERITY.OPERATIONAL,
    degraded: SEVERITY.DEGRADED,
    downtime: SEVERITY.MAJOR_OUTAGE,
    maintenance: SEVERITY.MAINTENANCE,
    not_monitored: SEVERITY.UNKNOWN,
  }),
);
