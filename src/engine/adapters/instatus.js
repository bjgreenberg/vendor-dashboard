/**
 * Instatus status-page adapter (e.g. Perplexity).
 *
 * Instatus is a distinct platform from Atlassian Statuspage with a different
 * vocabulary — page-level `UP` / `HASISSUES` / `UNDERMAINTENANCE`, and
 * components using a squashed unpunctuated form (`MAJOROUTAGE`,
 * `DEGRADEDPERFORMANCE`). Feeding an Instatus payload to the Statuspage adapter
 * would silently produce UNKNOWN for everything, so it gets its own module.
 *
 * `summary.json` carries `page.status` but frequently ships an empty component
 * list; components live at `api/v2/components.json`. The collector may merge
 * them, so this adapter accepts either.
 */

import { SEVERITY, normalizeSeverity, worst } from '../severity.js';
import { makeRecord, unknownRecord } from '../record.js';
import { selectComponents } from '../scope.js';

/**
 * @param {any} payload
 * @param {{vendor: string, scope?: any, sourceUrl?: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseInstatus(payload, options) {
  const { vendor, scope, sourceUrl, now } = options ?? {};

  const pageStatus = payload?.page?.status;
  const hasComponents = Array.isArray(payload?.components) && payload.components.length > 0;

  if (typeof pageStatus !== 'string' && !hasComponents) {
    return unknownRecord(vendor, 'payload had neither page.status nor components', {
      now,
      sourceUrl: payload?.page?.url ?? sourceUrl,
    });
  }

  // Instatus marks container rows with isParent; treat those as group headers
  // so a parent does not double-count its children.
  const leaves = hasComponents ? payload.components.filter((c) => !c.isParent) : [];
  const { selected, scoped, warnings } = selectComponents({ components: leaves }, scope);

  const componentSeverities = selected.map((c) => normalizeSeverity(c.status));
  const pageSeverity =
    typeof pageStatus === 'string' ? normalizeSeverity(pageStatus) : SEVERITY.UNKNOWN;

  // Same rule as the Statuspage adapter: a configured scope means the operator
  // has declared what matters, so the page-level signal is not allowed to
  // override it.
  const severity = scoped
    ? worst(componentSeverities)
    : worst([pageSeverity, ...componentSeverities]);

  const components = selected.map((c) => ({
    name: String(c.name),
    severity: normalizeSeverity(c.status),
    description: typeof c.description === 'string' ? c.description : '',
  }));

  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  return makeRecord({
    vendor,
    severity,
    incidentName: unhealthy.length > 0 ? 'Active issue' : '',
    description:
      unhealthy.length > 0
        ? `Affected: ${unhealthy.slice(0, 3).map((c) => c.name).join(', ')}.`
        : severity === SEVERITY.OPERATIONAL
          ? 'Systems operational.'
          : `Vendor reports status: ${pageStatus}.`,
    sourceUrl: payload?.page?.url ?? sourceUrl ?? '',
    components,
    warnings,
    now,
  });
}
