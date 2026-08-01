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

import { SEVERITY, worst } from '../severity.js';
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

/* ------------------------------------------------------------------------- *
 * status.cloud.microsoft RSS feed — the CURRENT source.
 * ------------------------------------------------------------------------- */

/**
 * Microsoft retired `portal.office.com/api/servicestatus/index`.
 *
 * It now answers 404 with `{"Message":"No HTTP resource was found that matches
 * the request URI ..."}`, and so does the admin.microsoft.com sibling that was
 * configured as a fallback. That also re-explains the "roughly 50% available"
 * measurement from 2026-07-31: it was not flakiness, it was a progressive
 * decommission, and treating it as flakiness is why 404 was added to the retry
 * list. Retrying a retired route just spends subrequests to reach the same
 * `unknown`.
 *
 * `status.cloud.microsoft` is the replacement and publishes a real
 * machine-readable feed, discovered by reading its JS bundle (the same way
 * Concur's API was found):
 *
 *   <item>
 *     <title>Microsoft Admin Center</title>
 *     <status>Available</status>
 *     <pubDate>Sat, 01 Aug 2026 00:05:00 Z</pubDate>
 *   </item>
 *
 * SCOPE, stated honestly and NARROWER than before. This reports whether the
 * Microsoft 365 admin centre itself is reachable — nothing else. It does not
 * cover consumer Outlook.com/OneDrive (which the retired endpoint did), and it
 * does not cover Exchange, SharePoint, Entra, Intune or Defender, which are
 * tenant-scoped by design and need the authenticated Graph Service Health API.
 * The row is labelled for exactly what it measures; a narrow true signal beats
 * a broad `unknown`, but only if the label does not overclaim.
 */
const FEED_SOURCE_URL = 'https://status.cloud.microsoft/';
const FEED_SERVICE_LABEL = 'Microsoft 365 (Admin Center)';

const FEED_CAVEAT =
  'Reports whether the Microsoft 365 admin centre itself is reachable. ' +
  'Exchange, Teams, SharePoint and Intune health is only visible inside each ' +
  "organisation's own admin centre.";

/**
 * Microsoft's vocabulary for this feed. Anything unrecognised fails CLOSED to
 * unknown — a status word we have never seen must not be assumed benign.
 */
const FEED_STATUS = Object.freeze(
  Object.assign(Object.create(null), {
    available: SEVERITY.OPERATIONAL,
    normal: SEVERITY.OPERATIONAL,
    healthy: SEVERITY.OPERATIONAL,
    degraded: SEVERITY.DEGRADED,
    degradation: SEVERITY.DEGRADED,
    investigating: SEVERITY.DEGRADED,
    interruption: SEVERITY.PARTIAL_OUTAGE,
    unavailable: SEVERITY.MAJOR_OUTAGE,
    outage: SEVERITY.MAJOR_OUTAGE,
    maintenance: SEVERITY.MAINTENANCE,
  }),
);

/** @param {string} xml @param {string} tag */
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/**
 * @param {string} xml raw RSS from status.cloud.microsoft/api/feed/mac
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseMicrosoftFeed(xml, options) {
  const { vendor, now } = options ?? {};
  const opts = { now, sourceUrl: FEED_SOURCE_URL, service: FEED_SERVICE_LABEL };

  if (typeof xml !== 'string' || !xml.includes('<rss')) {
    return unknownRecord(vendor, 'response was not the expected RSS feed', opts);
  }

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  if (items.length === 0) {
    return unknownRecord(vendor, 'feed contained no items — structure may have changed', opts);
  }

  const components = items.map((item) => {
    const raw = tagText(item, 'status');
    const severity = FEED_STATUS[raw.toLowerCase()] ?? SEVERITY.UNKNOWN;
    return {
      name: toPlainText(tagText(item, 'title')) || 'Microsoft Admin Center',
      severity,
      description: severity === SEVERITY.UNKNOWN && raw ? `Unrecognised status "${raw}".` : '',
    };
  });

  // A <status> element that is missing entirely means the feed changed shape,
  // which must read as uncertainty rather than health.
  if (components.every((c) => c.severity === SEVERITY.UNKNOWN)) {
    return unknownRecord(vendor, 'feed carried no recognisable status value', opts);
  }

  const severity = worst(components.map((c) => c.severity));
  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  return makeRecord({
    vendor,
    service: FEED_SERVICE_LABEL,
    severity,
    incidentName: unhealthy.length ? 'Admin centre issue' : '',
    description: unhealthy.length
      ? `Affected: ${unhealthy.map((c) => c.name).join(', ')}.`
      : 'The Microsoft 365 admin centre is reachable.',
    sourceUrl: FEED_SOURCE_URL,
    components,
    warnings: [FEED_CAVEAT],
    now,
  });
}
