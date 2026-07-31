/**
 * Component scoping — deciding which of a vendor's components you actually
 * care about.
 *
 * Runtime-agnostic: pure functions, no platform APIs.
 *
 * Resolves audit finding H3. The predecessor declared a `FILTERS` map in config
 * and accepted an `allowedComponents` parameter, but never read it in the
 * function body. The config was inert, and the tool had no way to express "I
 * care about Cloudflare Workers, not the Guam edge PoP."
 *
 * That single gap produced errors in BOTH directions on live data:
 *
 *  - **Under-reporting.** Cloudflare publishes ~470 components, most of them
 *    edge PoPs. On 2026-07-30, 26 were `partial_outage` and 20
 *    `under_maintenance` — Arica, Baghdad, Guam. That is routine re-routing,
 *    i.e. the redundancy working as designed.
 *  - **Over-reporting.** KnowBe4 had an open incident about a blank purchasing
 *    page on their online store while their own page indicator read `none`.
 *
 * Naive component roll-up is therefore NOT the fix — it would paint Cloudflare
 * permanently red. Scoping is what makes the signal decidable.
 */

/**
 * @typedef {object} Component
 * @property {string} id
 * @property {string} name
 * @property {string} status
 * @property {boolean} [group]      true when this entry is a group header
 * @property {string|null} [group_id] parent group id for a child component
 */

/**
 * @typedef {object} Scope
 * @property {string[]} [groups]     include every member of these group names
 * @property {string[]} [components] include components with these exact names
 */

/**
 * @typedef {object} ScopeResult
 * @property {Component[]} selected  components in scope (never group headers)
 * @property {boolean} scoped        false when no scope was configured, so the
 *                                   caller knows to trust the page indicator
 * @property {string[]} warnings     configured names that matched nothing live
 */

/**
 * Select the components a vendor's config says to care about.
 *
 * With no scope configured, returns every non-group component and reports
 * `scoped: false` — the caller should then prefer the vendor's own page-level
 * indicator, which is that vendor's considered judgement about its own health.
 *
 * Fails closed on malformed input: an empty or missing component list yields an
 * empty selection plus a warning, never a throw. One vendor reshaping its
 * payload must not take down the run (the isolation property the predecessor
 * got right and which is worth preserving).
 *
 * @param {{components?: Component[]}|null|undefined} payload  Statuspage-shaped payload
 * @param {Scope} [scope]
 * @returns {ScopeResult}
 */
export function selectComponents(payload, scope = {}) {
  const warnings = [];
  const all = Array.isArray(payload?.components) ? payload.components : [];

  const groupNames = Array.isArray(scope?.groups) ? scope.groups : [];
  const componentNames = Array.isArray(scope?.components) ? scope.components : [];
  const scoped = groupNames.length > 0 || componentNames.length > 0;

  if (all.length === 0) {
    if (scoped) warnings.push('payload contained no components; scope could not be applied');
    return { selected: [], scoped, warnings };
  }

  // Group headers are metadata, never results in their own right.
  const leaves = all.filter((c) => !c.group);

  if (!scoped) {
    return { selected: leaves, scoped: false, warnings };
  }

  // Map group name -> id so children can be resolved via group_id. Statuspage
  // also carries a `components: [ids]` array on the group, but group_id on the
  // child is the more reliable direction: it survives payloads where the group
  // listing is stale.
  const groupIdsByName = new Map();
  for (const c of all) {
    if (c.group) groupIdsByName.set(c.name, c.id);
  }

  const wantedGroupIds = new Set();
  for (const name of groupNames) {
    const id = groupIdsByName.get(name);
    if (id === undefined) {
      warnings.push(`configured group "${name}" matched no group in the live payload`);
      continue;
    }
    wantedGroupIds.add(id);
  }

  const wantedNames = new Set(componentNames);
  const liveNames = new Set(leaves.map((c) => c.name));
  for (const name of componentNames) {
    if (!liveNames.has(name)) {
      warnings.push(`configured component "${name}" matched no component in the live payload`);
    }
  }

  // Union of both selectors, de-duplicated by component id.
  const seen = new Set();
  const selected = [];
  for (const c of leaves) {
    const byGroup = c.group_id != null && wantedGroupIds.has(c.group_id);
    const byName = wantedNames.has(c.name);
    if ((byGroup || byName) && !seen.has(c.id)) {
      seen.add(c.id);
      selected.push(c);
    }
  }

  return { selected, scoped: true, warnings };
}
