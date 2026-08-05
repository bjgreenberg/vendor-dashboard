/**
 * Atlassian Statuspage v2 adapter — the generic path most vendors use.
 *
 * Runtime-agnostic: pure function over a parsed payload. No fetching, no
 * platform APIs. The caller supplies the payload and an injected clock, which
 * is what makes this deterministically testable against recorded fixtures.
 *
 * Resolves audit findings M1, M2, H3, H4 and L4.
 */

import { SEVERITY, normalizeSeverity, worst, rank } from '../severity.js';
import { selectComponents } from '../scope.js';

/**
 * Region tokens that appear as a trailing " - SUFFIX" on component names.
 *
 * Zoom splits three products across regions at group level — "Zoom Phone -
 * APAC", "Zoom CX - EMEA", "Zoom Virtual Agent - JAPAN" — turning 13 real
 * products into 33 rows. Stripping the suffix and deduplicating collapses them
 * back to the product a reader actually recognises.
 *
 * Deliberately conservative: only these exact tokens are stripped, so a service
 * genuinely named "Something - Foo" is untouched. Matching is case-insensitive
 * and anchored to the END of the name.
 */
const REGION_SUFFIXES = [
  'GLOBAL', 'APAC', 'EMEA', 'AMER', 'AMERICAS', 'NORTH AMERICA', 'LATIN AMERICA',
  'SOUTH AMERICA', 'AUSTRALIA', 'JAPAN', 'CHINA', 'HONG KONG/CHINA', 'INDIA',
  'CANADA', 'EUROPE', 'US', 'USA', 'EU', 'UK', 'AU', 'AUS', 'NA',
];

// Deliberately NOT stripped: "Gov". Lucid publishes "Document List (Gov)"
// alongside (US)/(EU)/(AUS) — a government cloud is a separate offering with its
// own availability, not a region of the commercial one. Collapsing it would hide
// a real distinction.

// Full regex escape, not just '/': today's tokens are metachar-free, but a
// future "US (East)" must not silently corrupt the alternation (CodeQL #7).
const REGION_ALT = REGION_SUFFIXES.map((r) => r.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');

/** " - APAC" / " – EMEA" at the end of a name. */
const REGION_DASH_RE = new RegExp(`\\s[-\u2013]\\s(?:${REGION_ALT})\\s*$`, 'i');

/**
 * " (US)" / " (North America)" at the end of a name.
 *
 * Lucid publishes "Document List (US)", "Document List (EU)" and so on — one
 * service per region. Restricting to the same explicit token list is what keeps
 * legitimate parenthetical acronyms intact: "(MFA)", "(BYOIP)", "(KSAT)",
 * "(JCDS)" and "(Consumer)" are all part of the real service name and survive.
 */
const REGION_PARENS_RE = new RegExp(`\\s\\((?:${REGION_ALT})\\)\\s*$`, 'i');

export function stripRegionSuffix(name) {
  if (typeof name !== 'string') return name;
  return name.replace(REGION_DASH_RE, '').replace(REGION_PARENS_RE, '').trim();
}

/**
 * Collapse components that share a name, keeping the WORST status.
 *
 * Several vendors publish the same service once per region — 1Password lists
 * "1Password.com website" under USA/Global, Canada and Europe; Monday.com lists
 * "Platform" under US, EU and AUS. A reader wants one row per service, and if
 * it is broken anywhere that row must say so. Taking the healthiest would
 * manufacture exactly the false green this project exists to eliminate.
 *
 * Harmless when names are already unique.
 *
 * @param {{name: string, severity: any, description?: string}[]} components
 */
function dedupeByName(components) {
  const byName = new Map();
  for (const c of components) {
    const existing = byName.get(c.name);
    if (!existing || rank(c.severity) > rank(existing.severity)) byName.set(c.name, c);
  }
  return [...byName.values()];
}

/**
 * @typedef {import('../severity.js').Severity} Severity
 */

/**
 * @typedef {object} StatusRecord
 * @property {string}   vendor
 * @property {string}   service
 * @property {Severity} severity
 * @property {string}   incidentName
 * @property {string}   description
 * @property {string}   sourceUrl
 * @property {string}   checkedAt      ISO-8601
 * @property {string[]} warnings       config drift and parse notes
 */

/**
 * Strip HTML tags and collapse whitespace for a plain-text summary.
 *
 * NOTE: this is a *display* cleaner, not a sanitizer, and is deliberately not
 * relied upon for safety. Audit finding M4: vendor incident text is
 * attacker-influenced content from third parties, so the render layer escapes
 * on output rather than trusting anything cleaned here. Never inject the
 * result of this function into HTML unescaped.
 *
 * @param {unknown} text
 * @returns {string}
 */
function toPlainText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Severity from the vendor's own page-level indicator.
 * @param {any} payload
 * @returns {Severity}
 */
function indicatorSeverity(payload) {
  const indicator = payload?.status?.indicator;
  return typeof indicator === 'string' ? normalizeSeverity(indicator) : SEVERITY.UNKNOWN;
}

/**
 * Parse a Statuspage v2 `summary.json` payload into one status record.
 *
 * **How severity is decided** — this is the core correction from the audit:
 *
 * - **Scope configured** -> severity is the worst of the *in-scope components
 *   only*. The vendor's page indicator is deliberately ignored, because the
 *   operator has declared what they care about. This is what lets Cloudflare
 *   read Operational while 26 far-flung edge PoPs are re-routing (decision D1).
 * - **No scope configured** -> severity is the worst of the page indicator and
 *   all components. Without a declared scope, use every signal available.
 * - **Incidents never contribute to severity**, only to context. The
 *   predecessor derived status *solely* from incidents, which produced errors
 *   in both directions: it missed component-only outages (finding M2) and it
 *   marked KnowBe4 degraded over an incident about their online store while
 *   the vendor's own indicator read `none`.
 *
 * Fails closed (finding H4): a null, malformed, or unrecognisable payload
 * yields `UNKNOWN` and never `OPERATIONAL`.
 *
 * @param {any} payload  parsed Statuspage v2 summary
 * @param {object} options
 * @param {string} options.vendor
 * @param {string} [options.service]
 * @param {import('../scope.js').Scope} [options.scope]
 * @param {'group'|'component'|'none'} [options.componentLevel] where this vendor
 *   puts its SERVICES. Default 'component' (leaves).
 *   - 'group' for vendors whose groups are products and whose leaves are data
 *     centres — NetSuite publishes 9 products across 275 leaves that are just
 *     "US Ashburn 1" repeated.
 *   - 'none' for vendors that publish ONLY infrastructure and no service
 *     breakdown at all — Seismic lists 54 region names with no groups. Showing
 *     a reader a list of data centres is worse than showing nothing, because it
 *     implies a granularity the vendor never published.
 * @param {string} [options.sourceUrl]
 * @param {() => Date} [options.now] injected clock for deterministic tests
 * @returns {StatusRecord}
 */
export function parseStatuspage(payload, options) {
  const {
    vendor,
    service,
    scope,
    componentLevel = 'component',
    sourceUrl,
    now = () => new Date(),
  } = options ?? {};
  const checkedAt = now().toISOString();
  const warnings = [];

  const base = {
    vendor: vendor ?? 'unknown',
    service: service ?? vendor ?? 'unknown',
    sourceUrl: payload?.page?.url ?? sourceUrl ?? '',
    checkedAt,
  };

  // Fail closed: nothing recognisable to read.
  const hasStatus = payload?.status && typeof payload.status === 'object';
  const hasComponents = Array.isArray(payload?.components);
  if (!hasStatus && !hasComponents) {
    return {
      ...base,
      severity: SEVERITY.UNKNOWN,
      incidentName: '',
      description: 'Status could not be determined from the vendor payload.',
      warnings: ['payload was missing both status and components'],
    };
  }

  // When a vendor's services live at group level, read the groups' own
  // published statuses instead of their per-region children.
  const groups = Array.isArray(payload?.components)
    ? payload.components.filter((c) => c.group)
    : [];
  const useGroups = componentLevel === 'group' && groups.length > 0;

  // Scope and group mode COMPOSE (operator decision 2026-08-03: this board
  // judges severity from a US vantage point). Scope picks the leaves that
  // VOTE on severity; group mode decides what the card DISPLAYS. A vendor
  // can therefore show "ODC — Affected: Middle East / UAE (major outage)"
  // as card detail while the row stays green, because the scoped US leaves
  // are healthy. Non-US trouble informs; it does not vote.
  const leafSelection = selectComponents(payload, scope);
  warnings.push(...leafSelection.warnings);

  // REGION GROUPS (US vantage point, 2026-08-04). Some vendors mix global
  // services with a group whose leaves are geographies: Discord publishes 8
  // ungrouped services (API, Gateway, Payments…) alongside a "Voice" group of
  // 15 PoPs. Group mode is the wrong tool — it would surface the three groups
  // and DROP the ungrouped services, hiding a real API outage. So config
  // names the geography groups and the leaves that VOTE; the rest of the
  // vendor keeps voting normally, and non-voting regions still render (they
  // inform, they do not vote).
  const regionGroups = scope?.regionGroups;
  const regionGroupIds = new Map(); // group id -> voting leaf names
  if (regionGroups && typeof regionGroups === 'object') {
    for (const g of groups) {
      if (Object.hasOwn(regionGroups, g.name)) {
        const votingNames = Array.isArray(regionGroups[g.name]) ? regionGroups[g.name] : [];
        regionGroupIds.set(g.id, new Set(votingNames));
        const live = new Set(
          (payload?.components ?? []).filter((c) => c.group_id === g.id).map((c) => c.name),
        );
        for (const n of votingNames) {
          if (!live.has(n)) {
            warnings.push(`configured voting region "${n}" matched no component in group "${g.name}"`);
          }
        }
      }
    }
  }

  /** Does this leaf get a vote, under the configured region-group lens? */
  const votes = (c) => {
    const allowed = regionGroupIds.get(c.group_id);
    return allowed ? allowed.has(c.name) : true;
  };

  /** Display name: region leaves carry their group, so a city reads as one. */
  const displayName = (c) => {
    if (!regionGroupIds.has(c.group_id)) return stripRegionSuffix(c.name);
    const group = groups.find((g) => g.id === c.group_id);
    return `${group ? `${group.name} · ` : ''}${stripRegionSuffix(c.name)}`;
  };

  const selected = useGroups ? groups : leafSelection.selected;
  const scoped = leafSelection.scoped;

  // Regional filtering applies to the VOTING set only; `selected` still
  // carries every component for display.
  const voting = regionGroupIds.size > 0 ? selected.filter(votes) : selected;

  let severity;
  if (regionGroupIds.size > 0 && !scoped && !useGroups) {
    // The page indicator is deliberately EXCLUDED here, for the same reason
    // it is excluded from scoped mode: it reflects the vendor's worldwide
    // state, so letting it vote would readmit the non-US regions this lens
    // exists to keep out — a Tokyo voice outage would redden the row through
    // the indicator instead of through the component. Every non-region
    // component still votes, which is what catches a real global failure
    // (Discord's API, Gateway, Payments…).
    severity = worst(voting.map((c) => normalizeSeverity(c.status)));
  } else if (scoped) {
    // The operator declared what matters; judge only on that. An EMPTY
    // scoped selection is not health — it means the configured names matched
    // nothing live (vendor renamed things, payload reshaped), so nothing was
    // verified. worst([]) would read operational; fail closed instead.
    severity =
      leafSelection.selected.length > 0
        ? worst(leafSelection.selected.map((c) => normalizeSeverity(c.status)))
        : SEVERITY.UNKNOWN;
  } else if (useGroups) {
    // Unscoped group mode: the groups' own rolled-up statuses decide, as
    // before (the page indicator stays out of it — groups ARE the vendor's
    // roll-up).
    severity = worst(selected.map((c) => normalizeSeverity(c.status)));
  } else {
    severity = worst([
      indicatorSeverity(payload),
      ...selected.map((c) => normalizeSeverity(c.status)),
    ]);
  }

  // Incidents supply context only, never severity.
  const incidents = Array.isArray(payload?.incidents) ? payload.incidents : [];
  const openIncidents = incidents.filter((i) => {
    const isResolved = i?.status === 'resolved' || i?.status === 'postmortem';
    // Statuspage convention: an underscore-prefixed name marks a metadata /
    // scheduled-maintenance placeholder rather than a real incident. Preserved
    // from the predecessor, which got this detail right.
    const isMetadata =
      typeof i?.name === 'string' && i.name.startsWith('_');
    return !isResolved && !isMetadata;
  });

  const primary = openIncidents[0];
  const incidentName = typeof primary?.name === 'string' ? primary.name : '';

  const unhealthy = selected.filter((c) => normalizeSeverity(c.status) !== SEVERITY.OPERATIONAL);

  let description;
  if (primary) {
    const latestBody = primary?.incident_updates?.[0]?.body;
    description = toPlainText(latestBody) || incidentName || 'Active incident reported by vendor.';
  } else if (unhealthy.length > 0) {
    const names = unhealthy.slice(0, 3).map((c) => c.name).join(', ');
    const more = unhealthy.length > 3 ? ` (+${unhealthy.length - 3} more)` : '';
    description = `Affected: ${names}${more}.`;
  } else if (severity === SEVERITY.OPERATIONAL) {
    description = toPlainText(payload?.status?.description) || 'Systems operational.';
  } else {
    description = toPlainText(payload?.status?.description) || 'Status reported as degraded by vendor.';
  }

  // In group mode, a group's status is Statuspage's roll-up of its worst
  // regional child — so ONE broken region reads as a globally broken service
  // with nothing on the board saying which region. Seen live 2026-08-03:
  // OutSystems' Middle East / UAE region was down, all three ODC groups went
  // major_outage, and the regional detail lived only in the leaves that group
  // mode discards. Name the unhealthy children on the group component, so a
  // reader can tell a one-region failure from a global one.
  const regionDetail = (group) => {
    const kids = (payload?.components ?? []).filter(
      (c) => !c.group && c.group_id === group.id,
    );
    const bad = kids
      .map((c) => ({ name: c.name, severity: normalizeSeverity(c.status) }))
      .filter((c) => c.severity !== SEVERITY.OPERATIONAL);
    if (bad.length === 0) return '';
    const shown = bad
      .slice(0, 4)
      .map((c) => `${c.name} (${c.severity.replace(/_/g, ' ')})`)
      .join(', ');
    const more = bad.length > 4 ? ` (+${bad.length - 4} more)` : '';
    return `Affected: ${shown}${more}.`;
  };

  // Children are always returned in full, healthy ones included. rollup.js
  // decides which are worth showing; hiding them here would throw away data the
  // dashboard needs the moment something breaks.
  // 'none' suppresses the list: the vendor publishes infrastructure only, and a
  // list of data centres implies a service granularity that does not exist.
  const components =
    componentLevel === 'none'
      ? []
      : dedupeByName(
          selected.map((c) => ({
            name: displayName(c),
            severity: normalizeSeverity(c.status),
            ...(useGroups ? { description: regionDetail(c) } : {}),
          })),
        );

  return { ...base, severity, incidentName, description, components, warnings };
}
