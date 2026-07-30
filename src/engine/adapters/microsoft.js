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

const ENTERPRISE_CAVEAT =
  'This endpoint covers consumer services only; Exchange Online, SharePoint, Entra, Intune and Defender are not reported. Enterprise tenant health requires the authenticated Microsoft Graph Service Health API.';

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

  const down = payload.Services.filter((s) => s?.IsUp === false);

  const components = down.map((s) => ({
    name: String(s?.Name ?? 'Unknown service'),
    severity: SEVERITY.PARTIAL_OUTAGE,
    description: toPlainText(s?.Messages?.[0]?.Message ?? s?.Messages?.[0] ?? ''),
  }));

  if (components.length === 0 && payload.IsAllUp !== false) {
    return makeRecord({
      vendor,
      service: SERVICE_LABEL,
      severity: SEVERITY.OPERATIONAL,
      description: toPlainText(payload.SubTitle) || 'Everything is up and running.',
      sourceUrl: SOURCE_URL,
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
      components.length > 0
        ? `Affected: ${components.map((c) => c.name).slice(0, 3).join(', ')}.`
        : toPlainText(payload.SubTitle) || 'Issue reported by Microsoft.',
    sourceUrl: SOURCE_URL,
    components,
    warnings: [ENTERPRISE_CAVEAT],
    now,
  });
}
