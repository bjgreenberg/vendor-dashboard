/**
 * SAP Concur adapter.
 *
 * Resolves audit finding H7. `open.concur.com` is now a client-side React app
 * whose served HTML is an empty shell ("You need to enable JavaScript to run
 * this app", 58 characters of visible text). The predecessor scraped that HTML
 * for the strings "Disruption"/"Degradation" -- neither of which appears -- and
 * its guard `html.includes("Concur")` passed anyway because the word sits in
 * the shell's <title>. Result: Concur reported Operational unconditionally.
 *
 * This adapter uses the JSON API the React app itself calls, discovered in its
 * bundle: https://open.concur.com/api/open/incidents (+ /api/v3/banner).
 */

import { SEVERITY } from '../severity.js';
import { makeRecord, unknownRecord, toPlainText } from '../record.js';

const SOURCE_URL = 'https://open.concur.com';

/** Concur marks a closed incident with a past `end_epoch`; 0/absent means open. */
function isOpen(incident, nowSeconds) {
  if (String(incident?.status ?? '').toUpperCase() === 'RESOLVED') return false;
  const end = Number(incident?.end_epoch ?? 0);
  return !end || end > nowSeconds;
}

function severityOf(incident) {
  const s = String(incident?.severity ?? '').toLowerCase();
  if (s.includes('disruption')) return SEVERITY.PARTIAL_OUTAGE;
  if (s.includes('degradation') || s.includes('performance')) return SEVERITY.DEGRADED;
  return SEVERITY.DEGRADED;
}

/**
 * @param {any} payload  parsed /api/open/incidents
 * @param {object} options
 * @param {string} options.vendor
 * @param {any} [options.banner]        parsed /api/v3/banner
 * @param {string[]} [options.dataCenters] restrict to these data centres, e.g. ['US2']
 * @param {() => Date} [options.now]
 * @returns {import('../record.js').StatusRecord}
 */
export function parseConcur(payload, options) {
  const { vendor, banner, dataCenters, serviceCatalogue, now = () => new Date() } = options ?? {};

  /**
   * Every service Concur publishes, from the catalogue endpoint.
   *
   * The catalogue is keyed by priority tier (P1, P2) and the same service
   * appears in more than one tier, so names are deduped. Without this the row
   * listed services only while something was broken and showed NOTHING when
   * healthy -- a reader could not see what Concur even covers.
   */
  const catalogued = [];
  for (const tier of Object.values(serviceCatalogue ?? {})) {
    for (const s of tier?.services ?? []) {
      const name = String(s?.name ?? '').trim();
      if (name && !catalogued.includes(name)) catalogued.push(name);
    }
  }
  if (!payload || !Array.isArray(payload.incidents)) {
    return unknownRecord(vendor, 'payload had no incidents array', { now, sourceUrl: SOURCE_URL });
  }

  const nowSeconds = Math.floor(now().getTime() / 1000);
  let open = payload.incidents.filter((i) => isOpen(i, nowSeconds));

  if (Array.isArray(dataCenters) && dataCenters.length > 0) {
    const wanted = dataCenters.map((d) => d.toLowerCase());
    open = open.filter((i) =>
      (i?.data_centers ?? []).some((dc) => wanted.includes(String(dc).toLowerCase())),
    );
  }

  const warnings = [];
  // The banner is Concur's own "something is wrong" flag; treat it as a floor
  // so a problem announced there is never reported as fully healthy.
  const bannerActive = banner?.data?.display === true;
  if (bannerActive && open.length === 0) {
    warnings.push('Concur status banner is displayed but no matching open incident was found');
  }

  if (open.length === 0 && !bannerActive) {
    return makeRecord({
      vendor,
      service: dataCenters?.length ? `Concur (${dataCenters.join(', ')})` : 'Concur',
      severity: SEVERITY.OPERATIONAL,
      description: catalogued.length
        ? `All ${catalogued.length} services operational.`
        : 'All systems operational.',
      sourceUrl: SOURCE_URL,
      components: catalogued.map((name) => ({
        name,
        severity: SEVERITY.OPERATIONAL,
        description: '',
      })),
      warnings,
      now,
    });
  }

  const components = open.slice(0, 10).flatMap((i) =>
    (i?.affected_services ?? ['Concur']).map((svc) => ({
      name: String(svc),
      severity: severityOf(i),
      description: toPlainText(i?.messages?.[0]?.message ?? ''),
    })),
  );

  const severity = open.length > 0 ? severityOf(open[0]) : SEVERITY.DEGRADED;

  return makeRecord({
    vendor,
    service: dataCenters?.length ? `Concur (${dataCenters.join(', ')})` : 'Concur',
    severity,
    incidentName: open[0] ? `Incident ${open[0].id ?? ''}`.trim() : 'Status banner active',
    description:
      toPlainText(open[0]?.messages?.[0]?.message ?? '') ||
      'Issue reported on the Concur status page.',
    sourceUrl: SOURCE_URL,
    components,
    warnings,
    now,
  });
}
