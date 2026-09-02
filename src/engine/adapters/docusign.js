/**
 * Docusign health adapter — health.docusign.com, NOT a Statuspage.
 *
 * Docusign retired status.docusign.com (Atlassian Statuspage) in favour of
 * health.docusign.com, a Next.js app whose HTML carries no status at all; the
 * page fetches two JSON documents client-side (found by reading the page's
 * network log, 2026-09-01):
 *
 *   .../dynamic/components.json   the product tree — every component carries
 *                                 its own `status`
 *   .../dynamic/incidents.json    the last ~100 incidents, resolved included
 *
 * HOW SEVERITY IS DECIDED:
 *
 * - components.json is the vote. The tree is three levels deep (product →
 *   product → per-datacentre site, plus one `group`). The row DISPLAYS the
 *   six roots (CLM, eSignature, IAM Features, …), each rolled up as the worst
 *   of itself and every descendant — the equivalent of the old
 *   `componentLevel: "group"` view, so the card keeps the shape readers knew.
 * - incidents.json is context AND a second vote: an incident whose `status`
 *   is not `resolved` supplies the row's incidentName/description (title +
 *   latest update by `displayAt`) and votes with its `impact`. Components
 *   alone would do, except that the old Statuspage feed kept incident text
 *   on the card and readers rely on it.
 *
 * Vocabulary, observed live and in 100 historical incidents — the same three
 * words serve component status, incident impact and incident-component
 * status: `available`, `performance_degradation`, `service_disruption`.
 * Nothing else is mapped.
 *
 * Fails closed. A component or active incident using a word outside that
 * vocabulary marks the row UNKNOWN with a warning naming the word — the honest
 * answer to "Docusign changed their feed" is uncertainty, not green (audit
 * findings H4/H6/H7). A missing or unreadable incidents document only warns:
 * the components still decide, because the incidents fetch is advisory and
 * its loss must not blank a row whose primary feed is fine.
 */

import { SEVERITY, rank, worst } from '../severity.js';
import { toPlainText } from '../record.js';

/**
 * @typedef {import('./statuspage.js').StatusRecord} StatusRecord
 */

/** The only words Docusign's feeds have ever been seen to use. */
const STATUS_MAP = Object.freeze({
  available: SEVERITY.OPERATIONAL,
  performance_degradation: SEVERITY.DEGRADED,
  service_disruption: SEVERITY.MAJOR_OUTAGE,
});

/**
 * @param {unknown} word a Docusign status/impact word
 * @returns {import('../severity.js').Severity|null} null when unrecognised
 */
function mapWord(word) {
  if (typeof word !== 'string') return null;
  return STATUS_MAP[word.trim().toLowerCase()] ?? null;
}

/**
 * Parse the health.docusign.com documents into one status record.
 *
 * @param {any} payload parsed components.json
 * @param {object} options
 * @param {string} options.vendor
 * @param {string} [options.service]
 * @param {string} [options.sourceUrl]
 * @param {any} [options.incidents] parsed incidents.json; undefined/null when
 *   the advisory fetch failed
 * @param {() => Date} [options.now] injected clock for deterministic tests
 * @returns {StatusRecord}
 */
export function parseDocusign(payload, options) {
  const { vendor, service, sourceUrl, incidents, now = () => new Date() } = options ?? {};
  const warnings = [];

  const base = {
    vendor: vendor ?? 'unknown',
    service: service ?? vendor ?? 'unknown',
    sourceUrl: sourceUrl ?? '',
    checkedAt: now().toISOString(),
  };
  const unknown = (reason) => ({
    ...base,
    severity: SEVERITY.UNKNOWN,
    incidentName: '',
    description: 'Status could not be determined.',
    components: [],
    warnings: [...warnings, reason],
  });

  const list = payload?.components;
  if (!Array.isArray(list) || list.length === 0) {
    return unknown('components.json carried no component list');
  }

  // Index the tree once. The feed states each edge twice — `parentId` on the
  // child and `children[]` on the parent — and the two agreed exactly in the
  // live capture (74 edges each). Take the UNION so a child either side
  // claims reaches every parent that names it; a shared child then votes for
  // each of them, not only the first one walked.
  const byId = new Map();
  for (const c of list) {
    if (c && typeof c === 'object' && typeof c.id === 'string') byId.set(c.id, c);
  }
  const childrenOf = new Map();
  const hasParent = new Set();
  const link = (parentId, childId) => {
    if (!byId.has(parentId) || !byId.has(childId) || parentId === childId) return;
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, new Set());
    childrenOf.get(parentId).add(childId);
    hasParent.add(childId);
  };
  for (const c of byId.values()) {
    if (typeof c.parentId === 'string') link(c.parentId, c.id);
    if (Array.isArray(c.children)) for (const k of c.children) link(c.id, k);
  }

  /**
   * Worst of a component and all its descendants. Memoised per node so a
   * shared child is judged once and counted for every parent; the recursion
   * PATH (not a global visited-set) detects cycles, which fail closed — a
   * malformed tree is uncertainty, not health. Unknown words fail closed too.
   */
  const memo = new Map();
  const rollUp = (id, path) => {
    if (memo.has(id)) return memo.get(id);
    if (path.has(id)) {
      warnings.push(`component tree contains a cycle through "${byId.get(id)?.name ?? id}"`);
      return SEVERITY.UNKNOWN;
    }
    const c = byId.get(id);
    const own = mapWord(c.status);
    if (own === null) {
      warnings.push(`unrecognised component status "${String(c.status)}" on "${c.name ?? c.id}"`);
    }
    path.add(id);
    const kids = [...(childrenOf.get(id) ?? [])].map((k) => rollUp(k, path));
    path.delete(id);
    const result = worst([own ?? SEVERITY.UNKNOWN, ...kids]);
    memo.set(id, result);
    return result;
  };

  const roots = [...byId.values()].filter((c) => !hasParent.has(c.id));
  if (roots.length === 0) {
    return unknown(
      byId.size === 0
        ? 'components.json carried no usable components'
        : 'component tree has no root — every component names a parent (cycle)',
    );
  }
  const components = roots.map((c) => ({
    name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : c.id,
    severity: rollUp(c.id, new Set()),
  }));

  // Incidents: advisory document, but an ACTIVE one votes.
  let incidentName = '';
  let description = '';
  let incidentSeverity = SEVERITY.OPERATIONAL;
  const incidentList = incidents?.incidents;
  if (!Array.isArray(incidentList)) {
    warnings.push('incidents.json unavailable; judged on components alone');
  } else {
    const active = incidentList.filter(
      (i) => i && typeof i === 'object' && typeof i.status === 'string' && i.status.toLowerCase() !== 'resolved',
    );
    let lead = null;
    for (const i of active) {
      let sev = mapWord(i.impact);
      if (sev === null) {
        warnings.push(`unrecognised incident impact "${String(i.impact)}" on "${i.title ?? i.id}"`);
        sev = SEVERITY.UNKNOWN;
      }
      // Lead with the worst-impact incident so the headline matches the colour.
      if (lead === null || rank(sev) > rank(lead.sev)) lead = { incident: i, sev };
    }
    if (lead !== null) {
      incidentSeverity = lead.sev;
      incidentName = toPlainText(lead.incident.title);
      const latest = (Array.isArray(lead.incident.events) ? lead.incident.events : [])
        .filter((e) => e && typeof e.body === 'string')
        .sort((a, b) => String(b.displayAt ?? '').localeCompare(String(a.displayAt ?? '')))[0];
      description = toPlainText(latest?.body);
    }
  }

  return {
    ...base,
    severity: worst([...components.map((c) => c.severity), incidentSeverity]),
    incidentName,
    description,
    components,
    warnings,
  };
}
