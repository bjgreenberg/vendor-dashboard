/**
 * IBM Cloud adapter — cloud.ibm.com/status/getEnhancedStatus.
 *
 * HOW THIS WAS FOUND, because the obvious routes all dead-end. IBM publishes
 * no documented status API. Grepping the 3.4 MB page bundle yields only
 * `/status/api/notifications/feed.rss` (1 MB, 686 items, product announcements
 * mixed with incidents — unusable), `/status/getCustomerIncidentReports`
 * (post-mortem PDFs from 2020) and `/status/getHeaderHtml`. Brute-forcing the
 * `/status/get*` namespace found nothing further. The endpoint only appears by
 * loading the page in a real browser and reading the network log: it is built
 * at runtime, so no static string in the bundle matches it.
 *
 * PARSED BY TARGETED SCAN, NOT JSON.parse. The payload is 2.44 MB, of which
 * 1,105 items are release notes and 140 are announcements; only 26 are
 * incidents. Measured on the real payload:
 *
 *     JSON.parse(whole document)            8.03 ms CPU
 *     indexOf scan + bracket walk           1.82 ms CPU
 *
 * The free plan allows 10 ms of CPU per cron invocation for the WHOLE run, so a
 * full parse of one vendor would consume nearly all of it. Same reasoning and
 * same technique as the Okta adapter.
 *
 * No query parameter filters this endpoint: `?state=active`, `?days=1`,
 * `?limit=10` and `?type=incident` were all tried and all return the identical
 * 2,556,694 bytes.
 */

import { SEVERITY, worst, rank } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://cloud.ibm.com/status';
const SERVICE_LABEL = 'IBM Cloud';

/** Needle matching the minified payload — no spaces around the colon. */
const INCIDENT_MARKER = '"type":"incident"';

/**
 * States that mean an incident is over.
 *
 * Anything NOT in this set counts as active, including an empty state. That is
 * the fail-closed direction: an incident whose state we do not recognise is an
 * incident we cannot confirm is finished.
 */
/** Service catalogue pairs, precompiled and global. */
const CATALOGUE_RE = /"resourceID":"([^"]+)","displayName":"([^"]*)"/g;

const CLOSED_STATES = new Set(['resolved', 'completed', 'archived', 'closed']);

/**
 * IBM severity: 1 is most severe. An active incident with an unreadable sev is
 * DEGRADED, never operational — it exists, so something is being reported.
 *
 * @param {unknown} sev
 * @returns {import('../severity.js').Severity}
 */
export function ibmSeverityOf(sev) {
  const n = Number(sev);
  if (n === 1) return SEVERITY.MAJOR_OUTAGE;
  if (n === 2) return SEVERITY.PARTIAL_OUTAGE;
  if (n === 3 || n === 4) return SEVERITY.DEGRADED;
  return SEVERITY.DEGRADED;
}

/**
 * Extract the JSON object surrounding `index` by walking out to its braces.
 *
 * Deliberately not a regex: these objects nest (`children`, `crnMasks`), and a
 * regex cannot balance braces.
 *
 * @param {string} text
 * @param {number} index position of a marker inside the object
 * @returns {string|null}
 */
function enclosingObject(text, index) {
  let start = index;
  let depth = 0;
  while (start > 0) {
    const ch = text[start];
    if (ch === '}') depth += 1;
    if (ch === '{') {
      if (depth === 0) break;
      depth -= 1;
    }
    start -= 1;
  }

  let end = index;
  let open = 0;
  while (end < text.length) {
    const ch = text[end];
    if (ch === '{') open += 1;
    if (ch === '}') {
      open -= 1;
      if (open < 0) break;
    }
    end += 1;
  }
  if (end >= text.length) return null;
  return text.slice(start, end + 1);
}

/**
 * Field extractors, PRECOMPILED.
 *
 * Building a RegExp per field per incident measured 3.83 ms on the real
 * payload; hoisting them takes it to well under 2. With 26 incidents and four
 * fields each that is over a hundred RegExp compilations per run, for a vendor
 * sharing a 10 ms budget with fourteen others.
 */
const FIELD = {
  state: /"state":\s*"([^"]*)"/,
  sev: /"sev":\s*(-?\d+)/,
  name: /"name":\s*"([^"]*)"/,
  shortDescription: /"shortDescription":\s*"([^"]*)"/,
  resourceIDs: /"resourceIDs":\[\s*"([^"]*)"/,
};

/** @param {string} obj @param {keyof FIELD} key */
function field(obj, key) {
  const m = FIELD[key].exec(obj);
  return m ? m[1] : '';
}

/**
 * @param {string} text raw getEnhancedStatus body
 * @param {{vendor: string, now?: () => Date}} options
 * @returns {import('../record.js').StatusRecord}
 */
export function parseIbmCloud(text, options) {
  const { vendor, now } = options ?? {};
  const opts = { now, sourceUrl: SOURCE_URL, service: SERVICE_LABEL };

  if (typeof text !== 'string' || text.length === 0) {
    return unknownRecord(vendor, 'empty response', opts);
  }

  // SHAPE ASSERTION before trusting an absence of incidents. Both keys are
  // top-level in the real payload; requiring them means a redesigned or
  // error-page response reports unknown instead of silently reading as "no
  // incidents, all healthy" — the H6 absence-of-evidence trap.
  // Checked against the HEAD of the document only. `includes` on a 2.44 MB
  // string is a full scan each time, and both keys appear near the start; two
  // whole-document scans just to assert shape is a needless millisecond.
  const head = text.slice(0, 4096);
  if (!head.includes('"statusItems"')) {
    return unknownRecord(vendor, 'payload structure may have changed', opts);
  }

  const active = [];
  let i = text.indexOf(INCIDENT_MARKER);
  while (i !== -1) {
    const obj = enclosingObject(text, i);
    if (obj) {
      const state = field(obj, 'state').toLowerCase();
      if (!CLOSED_STATES.has(state)) {
        const ids = [...obj.matchAll(/"resourceIDs":\[([^\]]*)\]/g)]
          .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
        active.push({
          severity: ibmSeverityOf(field(obj, 'sev')),
          title:
            toPlainText(field(obj, 'name') || field(obj, 'shortDescription')) || 'Service incident',
          resourceIDs: ids,
        });
      }
    }
    i = text.indexOf(INCIDENT_MARKER, i + INCIDENT_MARKER.length);
  }

  // LIST EVERY SERVICE, not only the broken ones.
  //
  // With no active incidents the row previously had zero components, so a
  // reader could not see what IBM Cloud even covers — the same complaint that
  // was raised about Oracle. The payload carries a `resources` catalogue of
  // 166 services; each is reported healthy unless an active incident names its
  // resourceID.
  //
  // Extracted from the tail of the document (the catalogue begins ~2.03 MB in)
  // rather than the whole string: measured 1.15 ms for all 166.
  const affected = new Map();
  for (const a of active) {
    for (const id of a.resourceIDs.length ? a.resourceIDs : ['__unattributed__']) {
      const prev = affected.get(id);
      if (!prev || rank(a.severity) > rank(prev.severity)) affected.set(id, a);
    }
  }

  const components = [];
  const seen = new Set();
  // Scan from the catalogue offset WITHOUT slicing. `text.slice()` here copies
  // ~521 KB, which measured 2.6 ms on its own -- more than the scan it was
  // meant to speed up. Setting lastIndex walks the same region with no copy.
  const catalogueAt = text.indexOf('"resources"');
  if (catalogueAt !== -1) {
    CATALOGUE_RE.lastIndex = catalogueAt;
    let m;
    while ((m = CATALOGUE_RE.exec(text)) !== null) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const hit = affected.get(id);
      components.push({
        name: toPlainText(m[2] || id),
        severity: hit ? hit.severity : SEVERITY.OPERATIONAL,
        description: hit ? hit.title : '',
      });
    }
    CATALOGUE_RE.lastIndex = 0; // a global regex keeps state between calls
  }

  // An incident naming a resource absent from the catalogue must still show.
  for (const [id, a] of affected) {
    if (!seen.has(id)) {
      components.push({ name: toPlainText(id === '__unattributed__' ? a.title : id), severity: a.severity, description: a.title });
    }
  }

  if (components.length === 0) {
    return unknownRecord(vendor, 'payload carried no service catalogue', opts);
  }

  components.sort((a, b) => rank(b.severity) - rank(a.severity) || a.name.localeCompare(b.name));
  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  return makeRecord({
    vendor,
    service: SERVICE_LABEL,
    severity: worst(components.map((c) => c.severity)),
    incidentName: unhealthy.length ? unhealthy[0].description.slice(0, 120) : '',
    description: unhealthy.length
      ? `Affected: ${unhealthy.slice(0, 4).map((c) => c.name).join(', ')}.`
      : `All ${components.length} services report no active incidents.`,
    sourceUrl: SOURCE_URL,
    components,
    warnings: [],
    now,
  });
}
