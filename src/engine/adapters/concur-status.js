/**
 * Concur per-service status, from `open.concur.com/api/open/status_history`.
 *
 * REPLACES the incidents feed, which is 23.3 MB — the complete incident history
 * back to 2013, re-downloaded and re-parsed every cycle to find the handful
 * that are open. No filter exists: `?open=true`, `?status=open`, `?limit=25`
 * and `?days=7` all return the identical 23,354,922 bytes. Parsing it measured
 * 69 ms of CPU against a 10 ms per-invocation ceiling, and was the single
 * largest contributor to the 2026-08-01 outage.
 *
 * status_history was found in the status page's network log. It is keyed by
 * SERVICE and carries a `Current Status` for each, which is exactly what the
 * board needs, at 35–300 KB per data centre.
 *
 * Shape:
 *   { data: { Expense: { Service: "Expense",
 *                        "Current Status": { status: "normal", incidents: [] },
 *                        "2026-08-01T-0500": {...} } } }
 *
 * ALL FOUR data centres are read and merged, worst-wins. Reading only us2
 * would report Concur healthy while EU customers were down — the false green
 * this project exists to prevent — and the four together are still 38x cheaper
 * than the feed they replace.
 */

import { SEVERITY, worst, rank } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://open.concur.com/';
const SERVICE_LABEL = 'Concur';

/** Concur's vocabulary. Anything unrecognised fails closed. */
const STATUS = Object.freeze(
  Object.assign(Object.create(null), {
    normal: SEVERITY.OPERATIONAL,
    operational: SEVERITY.OPERATIONAL,
    available: SEVERITY.OPERATIONAL,
    degraded: SEVERITY.DEGRADED,
    degradation: SEVERITY.DEGRADED,
    warning: SEVERITY.DEGRADED,
    partial: SEVERITY.PARTIAL_OUTAGE,
    major: SEVERITY.MAJOR_OUTAGE,
    outage: SEVERITY.MAJOR_OUTAGE,
    unavailable: SEVERITY.MAJOR_OUTAGE,
    maintenance: SEVERITY.MAINTENANCE,
  }),
);

/** @param {unknown} raw */
export function concurSeverityOf(raw) {
  const key = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return key ? (STATUS[key] ?? SEVERITY.UNKNOWN) : SEVERITY.UNKNOWN;
}

/**
 * Is this status_history document a reading: does at least one service in it
 * carry a Current Status?
 *
 * A document can answer 200, parse, and hold nothing (`{"success":true}`).
 * The collector asks this before counting a data centre as read, so that an
 * empty answer is reported as a data centre that could not be read rather
 * than merged in as silence (worklist #132).
 *
 * @param {any} doc one parsed status_history document
 * @returns {boolean}
 */
export function isReadableConcurDoc(doc) {
  const data = doc?.data;
  if (!data || typeof data !== 'object') return false;
  return Object.values(data).some((entry) => Boolean(entry?.['Current Status']));
}

/**
 * @param {any} payloads one parsed status_history document per data centre
 *   that was READ. A data centre that could not be read is not in this list;
 *   it is named in `options.unreadDataCenters`.
 * @param {{vendor: string, banner?: any, now?: () => Date, dataCenters?: string[], unreadDataCenters?: string[]}} options
 *   `dataCenters`: the data centres that MUST be read (config; today US2,
 *   because the board judges from the United States). If one of them is among
 *   `unreadDataCenters` it counts as an UNKNOWN vote: the row cannot read
 *   green or maintenance from the others, and it is unknown unless trouble
 *   verified in another data centre is worse, in which case that trouble
 *   shows (worst wins, as for a vendor of several feeds).
 *   `unreadDataCenters`: every data centre the collector could not read. Each
 *   shows as an unknown component; one that is not required does not vote.
 *   The collector puts the note on the card.
 * @returns {import('../record.js').StatusRecord}
 */
export function parseConcurStatus(payloads, options) {
  const { vendor, banner, now, dataCenters, unreadDataCenters } = options ?? {};
  const opts = { now, sourceUrl: SOURCE_URL, service: SERVICE_LABEL };

  const unread = (Array.isArray(unreadDataCenters) ? unreadDataCenters : []).map(String);
  const required = new Set((Array.isArray(dataCenters) ? dataCenters : []).map((dc) => String(dc).toUpperCase()));
  const missingRequired = unread.filter((dc) => required.has(dc.toUpperCase()));
  // Written for the card: when the row is unknown for this reason, this text
  // is what a reader sees on it.
  const requiredReason =
    missingRequired.length > 0
      ? `Concur's ${
          missingRequired.length === 1
            ? missingRequired[0]
            : `${missingRequired.slice(0, -1).join(', ')} and ${missingRequired.at(-1)}`
        } data centre${missingRequired.length === 1 ? '' : 's'} could not be read, so its status is not shown.`
      : null;

  const docs = (Array.isArray(payloads) ? payloads : [payloads]).filter(
    (d) => d && typeof d === 'object' && d.data && typeof d.data === 'object',
  );
  if (docs.length === 0) {
    return unknownRecord(vendor, requiredReason ?? 'no usable status_history payload', opts);
  }

  /** @type {Map<string, {severity: string, bad: string[]}>} */
  const services = new Map();
  // A status word this adapter does not know fails closed, and says so: an
  // Unknown card with no line under it explains nothing.
  const unrecognised = new Set();
  for (const doc of docs) {
    for (const [name, entry] of Object.entries(doc.data)) {
      const current = entry?.['Current Status'];
      if (!current) continue;
      const severity = concurSeverityOf(current.status);
      const clean = toPlainText(entry?.Service ?? name);
      if (severity === SEVERITY.UNKNOWN) {
        unrecognised.add(`unrecognised status "${String(current.status).slice(0, 40)}" on "${clean}"`);
      }
      const prev = services.get(clean) ?? { severity: SEVERITY.OPERATIONAL, bad: [] };
      if (rank(severity) > rank(prev.severity)) prev.severity = severity;
      if (severity !== SEVERITY.OPERATIONAL) prev.bad.push(String(current.status ?? ''));
      services.set(clean, prev);
    }
  }

  if (services.size === 0) {
    return unknownRecord(vendor, requiredReason ?? 'status_history carried no services', opts);
  }

  const components = [...services.entries()]
    .map(([name, v]) => ({ name, severity: v.severity, description: '' }))
    .sort((a, b) => rank(b.severity) - rank(a.severity) || a.name.localeCompare(b.name));

  const unhealthy = components.filter((c) => c.severity !== SEVERITY.OPERATIONAL);

  // Concur's own banner is a "something is wrong" flag; treat it as a FLOOR so
  // a problem announced there is never reported as fully healthy.
  const bannerActive = banner?.data?.display === true;
  const severity = worst([
    ...components.map((c) => c.severity),
    bannerActive ? SEVERITY.DEGRADED : SEVERITY.OPERATIONAL,
    // A required data centre that could not be read is an unknown vote: it
    // outranks operational and maintenance, and yields to verified trouble.
    requiredReason ? SEVERITY.UNKNOWN : SEVERITY.OPERATIONAL,
  ]);

  // The row is unknown BECAUSE a required data centre was not read. Then the
  // card says that and nothing else: "Affected: Expense." under an Unknown
  // badge would read as a verdict. What was read is still in the components.
  const undetermined = Boolean(requiredReason) && severity === SEVERITY.UNKNOWN;

  // Concur's own words when it sends them, cut to a card's length before and
  // after cleaning (the cleaner is slow on pathological input). The render
  // layer escapes.
  const en = banner?.data?.text?.en;
  const bannerText =
    (typeof en === 'string' ? toPlainText(en.slice(0, 1000)).slice(0, 300) : '') || 'Concur is displaying a status banner.';

  // Both, when both apply: maintenance plus a displayed banner reads
  // Degraded, and only the banner's text says why.
  const said = [
    ...(unhealthy.length ? [`Affected: ${unhealthy.map((c) => c.name).join(', ')}.`] : []),
    ...(bannerActive ? [bannerText] : []),
  ];

  return makeRecord({
    vendor,
    service: SERVICE_LABEL,
    severity,
    incidentName: undetermined ? '' : unhealthy.length ? 'Service issue' : bannerActive ? 'Status banner displayed' : '',
    description: undetermined
      ? 'Status could not be determined.'
      : said.length
        ? said.join(' ')
        : `All ${components.length} services report normal.`,
    sourceUrl: SOURCE_URL,
    // After the services, and after the severity above was decided: a data
    // centre that could not be read is shown. Only a REQUIRED one votes, and
    // its vote is already in `severity`.
    components: [
      ...components,
      ...unread.map((dc) => ({ name: `Data centre ${dc}`, severity: SEVERITY.UNKNOWN, description: 'Could not be read.' })),
    ],
    // When trouble verified elsewhere outranks the unknown, the row has a
    // status and the collector's note names what is missing instead.
    warnings: [...(undetermined ? [requiredReason] : []), ...unrecognised],
    now,
  });
}
