/**
 * Meta status adapter (metastatus.com).
 *
 * metastatus.com is a JS app; its data lives at `/data/orgs.json`, found by
 * reading the page bundle. That endpoint returns an array of "orgs", each with
 * a `services[]` list.
 *
 * IMPORTANT SCOPE LIMIT: this page covers Meta's **business and developer
 * platforms** — Graph API, Marketing API, Ads Manager, Business Suite, Messenger
 * Platform, WhatsApp Business Platform. It does NOT cover consumer Facebook,
 * Instagram or WhatsApp (verified 2026-07-31: all 17 orgs are business or
 * developer products). Labelling the row plain "Meta" would tell a reader their
 * Instagram feed is fine when nothing here measures that — the same
 * consumer/enterprise trap as the Microsoft endpoint, inverted.
 */

import { SEVERITY, worst, rank } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://metastatus.com';
const SERVICE_LABEL = 'Meta (Business & Developer Platforms)';

const SCOPE_CAVEAT =
  'Covers Meta business and developer platforms. Consumer Facebook, Instagram and WhatsApp are not reported here.';

/**
 * Meta writes its statuses as prose rather than an enum, so match on meaning and
 * fail closed on anything unrecognised.
 *
 * @param {unknown} raw
 * @returns {import('../severity.js').Severity}
 */
export function metaSeverity(raw) {
  const s = String(raw ?? '').toLowerCase().trim();
  if (s === '') return SEVERITY.UNKNOWN;
  if (/no known issues|operational|resolved/.test(s)) return SEVERITY.OPERATIONAL;
  if (/major|outage|unavailable|down/.test(s)) return SEVERITY.MAJOR_OUTAGE;
  if (/partial|degrad|elevated|some issues|disrupt/.test(s)) return SEVERITY.PARTIAL_OUTAGE;
  if (/maintenance/.test(s)) return SEVERITY.MAINTENANCE;
  return SEVERITY.UNKNOWN;
}

/**
 * @param {any} payload parsed /data/orgs.json (array of orgs)
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseMetaStatus(payload, options) {
  const { vendor, now } = options ?? {};

  const orgs = Array.isArray(payload) ? payload : payload?.orgs;
  if (!Array.isArray(orgs) || orgs.length === 0) {
    return unknownRecord(vendor, 'payload was not an org array', {
      now,
      sourceUrl: SOURCE_URL,
      service: SERVICE_LABEL,
    });
  }

  // One component per org, carrying the worst status among its services. Listing
  // every service would be ~50 rows of near-identical entries; the org is the
  // product a reader recognises.
  const components = orgs.map((o) => {
    const services = Array.isArray(o?.services) ? o.services : [];
    const severity = services.length
      ? worst(services.map((s) => metaSeverity(s?.status)))
      : SEVERITY.UNKNOWN;
    const bad = services.filter((s) => metaSeverity(s?.status) !== SEVERITY.OPERATIONAL);
    return {
      name: toPlainText(o?.name ?? o?.id ?? 'Unknown product'),
      severity,
      description: bad.length
        ? `Affected: ${bad.map((s) => toPlainText(s?.name)).slice(0, 3).join(', ')}.`
        : '',
    };
  });

  const severity = worst(components.map((c) => c.severity));
  const unhealthy = components.filter((c) => rank(c.severity) > rank(SEVERITY.OPERATIONAL));

  return makeRecord({
    vendor,
    service: SERVICE_LABEL,
    severity,
    incidentName: unhealthy.length ? 'Active issue' : '',
    description: unhealthy.length
      ? `Affected: ${unhealthy.slice(0, 3).map((c) => c.name).join(', ')}.`
      : 'All platforms report no known issues.',
    sourceUrl: SOURCE_URL,
    components,
    warnings: [SCOPE_CAVEAT],
    now,
  });
}
