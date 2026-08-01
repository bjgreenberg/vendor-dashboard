/**
 * Microsoft Azure and Azure DevOps adapters.
 *
 * Added 2026-08-01 after Microsoft retired the endpoint that backed the
 * original "Microsoft" row, leaving that row covering only whether the M365
 * admin centre is reachable. These two are the substantial, genuinely public,
 * machine-readable Microsoft status sources that do exist:
 *
 *   Azure         https://azure.status.microsoft/en-us/status/feed/   (RSS)
 *   Azure DevOps  https://status.dev.azure.com/_apis/status/health    (JSON)
 *
 * CORRECTION (same day): an earlier version of this comment claimed
 * status.cloud.microsoft serves *only* /api/feed/mac and /api/feed/ppac,
 * because every other product name against /api/feed/{id} returns HTTP 400.
 * That was a wrong inference from a true observation — a 400 from one route
 * says that route rejects the id, not that the data is unpublished. There is a
 * second API, /api/posts/{id}, serving azure, m365Consumer, mac and ppac; the
 * bundle builds it as a bare relative string ("api/posts/m365Consumer", no
 * leading slash) so a grep for quoted absolute paths missed it. Azure now uses
 * /api/posts/azure (see parseAzurePost) and the consumer products are covered
 * in adapters/microsoft.js.
 *
 * What was checked and genuinely rejected, so nobody re-treads it:
 *   - status.bing.com is NOT a status page: it is a wildcard serving the Bing
 *     search homepage for every path, including /api/v2/summary.json. A naive
 *     probe that only checks the HTTP status would have added a fake row.
 *   - status.dynamics.com does not resolve.
 *   - powerbi.microsoft.com/support returns 403 to a non-browser client.
 *   - Xbox Live (xnotify.xboxlive.com/servicestatusv6) works and returns 92 KB
 *     of XML, but it is consumer gaming and the size is hard to justify
 *     against a 10 ms CPU budget.
 *   - Per-workload M365 health (Exchange, Entra, Intune) remains tenant-scoped
 *     by design and needs the authenticated Graph Service Health API.
 */

import { SEVERITY, worst } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

/* --------------------------------- Azure --------------------------------- */

const AZURE_SOURCE_URL = 'https://azure.status.microsoft/en-us/status/';
const AZURE_LABEL = 'Microsoft Azure';

/**
 * How long a feed may go unrefreshed before we stop believing it.
 *
 * THIS IS THE LOAD-BEARING GUARD. Azure's feed lists ACTIVE INCIDENTS, so the
 * healthy state is an empty feed — and "no items" is absence of evidence, which
 * is exactly the shape of audit finding H6. An abandoned or broken feed is also
 * empty, and would read as perfect health forever.
 *
 * What makes empty trustworthy is that `lastBuildDate` is regenerated every
 * minute (verified 2026-08-01: 00:18 then 00:19 on consecutive samples). So the
 * feed proves its own liveness, and we require that proof before treating empty
 * as healthy. 30 minutes is ~30x the observed cadence: tolerant of a blip,
 * intolerant of an abandoned feed.
 */
const AZURE_MAX_FEED_AGE_MS = 30 * 60 * 1000;

/** @param {string} xml @param {string} tag */
function tag(xml, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/**
 * Azure writes incident titles as prose, so match on meaning and fail closed.
 * @param {string} text
 */
function azureSeverityOf(text) {
  const s = text.toLowerCase();
  if (/\bresolved\b|\bmitigated\b/.test(s)) return SEVERITY.OPERATIONAL;
  if (/outage|unavailable|major/.test(s)) return SEVERITY.MAJOR_OUTAGE;
  if (/degrad|latency|elevated|error|impact|issue|disrupt/.test(s)) return SEVERITY.DEGRADED;
  if (/maintenance/.test(s)) return SEVERITY.MAINTENANCE;
  // An item exists but we cannot classify it. An unclassified incident is
  // still an incident — do not fall through to healthy.
  return SEVERITY.DEGRADED;
}

/**
 * @param {string} xml
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseAzureFeed(xml, options) {
  const { vendor, now } = options ?? {};
  const at = (now ?? (() => new Date()))();
  const opts = { now, sourceUrl: AZURE_SOURCE_URL, service: AZURE_LABEL };

  if (typeof xml !== 'string' || !xml.includes('<rss')) {
    return unknownRecord(vendor, 'response was not the expected RSS feed', opts);
  }

  const built = Date.parse(tag(xml, 'lastBuildDate'));
  if (!Number.isFinite(built)) {
    return unknownRecord(vendor, 'feed carried no parseable lastBuildDate', opts);
  }

  const ageMs = at.getTime() - built;
  if (ageMs > AZURE_MAX_FEED_AGE_MS) {
    const mins = Math.round(ageMs / 60000);
    return unknownRecord(
      vendor,
      `feed has not been rebuilt for ${mins} minutes — an empty feed cannot be read as healthy`,
      opts,
    );
  }

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);

  if (items.length === 0) {
    return makeRecord({
      vendor,
      service: AZURE_LABEL,
      severity: SEVERITY.OPERATIONAL,
      description: 'No active Azure service issues are published.',
      sourceUrl: AZURE_SOURCE_URL,
      components: [],
      warnings: [],
      now,
    });
  }

  const components = items.map((item) => {
    const title = toPlainText(tag(item, 'title')) || 'Azure incident';
    return { name: title, severity: azureSeverityOf(title), description: '' };
  });

  const severity = worst(components.map((c) => c.severity));
  return makeRecord({
    vendor,
    service: AZURE_LABEL,
    severity,
    incidentName: components[0].name,
    description: `${items.length} active issue${items.length === 1 ? '' : 's'} published.`,
    sourceUrl: AZURE_SOURCE_URL,
    components,
    warnings: [],
    now,
  });
}

/* ------------------------------ Azure DevOps ------------------------------ */

const ADO_SOURCE_URL = 'https://status.dev.azure.com/';
const ADO_LABEL = 'Azure DevOps';

/**
 * Azure DevOps health vocabulary. Anything unrecognised fails closed.
 * `advisory` is a real value meaning "degraded but usable".
 */
const ADO_HEALTH = Object.freeze(
  Object.assign(Object.create(null), {
    healthy: SEVERITY.OPERATIONAL,
    advisory: SEVERITY.DEGRADED,
    degraded: SEVERITY.DEGRADED,
    unhealthy: SEVERITY.MAJOR_OUTAGE,
  }),
);

/**
 * @param {any} payload parsed /_apis/status/health
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseAzureDevOps(payload, options) {
  const { vendor, now } = options ?? {};
  const opts = { now, sourceUrl: ADO_SOURCE_URL, service: ADO_LABEL };

  const services = payload?.services;
  if (!Array.isArray(services) || services.length === 0) {
    return unknownRecord(vendor, 'payload had no services array', opts);
  }

  // One component per SERVICE, carrying the worst health across geographies.
  // Listing all 8 regions for each of 7 services would be 56 near-identical
  // rows — the same PoP-versus-service problem solved for Zoom and Docusign.
  const components = services.map((s) => {
    const geos = Array.isArray(s?.geographies) ? s.geographies : [];
    const severities = geos.map((g) => ADO_HEALTH[String(g?.health ?? '').toLowerCase()] ?? SEVERITY.UNKNOWN);
    const severity = severities.length ? worst(severities) : SEVERITY.UNKNOWN;
    const bad = geos.filter(
      (g) => (ADO_HEALTH[String(g?.health ?? '').toLowerCase()] ?? SEVERITY.UNKNOWN) !== SEVERITY.OPERATIONAL,
    );
    return {
      name: toPlainText(s?.id ?? 'Unknown service'),
      severity,
      description: bad.length ? `Affected regions: ${bad.map((g) => toPlainText(g?.name)).join(', ')}.` : '',
    };
  });

  if (components.every((c) => c.severity === SEVERITY.UNKNOWN)) {
    return unknownRecord(vendor, 'no recognisable health values in payload', opts);
  }

  const severity = worst(components.map((c) => c.severity));
  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  return makeRecord({
    vendor,
    service: ADO_LABEL,
    severity,
    incidentName: unhealthy.length ? 'Service health issue' : '',
    description: unhealthy.length
      ? `Affected: ${unhealthy.map((c) => c.name).join(', ')}.`
      : toPlainText(payload?.status?.message) || 'All services report healthy.',
    sourceUrl: ADO_SOURCE_URL,
    components,
    warnings: [],
    now,
  });
}

/* --------------------- Azure via status.cloud.microsoft ------------------- */

/**
 * Preferred over the RSS feed above.
 *
 * `/api/posts/azure` returns an explicit `Status` field plus a
 * `LastUpdatedTime` that is regenerated every minute, so healthy is a POSITIVE
 * assertion rather than an empty list. The RSS feed required inferring health
 * from "no items", which is absence of evidence (finding H6) and needed a
 * freshness guard to be trustworthy at all. A stated status with a proof of
 * liveness is strictly better evidence.
 *
 * The freshness guard is kept regardless: a frozen endpoint repeating
 * "Available" forever is exactly as misleading as a frozen empty feed.
 */
const AZURE_POST_MAX_AGE_MS = 30 * 60 * 1000;

const AZURE_POST_STATUS = Object.freeze(
  Object.assign(Object.create(null), {
    available: SEVERITY.OPERATIONAL,
    operational: SEVERITY.OPERATIONAL,
    normal: SEVERITY.OPERATIONAL,
    restored: SEVERITY.OPERATIONAL,
    degraded: SEVERITY.DEGRADED,
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
 * @param {any} payload parsed /api/posts/azure
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseAzurePost(payload, options) {
  const { vendor, now } = options ?? {};
  const at = (now ?? (() => new Date()))();
  const opts = { now, sourceUrl: AZURE_SOURCE_URL, service: AZURE_LABEL };

  const post = Array.isArray(payload) ? payload[0] : payload;
  const raw = String(post?.Status ?? '').trim();
  if (!raw) return unknownRecord(vendor, 'payload carried no Status field', opts);

  const updated = Date.parse(post?.LastUpdatedTime ?? '');
  if (!Number.isFinite(updated)) {
    return unknownRecord(vendor, 'payload carried no parseable LastUpdatedTime', opts);
  }
  const ageMs = at.getTime() - updated;
  if (ageMs > AZURE_POST_MAX_AGE_MS) {
    return unknownRecord(
      vendor,
      `status has not been refreshed for ${Math.round(ageMs / 60000)} minutes`,
      opts,
    );
  }

  const severity = AZURE_POST_STATUS[raw.toLowerCase()] ?? SEVERITY.UNKNOWN;
  if (severity === SEVERITY.UNKNOWN) {
    return unknownRecord(vendor, `unrecognised status "${raw}"`, opts);
  }

  return makeRecord({
    vendor,
    service: AZURE_LABEL,
    severity,
    incidentName: severity === SEVERITY.OPERATIONAL ? '' : toPlainText(post?.Title ?? 'Azure issue'),
    description: toPlainText(post?.Message ?? '') || 'No Azure issues reported.',
    sourceUrl: AZURE_SOURCE_URL,
    components: [],
    warnings: [],
    now,
  });
}
