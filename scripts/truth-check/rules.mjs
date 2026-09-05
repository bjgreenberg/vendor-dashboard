/**
 * Truth-check rules — the second opinion behind the board.
 *
 * The monitors that existed before this (dead-man, endpoint-rot) validate
 * plumbing: is the collector running, is a vendor stuck at `unknown`. Nothing
 * checked the claim itself — "we render operational, the vendor says incident".
 * That gap produced the 2026-08-28 Google misreport (PR #123): an open Google
 * Chat incident rendered as "37 components · all healthy" because the adapter
 * filed SERVICE_INFORMATION under cleared.
 *
 * This module is DELIBERATELY NOT THE ADAPTER. It reads each vendor's own
 * verdict the simplest way that vendor offers — a page-level indicator, the
 * states of the components the operator declared in scope, or (Google) an
 * incident with no end time — from the raw payload, by a different code path,
 * with no severity vocabulary shared with src/engine/. If the adapter and this
 * rule disagree, one of them is wrong, and a human decides which.
 *
 * What it does NOT do: vote on incidents for statuspage vendors. The settled
 * decision (CLAUDE.md, KnowBe4 precedent) is that incidents inform context and
 * never severity; open incidents are reported as evidence so the disagreement
 * issue carries them, but the verdict comes from the vendor's indicator. Google
 * publishes no indicator, so there an incident with no `end` IS the verdict.
 *
 * Runtime-agnostic: pure functions over parsed payloads. Fetching lives in
 * run.mjs; the workflow decides what to do with the result.
 */

/** Verdicts: 'fine' | 'trouble' | 'unreadable' | 'uncovered'. */

const STATUSPAGE_HEALTHY_INDICATOR = 'none';
const STATUSPAGE_OPEN_INCIDENT = (i) => i && i.status !== 'resolved' && i.status !== 'postmortem';

/**
 * Raw feeds the second opinion needs for a vendor. Empty = not covered: the
 * rule refuses to guess at a platform it does not understand, and the report
 * says so in its coverage count instead of reading it as agreement.
 * @param {any} vendor a config/vendors.json entry
 * @returns {string[]}
 */
export function probeUrlsFor(vendor) {
  switch (vendor?.type) {
    case 'statuspage': {
      // Region lenses (Discord's regionGroups) are engine semantics this dumb
      // rule does not reproduce; component/group scopes are plain name lists.
      const scope = vendor.scope;
      if (scope && (scope.regionGroups || scope.regionPrefixes)) return [];
      return vendor.url ? [vendor.url] : [];
    }
    case 'instatus':
    case 'sorryapp':
    case 'google':
      return vendor.url ? [vendor.url] : [];
    case 'oracle': {
      // The configured feed is the 1.6 MB components document; the page-level
      // indicator lives in a 173-byte sibling on the same host — an independent
      // document, which is exactly what a second opinion wants.
      try {
        return [`${new URL(vendor.url).origin}/api/v2/status.json`];
      } catch {
        return [];
      }
    }
    case 'composite': {
      const sources = Array.isArray(vendor.sources) ? vendor.sources : [];
      if (sources.length === 0 || !sources.every((s) => s?.type === 'statuspage' && s.url)) return [];
      return sources.map((s) => s.url);
    }
    default:
      return [];
  }
}

/**
 * @param {string[]} evidence
 * @param {'fine'|'trouble'|'unreadable'} verdict
 */
const opinion = (verdict, evidence, urls) => ({ covered: true, verdict, evidence, urls });

/** @param {any} body */
const isError = (body) => body == null || typeof body !== 'object' || 'error' in body;

/**
 * One statuspage summary.json, judged by the vendor's page indicator — or,
 * for a component/group-scoped vendor, by the states of the in-scope
 * components only (the operator has declared what matters; the page indicator
 * carries PoP re-routing the settled decision ignores).
 * @param {any} payload
 * @param {any} scope
 * @param {string} label
 */
function statuspageVerdict(payload, scope, label) {
  if (isError(payload)) return { verdict: 'unreadable', evidence: [`${label}: ${payload?.error ?? 'no payload'}`] };
  const incidents = Array.isArray(payload.incidents) ? payload.incidents.filter(STATUSPAGE_OPEN_INCIDENT) : [];
  const incidentNote = incidents.length
    ? `${incidents.length} open incident(s): ${incidents.map((i) => String(i.name ?? '?')).join('; ')}`
    : 'no open incidents';

  if (scope && (scope.components || scope.groups)) {
    const components = Array.isArray(payload.components) ? payload.components : [];
    const groupIds = new Set(
      components.filter((c) => c?.group && (scope.groups ?? []).includes(c.name)).map((c) => c.id),
    );
    const wanted = new Set(scope.components ?? []);
    const inScope = components.filter(
      (c) => c && !c.group && (wanted.has(c.name) || (c.group_id && groupIds.has(c.group_id))),
    );
    if (inScope.length === 0) {
      return { verdict: 'unreadable', evidence: [`${label}: scope matched no components`] };
    }
    const bad = inScope.filter((c) => c.status !== 'operational');
    const summary = `${label}: ${inScope.length} in-scope components, ${bad.length} not operational` +
      (bad.length ? ` (${bad.map((c) => `${c.name}=${c.status}`).join(', ')})` : '') + `; ${incidentNote}`;
    return { verdict: bad.length ? 'trouble' : 'fine', evidence: [summary] };
  }

  const indicator = payload?.status?.indicator;
  if (typeof indicator !== 'string' || indicator === '') {
    return { verdict: 'unreadable', evidence: [`${label}: no status.indicator`] };
  }
  const description = payload?.status?.description ? ` (${payload.status.description})` : '';
  return {
    verdict: indicator === STATUSPAGE_HEALTHY_INDICATOR ? 'fine' : 'trouble',
    evidence: [`${label}: indicator=${indicator}${description}; ${incidentNote}`],
  };
}

/**
 * The vendor's own verdict, read the dumbest way that vendor offers.
 * Never throws: an unreadable payload is `unreadable`, an unsupported
 * platform is `uncovered`.
 * @param {any} vendor a config/vendors.json entry
 * @param {Record<string, any>} bodies parsed body per probed URL ({error} on failure)
 */
export function secondOpinion(vendor, bodies) {
  const urls = probeUrlsFor(vendor);
  if (urls.length === 0) return { covered: false, verdict: 'uncovered', evidence: [], urls };
  const body = bodies?.[urls[0]];

  switch (vendor.type) {
    case 'statuspage': {
      const r = statuspageVerdict(body, vendor.scope, vendor.name);
      return opinion(r.verdict, r.evidence, urls);
    }
    case 'composite': {
      const results = vendor.sources.map((s) => statuspageVerdict(bodies?.[s.url], s.scope, `${vendor.name}/${s.group ?? s.url}`));
      const evidence = results.flatMap((r) => r.evidence);
      const worst = results.some((r) => r.verdict === 'trouble')
        ? 'trouble'
        : results.some((r) => r.verdict === 'unreadable')
          ? 'unreadable'
          : 'fine';
      return opinion(worst, evidence, urls);
    }
    case 'instatus': {
      const status = body?.page?.status;
      if (isError(body) || typeof status !== 'string') return opinion('unreadable', [`${vendor.name}: no page.status`], urls);
      return opinion(status === 'UP' ? 'fine' : 'trouble', [`${vendor.name}: page.status=${status}`], urls);
    }
    case 'sorryapp': {
      const state = body?.page?.state;
      if (isError(body) || typeof state !== 'string') return opinion('unreadable', [`${vendor.name}: no page.state`], urls);
      return opinion(state.toLowerCase() === 'operational' ? 'fine' : 'trouble', [`${vendor.name}: page.state=${state}`], urls);
    }
    case 'google': {
      if (!Array.isArray(body)) return opinion('unreadable', [`${vendor.name}: incidents feed is not an array`], urls);
      const open = body.filter((i) => i && !i.end);
      if (open.length === 0) return opinion('fine', [`${vendor.name}: ${body.length} incidents, all with an end time`], urls);
      return opinion(
        'trouble',
        [`${vendor.name}: ${open.length} incident(s) with no end: ${open.map((i) => `${i.service_name ?? '?'} — ${i.external_desc ?? i.id ?? '?'}`).join('; ')}`],
        urls,
      );
    }
    case 'oracle': {
      const r = statuspageVerdict(body, undefined, vendor.name);
      return opinion(r.verdict, r.evidence, urls);
    }
    default:
      return { covered: false, verdict: 'uncovered', evidence: [], urls };
  }
}

const BOARD_TROUBLE = new Set(['degraded', 'partial_outage', 'major_outage', 'maintenance']);

/**
 * The board against the second opinions.
 *
 * `falseGreen` is the disagreement that alerts: the board renders
 * `operational` while the vendor's own verdict is trouble. `overCautious`
 * (board says trouble, vendor says fine) is information — a lagging clear or
 * a scope decision — and never pages anyone. `unknown` rows are the
 * endpoint-rot watchdog's business and are skipped here.
 *
 * @param {Array<{vendor: string, severity: string}>} records the board (/api/status)
 * @param {Map<string, ReturnType<typeof secondOpinion>>} opinions by vendor name
 */
export function compare(records, opinions) {
  const falseGreen = [];
  const overCautious = [];
  const unreadable = [];
  let covered = 0;
  let agreed = 0;
  for (const r of records) {
    const o = opinions.get(r.vendor);
    if (!o || !o.covered) continue;
    covered += 1;
    if (o.verdict === 'unreadable') {
      unreadable.push(r.vendor);
      continue;
    }
    if (r.severity === 'unknown') continue;
    if (r.severity === 'operational' && o.verdict === 'trouble') {
      falseGreen.push({ vendor: r.vendor, rendered: r.severity, evidence: o.evidence, urls: o.urls });
    } else if (BOARD_TROUBLE.has(r.severity) && o.verdict === 'fine') {
      overCautious.push({ vendor: r.vendor, rendered: r.severity, evidence: o.evidence, urls: o.urls });
    } else {
      agreed += 1;
    }
  }
  return { falseGreen, overCautious, unreadable, covered, total: records.length, agreed };
}
