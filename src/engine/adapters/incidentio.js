/**
 * incident.io page JSON -> Statuspage-shaped components (OpenAI, 2026-11-25).
 *
 * An incident.io status page serves a Statuspage-compatible `api/v2/summary.json`,
 * which the generic statuspage adapter reads for the page indicator, incidents and
 * components. For OpenAI that list is incomplete: 25 of the page's 37 components,
 * with the whole Codex group missing. On 2026-11-25 the board read Degraded (the
 * indicator) above "24 components · all healthy" while OpenAI's own page showed
 * Codex Web degraded. The page itself is drawn from `/proxy/<host>`, whose
 * `summary` holds every component (`components`), the groups they sit in
 * (`structure.items`) and the ones not operational (`affected_components`).
 *
 * This turns that document into components the statuspage adapter already knows
 * how to read: one entry per group (`group: true`, its status the worst of its
 * leaves) and one per leaf (`group_id` naming its group). Leaves not in
 * `affected_components` are operational, as the page draws them.
 *
 * Fails closed:
 * - A status word is passed through as the page gives it, so a word the shared
 *   vocabulary does not know (only `degraded_performance` has been seen live)
 *   reads `unknown` in normalizeSeverity, never operational.
 * - An affected component the structure does not list is KEPT, under a stand-in
 *   name with its own status, and named in a warning. Dropping it would drop a
 *   vote.
 *
 * The collector ADDS these to summary.json's components rather than replacing
 * them, so a component only the old feed lists still votes, and the row can never
 * read greener than the summary alone; dedupeByName keeps the worse of two
 * entries with one name.
 */

import { normalizeSeverity, rank } from '../severity.js';

/**
 * Is this a readable incident.io page document? Judges the DOCUMENT: a summary
 * with at least one component and a structure with at least one item.
 *
 * @param {unknown} doc
 * @returns {boolean}
 */
export function isReadableIncidentIo(doc) {
  const s = /** @type {any} */ (doc)?.summary;
  return (
    Array.isArray(s?.components) &&
    s.components.length > 0 &&
    Array.isArray(s?.structure?.items) &&
    s.structure.items.length > 0 &&
    // An empty list is a reading (nothing affected); a missing or non-list one is not, or every component
    // would read operational from a document that says nothing (Codex on #210)
    Array.isArray(s?.affected_components)
  );
}

/**
 * @param {any} doc an incident.io `/proxy/<host>` document
 * @returns {{components: any[], warnings: string[]}}
 */
export function incidentIoComponents(doc) {
  const s = doc?.summary ?? {};
  const warnings = [];
  const status = new Map();
  let unattributed = 0;
  for (const a of Array.isArray(s.affected_components) ? s.affected_components : []) {
    if (a && typeof a.component_id === 'string') status.set(a.component_id, a.status);
    else unattributed += 1;
  }
  const statusOf = (id) => (status.has(id) ? status.get(id) : 'operational');
  // The worst raw word of a set, by the shared ranking; an unknown word ranks as unknown.
  const worstWord = (words) =>
    words.reduce((w, x) => (rank(normalizeSeverity(x)) > rank(normalizeSeverity(w)) ? x : w), 'operational');

  const out = [];
  const listed = new Set();
  const leaf = (id, name, groupId) => {
    listed.add(id);
    const c = { id, name: typeof name === 'string' && name.trim() ? name.trim() : id, status: statusOf(id) };
    if (groupId) c.group_id = groupId;
    return c;
  };
  for (const item of Array.isArray(s.structure?.items) ? s.structure.items : []) {
    const g = item?.group;
    if (g && Array.isArray(g.components)) {
      const kids = g.components
        .filter((k) => k && typeof k.component_id === 'string')
        .map((k) => leaf(k.component_id, k.name, g.id));
      out.push({ id: g.id, name: String(g.name ?? g.id), group: true, status: worstWord(kids.map((k) => k.status)) });
      out.push(...kids);
    } else if (item?.component && typeof item.component.component_id === 'string') {
      out.push(leaf(item.component.component_id, item.component.name));
    }
  }
  for (const [id, word] of status) {
    if (listed.has(id)) continue;
    warnings.push(`the status page marks a component (${id}) it does not list as ${String(word)}`);
    out.push({ id, name: `Unlisted component ${id}`, status: word });
  }
  // An affected entry naming no component cannot be placed, and cannot be read as healthy either: one unknown
  // vote and ONE warning with a count, none of the vendor's words (Codex on #210)
  if (unattributed > 0) {
    warnings.push(`${unattributed} affected ${unattributed === 1 ? 'entry' : 'entries'} on the status page ${unattributed === 1 ? 'names' : 'name'} no component, so ${unattributed === 1 ? 'it is' : 'they are'} counted as unknown`);
    out.push({ id: 'unattributed', name: 'Unattributed affected entries', status: 'unknown' });
  }
  return { components: out, warnings };
}
