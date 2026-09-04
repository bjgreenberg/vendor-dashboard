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

  // An EMPTY catalogue means nothing was verified. IsAllUp is attestation with
  // no services behind it, and trusting this endpoint's optimism unexamined is
  // exactly the defect (H1) this adapter exists to correct.
  if (components.length === 0) {
    return unknownRecord(vendor, 'payload carried an empty Services list', {
      now,
      sourceUrl: SOURCE_URL,
      service: SERVICE_LABEL,
    });
  }

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

/* ------------------------------------------------------------------------- *
 * status.cloud.microsoft consumer products — the RICH source.
 * ------------------------------------------------------------------------- *
 *
 * FOUND BY CORRECTING AN EARLIER WRONG CONCLUSION. I had reported that
 * Microsoft publishes no public per-app health, because the status site's JS
 * bundle referenced only `/api/feed/mac` and `/api/feed/ppac`, and every
 * product name against `/api/feed/{id}` returned HTTP 400. Both observations
 * were true; the conclusion drawn from them was not.
 *
 * The bundle also contains a SECOND, differently-shaped API that a grep for
 * quoted absolute paths missed because the call site builds it as a bare
 * relative string:
 *
 *     getCurrentConsumerWorkloads = function () {
 *       var e = "api/posts/m365Consumer";   // <- no leading slash
 *
 * `/api/posts/{id}` serves JSON for m365Consumer, azure, mac and ppac. The
 * lesson: a 400 from `/api/feed/consumer` ("consumer is not a supported
 * service for EBS") proved that ONE route rejected that id — not that the data
 * was unpublished. Absence of evidence again, and I acted on it as if it were
 * evidence of absence.
 *
 * Covers 10 consumer services including Office for the web (Word, Excel,
 * PowerPoint), Outlook.com, OneDrive, Copilot, Teams Free, To-Do, Whiteboard,
 * Lists and Phone Link. Enterprise per-workload health (Exchange Online,
 * SharePoint, Entra, Intune, Defender) genuinely does remain tenant-scoped
 * behind the authenticated Graph Service Health API — that part was correct.
 */

const CONSUMER_SOURCE_URL = 'https://status.cloud.microsoft/';
const CONSUMER_LABEL = 'Microsoft (Consumer Services)';

const CONSUMER_CAVEAT =
  'Covers Microsoft consumer products. Business services such as Exchange, ' +
  "SharePoint and Intune are only reported inside each organisation's own admin centre.";

/** Microsoft's vocabulary on this endpoint. Unrecognised values fail closed. */
const CONSUMER_STATUS = Object.freeze(
  Object.assign(Object.create(null), {
    operational: SEVERITY.OPERATIONAL,
    available: SEVERITY.OPERATIONAL,
    normal: SEVERITY.OPERATIONAL,
    restored: SEVERITY.OPERATIONAL,
    degraded: SEVERITY.DEGRADED,
    // Observed live 2026-09-01 on /api/posts/mac: Microsoft emits the
    // two-word phrase, not the bare adjective — the row read `unknown`
    // for 20 hours during a real admin-centre degradation.
    'service degradation': SEVERITY.DEGRADED,
    investigating: SEVERITY.DEGRADED,
    advisory: SEVERITY.DEGRADED,
    incident: SEVERITY.PARTIAL_OUTAGE,
    interruption: SEVERITY.PARTIAL_OUTAGE,
    unavailable: SEVERITY.MAJOR_OUTAGE,
    outage: SEVERITY.MAJOR_OUTAGE,
    maintenance: SEVERITY.MAINTENANCE,
  }),
);

/**
 * Look a status word up in CONSUMER_STATUS, tolerating Microsoft's habit of
 * prefixing the word with "Service": "Service degradation" (live 2026-09-01,
 * PR #127) and "Service restored" (live 2026-09-03 — Copilot's resolved
 * incident kept the row `unknown` for 9 hours because only the bare word
 * `restored` was mapped). The prefix is dropped and the remainder looked up,
 * so a third variant maps like its bare word while a word we have never
 * seen still fails closed — "Service sparkly" is `unknown`, as is a bare
 * "Service".
 *
 * @param {string} raw the post's Status field, trimmed
 * @returns {string} a SEVERITY value, UNKNOWN when unrecognised
 */
export function consumerSeverity(raw) {
  const word = String(raw ?? '')
    .trim()
    .toLowerCase();
  const direct = CONSUMER_STATUS[word];
  if (direct) return direct;
  const m = /^service\s+(\S.*)$/.exec(word);
  return (m && CONSUMER_STATUS[m[1]]) ?? SEVERITY.UNKNOWN;
}

/**
 * @param {any} payload parsed /api/posts/m365Consumer (array of workloads)
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseMicrosoftConsumer(payload, options) {
  const { vendor, now } = options ?? {};
  const opts = { now, sourceUrl: CONSUMER_SOURCE_URL, service: CONSUMER_LABEL };

  const rows = Array.isArray(payload) ? payload : payload?.posts;
  if (!Array.isArray(rows) || rows.length === 0) {
    return unknownRecord(vendor, 'payload was not a workload array', opts);
  }

  const components = rows.map((s) => {
    const severity = consumerSeverity(s?.Status);
    return {
      name: toPlainText(s?.ServiceDisplayName ?? s?.ServiceWorkloadName ?? 'Unknown service'),
      severity,
      description: toPlainText(s?.Title || s?.Message || '').slice(0, 300),
    };
  });

  // Every workload unreadable means the payload shape changed. Reporting that
  // as health would be the exact false green this project exists to prevent.
  if (components.every((c) => c.severity === SEVERITY.UNKNOWN)) {
    return unknownRecord(vendor, 'no recognisable status values in payload', opts);
  }

  const severity = worst(components.map((c) => c.severity));
  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  return makeRecord({
    vendor,
    service: CONSUMER_LABEL,
    severity,
    incidentName: unhealthy.length ? (unhealthy[0].description ? unhealthy[0].description.slice(0, 120) : 'Service issue') : '',
    description: unhealthy.length
      ? `Affected: ${unhealthy.map((c) => c.name).join(', ')}.`
      : `All ${components.length} consumer services report operational.`,
    sourceUrl: CONSUMER_SOURCE_URL,
    components,
    warnings: [CONSUMER_CAVEAT],
    now,
  });
}

/**
 * The two ADMIN-CENTRE meta-status posts: /api/posts/mac and /api/posts/ppac.
 *
 * Same single-post shape as /api/posts/azure. The label comes from the vendor
 * name so one parser serves both, rather than cloning it per product.
 *
 * READ WHAT THESE ACTUALLY MEAN. Microsoft's own text: "This site is updated
 * when service issues are preventing tenant administrators from ACCESSING
 * Service health in the admin center." So a green row here means the admin
 * console is reachable — NOT that Exchange, Teams, SharePoint or Power Apps are
 * healthy. That distinction is the whole reason the label and warning are
 * explicit: a row reading "Microsoft 365 — Operational" would be read by any
 * reasonable person as "my email works", which this does not measure.
 *
 * They are included anyway because for enterprise M365 there is no other public
 * signal at all, and "Microsoft says the console is up, so check your own
 * tenant" is genuinely more useful than an absent row.
 */
const ADMIN_CAVEAT =
  'Reports only whether the admin centre itself is reachable. Health of the ' +
  "services inside it is visible only in each organisation's own admin centre.";

/**
 * @param {any} payload parsed /api/posts/mac or /api/posts/ppac
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseMicrosoftAdminPost(payload, options) {
  const { vendor, now } = options ?? {};
  const at = (now ?? (() => new Date()))();
  const label = `${vendor} (Admin Center reachability)`;
  const opts = { now, sourceUrl: CONSUMER_SOURCE_URL, service: label };

  const post = Array.isArray(payload) ? payload[0] : payload;
  const raw = String(post?.Status ?? '').trim();
  if (!raw) return unknownRecord(vendor, 'payload carried no Status field', opts);

  const updated = Date.parse(post?.LastUpdatedTime ?? '');
  if (!Number.isFinite(updated)) {
    return unknownRecord(vendor, 'payload carried no parseable LastUpdatedTime', opts);
  }
  const severity = consumerSeverity(raw);
  if (severity === SEVERITY.UNKNOWN) {
    return unknownRecord(vendor, `unrecognised status "${raw}"`, opts);
  }

  // A frozen endpoint repeating "Available" forever is as misleading as
  // silence — but ONLY for operational claims. An incident post naturally
  // sits unchanged between vendor updates (live 2026-09-01: a real
  // "Service degradation" read `unknown` because the post was 37 minutes
  // old), so a non-operational status stays trusted for 24h before the
  // abandoned-post cap distrusts it too.
  const ageMin = Math.round((at.getTime() - updated) / 60000);
  const staleCapMin = severity === SEVERITY.OPERATIONAL ? 30 : 24 * 60;
  if (ageMin > staleCapMin) {
    return unknownRecord(vendor, `status has not been refreshed for ${ageMin} minutes`, opts);
  }

  return makeRecord({
    vendor,
    service: label,
    severity,
    incidentName: severity === SEVERITY.OPERATIONAL ? '' : toPlainText(post?.Title ?? 'Admin centre issue'),
    description:
      severity === SEVERITY.OPERATIONAL
        ? 'The admin centre is reachable.'
        : toPlainText(post?.Message ?? '').slice(0, 300),
    sourceUrl: CONSUMER_SOURCE_URL,
    components: [],
    warnings: [ADMIN_CAVEAT],
    now,
  });
}
