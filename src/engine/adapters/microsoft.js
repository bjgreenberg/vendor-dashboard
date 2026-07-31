/**
 * Microsoft status adapter.
 *
 * Resolves audit finding H1, per decision D2.
 *
 * The predecessor fetched this endpoint into `const data` and then DISCARDED
 * it, returning a hardcoded "Operational / Everything is up and running." row.
 * (That string is verbatim the endpoint's own `SubTitle`, which is how the bug
 * arose: fetched once, observed, pasted.) Microsoft therefore displayed green
 * 100% of the time since the tool was written.
 *
 * IMPORTANT SCOPE LIMIT: `portal.office.com/api/servicestatus/index` reports
 * CONSUMER services only -- Outlook.com, OneDrive, Phone Link, Teams Free,
 * Copilot. Exchange Online, SharePoint, Entra, Intune and Defender are ABSENT
 * (verified 2026-07-30). Labelling this "Microsoft 365" would mislead any
 * enterprise reader, so the row is labelled as consumer services and carries a
 * standing warning. Enterprise tenant health requires the authenticated
 * Microsoft Graph Service Health API (ServiceHealth.Read.All).
 */

import { SEVERITY } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://portal.office.com/servicestatus';
const SERVICE_LABEL = 'Microsoft (Consumer Services)';

// Kept short and non-technical: a reader wants to know what this row does and
// does not cover, not how we would fix it. The engineering detail (Graph
// ServiceHealth.Read.All, tenant app registration) lives in the docs.
//
// Verified 2026-07-31 from Microsoft's own feed: status.cloud.microsoft is a
// META-status page that reports only when the admin centre itself is
// unreachable, and directs customers to their tenant admin centre. There is no
// public per-workload feed for Exchange, Entra, Intune or Defender - it is
// tenant-scoped by design, because each tenant sees only its own incidents.
const ENTERPRISE_CAVEAT =
  'Covers Microsoft consumer services. Business services such as Exchange, Teams and Intune are only reported inside each organisation\'s own admin centre.';

/**
 * @param {any} payload
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseMicrosoft(payload, options) {
  const { vendor, now } = options ?? {};
  if (!payload || !Array.isArray(payload.Services)) {
    return unknownRecord(vendor, 'payload had no Services array', {
      now,
      sourceUrl: SOURCE_URL,
      service: SERVICE_LABEL,
    });
  }

  // Return EVERY service, not just the unhealthy ones, so the dashboard can
  // disclose the full list on demand the way it does for Statuspage vendors.
  const components = payload.Services.map((s) => ({
    name: String(s?.Name ?? 'Unknown service'),
    severity: s?.IsUp === false ? SEVERITY.PARTIAL_OUTAGE : SEVERITY.OPERATIONAL,
    description: toPlainText(s?.Messages?.[0]?.Message ?? s?.Messages?.[0] ?? ''),
  }));
  const down = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  if (down.length === 0 && payload.IsAllUp !== false) {
    return makeRecord({
      vendor,
      service: SERVICE_LABEL,
      severity: SEVERITY.OPERATIONAL,
      description: toPlainText(payload.SubTitle) || 'Everything is up and running.',
      sourceUrl: SOURCE_URL,
      components,
      warnings: [ENTERPRISE_CAVEAT],
      now,
    });
  }

  return makeRecord({
    vendor,
    service: SERVICE_LABEL,
    severity: SEVERITY.PARTIAL_OUTAGE,
    incidentName: toPlainText(payload.Title) || 'Service issue',
    description:
      down.length > 0
        ? `Affected: ${down.map((c) => c.name).slice(0, 3).join(', ')}.`
        : toPlainText(payload.SubTitle) || 'Issue reported by Microsoft.',
    sourceUrl: SOURCE_URL,
    components,
    warnings: [ENTERPRISE_CAVEAT],
    now,
  });
}
