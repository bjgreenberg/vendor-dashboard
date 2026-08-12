/**
 * Zscaler Trust portal adapter — trust.zscaler.com, NOT a Statuspage.
 *
 * Runtime-agnostic: pure function over parsed payloads. The collector fetches
 * one document PER CLOUD (`/api/cloud-status?cloud=<machine>&requestType=
 * core_cloud_services`) and pairs each with its configured display label,
 * because the document does not name its own cloud.
 *
 * HOW SEVERITY IS DECIDED — and the trap that shapes it (verified live,
 * 2026-08-12):
 *
 * - Each subCategory carries a boolean `status` field that stayed `true`
 *   WHILE an active Service Degradation was open against it. Deriving health
 *   from that boolean is a false green — the exact class of failure this
 *   project's audit exists to prevent. It is never read.
 * - The honest signal is the active-event list (`category_status`), judged by
 *   the payload's OWN severity legend (`data.severity`). The legend is
 *   self-describing: `visible: "1"` marks the severities Zscaler's own page
 *   paints as service-impacting (Service Disruption, Service Degradation);
 *   `visible: "0"` marks context (Under Investigation, Informational,
 *   Security Advisory, No Service Impact). Context informs, it never votes.
 * - Sampling dateOffset 0–20 returned identical event sets, so the endpoint
 *   lists only ACTIVE events — the parameter windows the maintenance
 *   calendar, not incidents. No resolved-event filtering is needed (the AWS
 *   currentevents lesson does not recur here).
 *
 * Fails closed: a missing cloud document, an empty category list, an event
 * whose severity tid is absent from the legend, or an impacting severity
 * whose name is unrecognised all yield UNKNOWN, never OPERATIONAL.
 */

import { SEVERITY, worst } from '../severity.js';

/**
 * @typedef {import('./statuspage.js').StatusRecord} StatusRecord
 */

/** Strip HTML tags and collapse whitespace for a plain-text summary. */
function toPlainText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Map an impacting legend entry to a board severity, by NAME — the tids are
 * CMS row ids and could be renumbered; the names carry the semantics.
 *
 * @param {string} name legend name of a `visible: "1"` severity
 * @returns {import('../severity.js').Severity|null} null when unrecognised
 */
function impactingSeverity(name) {
  if (/disruption/i.test(name)) return SEVERITY.MAJOR_OUTAGE;
  if (/degradation/i.test(name)) return SEVERITY.DEGRADED;
  return null;
}

/**
 * Parse the per-cloud Trust portal documents into one status record.
 *
 * @param {{label: string, data: any}[]} cloudDocs one entry per configured
 *   cloud; `data` is null when that cloud's fetch or JSON parse failed
 * @param {object} options
 * @param {string} options.vendor
 * @param {string} [options.service]
 * @param {string} [options.sourceUrl]
 * @param {() => Date} [options.now] injected clock for deterministic tests
 * @returns {StatusRecord}
 */
export function parseZscaler(cloudDocs, options) {
  const { vendor, service, sourceUrl, now = () => new Date() } = options ?? {};
  const warnings = [];

  const base = {
    vendor: vendor ?? 'unknown',
    service: service ?? vendor ?? 'unknown',
    sourceUrl: sourceUrl ?? '',
    checkedAt: now().toISOString(),
  };

  if (!Array.isArray(cloudDocs) || cloudDocs.length === 0) {
    return {
      ...base,
      severity: SEVERITY.UNKNOWN,
      incidentName: '',
      description: 'Status could not be determined.',
      components: [],
      warnings: ['no cloud documents to read'],
    };
  }

  const components = [];
  const votes = []; // severities of clouds that were actually verified
  const impacting = []; // "<cloud>: <service> — <event title>"
  const context = []; // visible:0 Under Investigation events
  let firstIncident = '';

  for (const entry of cloudDocs) {
    const label = typeof entry?.label === 'string' ? entry.label : 'unnamed cloud';
    const payload = entry?.data?.data;

    // The legend ships in every document; index it by tid.
    const legend = new Map();
    for (const s of Array.isArray(payload?.severity) ? payload.severity : []) {
      if (s && typeof s.tid === 'string') legend.set(s.tid, s);
    }

    const categories = Array.isArray(payload?.category) ? payload.category : null;
    if (!categories || categories.length === 0 || legend.size === 0) {
      // Fetch failure, reshape, or a legend we cannot read — this cloud was
      // NOT verified. It shows as unknown and warns, but does not vote: the
      // clouds that WERE verified still decide the row, mirroring how scoped
      // Statuspage vendors judge on matched components while warning about
      // missing ones.
      components.push({ name: label, severity: SEVERITY.UNKNOWN });
      warnings.push(`cloud "${label}" returned no readable status`);
      continue;
    }

    const cloudVotes = [];
    const detail = [];
    let servicesSeen = 0;

    for (const cat of categories) {
      const subs = Array.isArray(cat?.subCategory) ? cat.subCategory : [];
      servicesSeen += subs.length;
      for (const sub of subs) {
        const events = Array.isArray(sub?.category_status) ? sub.category_status : [];
        for (const ev of events) {
          const title = toPlainText(ev?.title) || 'Unnamed event';
          const legendEntry = legend.get(String(ev?.severityTid));

          if (!legendEntry) {
            // An active event whose severity we cannot classify is genuine
            // uncertainty, not health.
            cloudVotes.push(SEVERITY.UNKNOWN);
            warnings.push(
              `cloud "${label}": event "${title}" carries severity tid "${ev?.severityTid}" absent from the payload legend`,
            );
            continue;
          }

          const visible = legendEntry.visible === '1' || legendEntry.visible === 1;
          if (!visible) {
            // Zscaler's own legend calls these non-impacting. Under
            // Investigation is early-incident signal worth surfacing as
            // context; the rest (Informational, Security Advisory, No
            // Service Impact) are perpetual noise.
            if (/investigation/i.test(String(legendEntry.name))) {
              context.push(`${label}: ${title}`);
            }
            continue;
          }

          const sev = impactingSeverity(String(legendEntry.name));
          if (sev === null) {
            cloudVotes.push(SEVERITY.UNKNOWN);
            warnings.push(
              `cloud "${label}": impacting severity "${legendEntry.name}" is not recognised; failing closed`,
            );
            continue;
          }

          cloudVotes.push(sev);
          const subName = toPlainText(sub?.name) || 'service';
          impacting.push(`${label}: ${subName} — ${title}`);
          detail.push(`${subName} — ${title}`);
          if (!firstIncident) firstIncident = title;
        }
      }
    }

    // A category envelope with no services under it verified nothing — a
    // reshaped payload must not read green just because it parsed.
    if (servicesSeen === 0) {
      components.push({ name: label, severity: SEVERITY.UNKNOWN });
      warnings.push(`cloud "${label}" returned no readable status`);
      continue;
    }

    const cloudSeverity = cloudVotes.length > 0 ? worst(cloudVotes) : SEVERITY.OPERATIONAL;
    votes.push(cloudSeverity);
    components.push({
      name: label,
      severity: cloudSeverity,
      ...(detail.length > 0 ? { description: detail.join('; ') } : {}),
    });
  }

  // No cloud was verified at all -> nothing was checked, so nothing is known.
  const severity = votes.length > 0 ? worst(votes) : SEVERITY.UNKNOWN;

  let description;
  if (impacting.length > 0) {
    description = `Affected: ${impacting.join('; ')}.`;
  } else if (context.length > 0) {
    description = `Under investigation (no service impact reported): ${context.join('; ')}.`;
  } else if (severity === SEVERITY.OPERATIONAL) {
    description = `All ${votes.length} monitored Zscaler clouds report no active service events.`;
  } else {
    description = 'Status could not be determined.';
  }

  return {
    ...base,
    severity,
    incidentName: firstIncident,
    description,
    components,
    warnings,
  };
}
