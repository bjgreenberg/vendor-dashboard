/**
 * Truth-check second-opinion readers for the platforms rules.mjs's first
 * batch left uncovered (worklist #124, 2026-09-30): Apple, AWS, Concur,
 * Discord's region lens, Docusign, IBM Cloud, Meta, Microsoft's non-Statuspage
 * sources, Okta, Signal, Better Stack (Stormboard), Salesforce (Tableau) and
 * Zscaler.
 *
 * Same contract as rules.mjs: DELIBERATELY NOT THE ADAPTER. Each reader takes
 * the vendor's own verdict by a different code path from src/engine/adapters,
 * preferring a different FIELD of the same feed where one exists (Apple's
 * event times rather than its status word, AWS's numeric status rather than
 * the "[RESOLVED]" summary, IBM's parsed JSON rather than a string scan,
 * Stormboard's page heading rather than its icon, Signal's glyph rather than
 * its sentence). Scope decisions the operator declared in config (AWS's US
 * region prefixes, Discord's voting voice regions) are honoured, because
 * reporting non-US trouble as a "false green" would page for a decision, not
 * a defect.
 *
 * Every reader returns { verdict: 'fine' | 'trouble' | 'unreadable', evidence }
 * and never throws. A word it has never seen is `unreadable`, never `fine`.
 * Pure: `now` is passed in.
 */

/**
 * Decode a fetched body by its byte-order mark: UTF-16 BE/LE (AWS serves
 * UTF-16 BE with a BOM), else UTF-8 with any BOM stripped. An odd trailing
 * byte in a UTF-16 body is dropped rather than thrown on.
 * @param {Buffer} buf
 */
export function decodeBody(buf) {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    body.swap16();
    return body.toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2, 2 + ((buf.length - 2) & ~1)).toString('utf16le');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

/** @param {unknown} text @param {number} [max] */
const brief = (text, max = 120) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** A fetch failure or non-object body. run.mjs hands non-JSON bodies over as { error, text }. */
const failed = (body) => body == null || typeof body !== 'object' || ('error' in body && !('text' in body));

/** The raw text of a non-JSON body (HTML, JavaScript), or null. */
const textOf = (body) => (body && typeof body === 'object' && typeof body.text === 'string' ? body.text : null);

const r = (verdict, evidence) => ({ verdict, evidence });
const unreadable = (label, why) => r('unreadable', [`${label}: ${why}`]);

/* ---------------------------------- Apple --------------------------------- */

/**
 * Apple: an event is live when it has started and has no end yet (or ends in
 * the future) — read from epochStartDate/epochEndDate, not the eventStatus
 * word the adapter uses. A scheduled event that has not started is not live.
 */
export function appleVerdict(body, label, now) {
  let data = body;
  const text = textOf(body);
  if (text) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    try {
      data = a !== -1 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
    } catch {
      data = null;
    }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.services)) return unreadable(label, 'no services array');
  const live = [];
  for (const s of data.services) {
    for (const e of Array.isArray(s?.events) ? s.events : []) {
      const start = Number(e?.epochStartDate);
      const end = e?.epochEndDate == null ? null : Number(e.epochEndDate);
      if (!Number.isFinite(start)) continue;
      if (start <= now && (end === null || !Number.isFinite(end) || end > now)) live.push(`${brief(s?.serviceName, 40)} (${brief(e?.statusType ?? 'event', 20)})`);
    }
  }
  return live.length
    ? r('trouble', [`${label}: ${live.length} event(s) started and not ended: ${live.slice(0, 6).join(', ')}`])
    : r('fine', [`${label}: ${data.services.length} services, no event running now`]);
}

/* ----------------------------------- AWS ---------------------------------- */

const AWS_REGION_CODE = /(?:^|-)([a-z]{2}(?:-gov)?-[a-z]+-\d+)$/;

/**
 * AWS currentevents: an event is open while its numeric `status` is not "0"
 * (every resolved event in the recorded feeds carries "0"; the adapter reads
 * the "[RESOLVED]" summary and end_time instead). Only in-scope regions vote:
 * config's regionPrefixes (US vantage point); a global or unparseable service
 * id votes, failing closed.
 */
export function awsVerdict(body, label, regionPrefixes) {
  const events = Array.isArray(body) ? body : body?.events;
  if (!Array.isArray(events)) return unreadable(label, failed(body) ? (body?.error ?? 'no payload') : 'not an event array');
  const prefixes = Array.isArray(regionPrefixes) ? regionPrefixes : [];
  const open = events.filter((e) => e && String(e.status ?? '') !== '0');
  const inScope = open.filter((e) => {
    if (prefixes.length === 0) return true;
    const code = AWS_REGION_CODE.exec(String(e.service ?? ''))?.[1];
    return !code || prefixes.some((p) => code.startsWith(p));
  });
  const outside = open.length - inScope.length;
  const note = outside ? `; ${outside} open outside scope (${prefixes.join(', ')})` : '';
  return inScope.length
    ? r('trouble', [`${label}: ${inScope.length} open in-scope event(s): ${inScope.slice(0, 4).map((e) => `${brief(e.service, 50)} — ${brief(e.summary, 60)}`).join('; ')}${note}`])
    : r('fine', [`${label}: no open in-scope events${note}`]);
}

/* ---------------------------------- Concur -------------------------------- */

const CONCUR_FINE = /^(normal|operational|available)$/i;

/** Concur status_history, one document per data centre: every service's Current Status. */
export function concurVerdict(bodies, label) {
  const docs = bodies.filter((b) => !failed(b) && b.data && typeof b.data === 'object');
  if (docs.length === 0) return unreadable(label, 'no status_history document readable');
  const bad = [];
  let seen = 0;
  for (const doc of docs) {
    for (const [name, entry] of Object.entries(doc.data)) {
      const status = entry?.['Current Status']?.status;
      if (status === undefined) continue;
      seen += 1;
      if (!CONCUR_FINE.test(String(status).trim())) bad.push(`${brief(entry?.Service ?? name, 30)}=${brief(status, 20)}`);
    }
  }
  if (seen === 0) return unreadable(label, 'no service carried a Current Status');
  const missing = bodies.length - docs.length;
  const note = missing ? `; ${missing} data centre(s) unreadable` : '';
  return bad.length
    ? r('trouble', [`${label}: ${bad.length} service status(es) not normal: ${bad.slice(0, 6).join(', ')}${note}`])
    : r('fine', [`${label}: ${seen} service statuses across ${docs.length} data centre(s), all normal${note}`]);
}

/* --------------------------- Discord's region lens ------------------------- */

/**
 * A Statuspage summary judged through configured region groups (Discord's
 * Voice PoPs): every non-group component votes, except that inside a named
 * region group only the listed regions vote. The page indicator is excluded —
 * it carries the worldwide state this lens exists to keep out.
 */
export function regionLensVerdict(body, label, regionGroups) {
  if (failed(body) || !Array.isArray(body.components)) return unreadable(label, body?.error ?? 'no components');
  const groupVoters = new Map();
  for (const c of body.components) {
    if (c?.group && Object.hasOwn(regionGroups, c.name)) groupVoters.set(c.id, new Set(regionGroups[c.name] ?? []));
  }
  const voting = body.components.filter((c) => c && !c.group && (!groupVoters.has(c.group_id) || groupVoters.get(c.group_id).has(c.name)));
  if (voting.length === 0) return unreadable(label, 'no voting components');
  const bad = voting.filter((c) => c.status !== 'operational');
  return bad.length
    ? r('trouble', [`${label}: ${bad.length} of ${voting.length} voting components not operational (${bad.slice(0, 6).map((c) => `${brief(c.name, 30)}=${c.status}`).join(', ')})`])
    : r('fine', [`${label}: ${voting.length} voting components operational (non-US voice regions excluded)`]);
}

/* --------------------------------- Docusign ------------------------------- */

/** Docusign: any component not `available`, or any unresolved incident whose impact is not `available`. */
export function docusignVerdict(components, incidents, label) {
  if (failed(components) || !Array.isArray(components.components)) return unreadable(label, components?.error ?? 'no component list');
  const badComponents = components.components.filter((c) => c && String(c.status ?? '').toLowerCase() !== 'available');
  const list = !failed(incidents) && Array.isArray(incidents.incidents) ? incidents.incidents : null;
  const openIncidents = (list ?? []).filter(
    (i) => i && String(i.status ?? '').toLowerCase() !== 'resolved' && String(i.impact ?? '').toLowerCase() !== 'available',
  );
  const evidence = `${label}: ${badComponents.length} of ${components.components.length} components not available` +
    (badComponents.length ? ` (${badComponents.slice(0, 5).map((c) => `${brief(c.name, 30)}=${c.status}`).join(', ')})` : '') +
    (list ? `; ${openIncidents.length} open incident(s)${openIncidents.length ? `: ${openIncidents.slice(0, 3).map((i) => brief(i.title, 60)).join('; ')}` : ''}` : '; incidents feed unreadable');
  return r(badComponents.length || openIncidents.length ? 'trouble' : 'fine', [evidence]);
}

/* ---------------------------------- IBM Cloud ------------------------------ */

const IBM_CLOSED = new Set(['resolved', 'completed', 'archived', 'closed']);

/** IBM getEnhancedStatus, parsed as JSON (the adapter string-scans it): any incident not in a closed state. */
export function ibmVerdict(body, label) {
  const items = body?.statusItems;
  if (failed(body) || !Array.isArray(items)) return unreadable(label, body?.error ?? 'no statusItems array');
  const incidents = items.filter((i) => i && i.type === 'incident');
  const open = incidents.filter((i) => !IBM_CLOSED.has(String(i.state ?? '').toLowerCase()));
  return open.length
    ? r('trouble', [`${label}: ${open.length} open incident(s): ${open.slice(0, 4).map((i) => brief(i.name ?? i.shortDescription, 60)).join('; ')}`])
    : r('fine', [`${label}: ${incidents.length} incident(s) listed, none open`]);
}

/* ------------------------------------ Meta --------------------------------- */

const META_FINE = /^(no known issues|operational|resolved)$/i;

/** Meta orgs.json: every service's status word, read exactly (not by keyword). */
export function metaVerdict(body, label) {
  const orgs = Array.isArray(body) ? body : body?.orgs;
  if (!Array.isArray(orgs) || orgs.length === 0) return unreadable(label, body?.error ?? 'no org array');
  const services = orgs.flatMap((o) => (Array.isArray(o?.services) ? o.services.map((s) => ({ org: o.name, ...s })) : []));
  if (services.length === 0) return unreadable(label, 'no services listed');
  const bad = services.filter((s) => !META_FINE.test(String(s.status ?? '').trim()));
  return bad.length
    ? r('trouble', [`${label}: ${bad.length} of ${services.length} services report issues: ${bad.slice(0, 5).map((s) => `${brief(s.org, 25)} · ${brief(s.name, 25)}=${brief(s.status, 25)}`).join(', ')}`])
    : r('fine', [`${label}: ${services.length} services report no known issues`]);
}

/* -------------------------------- Microsoft -------------------------------- */

const MS_FINE = /^(service\s+)?(operational|available|normal|restored)$/i;
const MS_TROUBLE = /(degrad|interrupt|outage|unavailable|incident|investigat|advisory|maintenance|disrupt|restricted|impair)/i;

/** One Microsoft status word: fine, trouble, or (never-seen word) unreadable. */
function msWord(word) {
  const w = String(word ?? '').trim();
  if (MS_FINE.test(w)) return 'fine';
  if (MS_TROUBLE.test(w)) return 'trouble';
  return 'unreadable';
}

/** status.cloud.microsoft consumer workloads: every row's Status. */
export function msConsumerVerdict(body, label) {
  const rows = Array.isArray(body) ? body : body?.posts;
  if (!Array.isArray(rows) || rows.length === 0) return unreadable(label, body?.error ?? 'no workload rows');
  const words = rows.map((x) => ({ name: x?.ServiceDisplayName ?? x?.ServiceWorkloadName, status: x?.Status, v: msWord(x?.Status) }));
  const bad = words.filter((w) => w.v === 'trouble');
  const odd = words.filter((w) => w.v === 'unreadable');
  if (bad.length) return r('trouble', [`${label}: ${bad.map((w) => `${brief(w.name, 30)}=${brief(w.status, 25)}`).join(', ')}`]);
  if (odd.length) return unreadable(label, `unrecognised status ${odd.map((w) => `"${brief(w.status, 25)}"`).join(', ')}`);
  return r('fine', [`${label}: ${rows.length} workloads operational`]);
}

/** status.cloud.microsoft single-post feeds (Azure, admin centres): the post's Status. */
export function msPostVerdict(body, label) {
  const post = Array.isArray(body) ? body[0] : body;
  if (failed(post) || !String(post?.Status ?? '').trim()) return unreadable(label, body?.error ?? 'no Status');
  const v = msWord(post.Status);
  if (v === 'unreadable') return unreadable(label, `unrecognised status "${brief(post.Status, 30)}"`);
  return r(v, [`${label}: ${brief(post.Status, 30)}${v === 'trouble' && post.Message ? ` — ${brief(String(post.Message).replace(/<[^>]*>/g, ' '), 90)}` : ''}`]);
}

/** Azure DevOps health: every geography of every service. */
export function adoVerdict(body, label) {
  const services = body?.services;
  if (failed(body) || !Array.isArray(services) || services.length === 0) return unreadable(label, body?.error ?? 'no services array');
  const geos = services.flatMap((s) => (Array.isArray(s?.geographies) ? s.geographies.map((g) => ({ svc: s.id, ...g })) : []));
  if (geos.length === 0) return unreadable(label, 'no geographies');
  const known = /^(healthy|advisory|degraded|unhealthy)$/i;
  const odd = geos.filter((g) => !known.test(String(g.health ?? '')));
  const bad = geos.filter((g) => /^(advisory|degraded|unhealthy)$/i.test(String(g.health ?? '')));
  if (bad.length) return r('trouble', [`${label}: ${bad.length} of ${geos.length} service-geographies not healthy (${bad.slice(0, 5).map((g) => `${brief(g.svc, 25)}/${brief(g.name, 20)}=${g.health}`).join(', ')})`]);
  if (odd.length) return unreadable(label, `unrecognised health ${[...new Set(odd.map((g) => `"${brief(g.health, 20)}"`))].join(', ')}`);
  return r('fine', [`${label}: ${geos.length} service-geographies healthy`]);
}

/* ------------------------------------ Okta --------------------------------- */

const OKTA_CLOSED = /^(resolved|completed|closed)$/i;

/**
 * Okta's status page embeds its Salesforce Incident__c records. Rather than
 * extracting the array (the adapter's path), split the page at every
 * Incident__c record and read its Status__c directly.
 */
export function oktaVerdict(body, label) {
  const html = textOf(body);
  if (!html) return unreadable(label, body?.error ?? 'no HTML');
  const parts = html.split('"attributes":{"type":"Incident__c"').slice(1);
  if (parts.length === 0) return unreadable(label, 'no Incident__c records on the page');
  const statuses = parts.map((p) => /"Status__c":"([^"]*)"/.exec(p.split('"attributes":{"type":')[0])?.[1]).filter((s) => s !== undefined);
  if (statuses.length === 0) return unreadable(label, 'Incident__c records carry no Status__c');
  const open = statuses.filter((s) => !OKTA_CLOSED.test(s.trim()));
  return open.length
    ? r('trouble', [`${label}: ${open.length} of ${statuses.length} incidents not resolved (${[...new Set(open)].join(', ')})`])
    : r('fine', [`${label}: ${statuses.length} incidents on the page, all resolved`]);
}

/* ----------------------------------- Signal -------------------------------- */

/** status.signal.org: the big symbol — a check mark means up; anything else means not. */
export function signalVerdict(body, label) {
  const html = textOf(body);
  if (!html) return unreadable(label, body?.error ?? 'no HTML');
  // Bounded quantifiers: a vendor page is untrusted input, and an unbounded
  // lazy run before \s*< backtracks quadratically on a long tag-free stretch.
  const m = /id=["']symbol["'][^>]{0,200}>\s{0,50}([^<\s][^<]{0,40}?)\s{0,50}</i.exec(html);
  if (!m) return unreadable(label, 'no status symbol on the page');
  const glyph = m[1].trim();
  const up = /^(&check;|&#10003;|&#x2713;|✓|✔|&#10004;|&#x2714;|&checkmark;)$/i.test(glyph);
  return r(up ? 'fine' : 'trouble', [`${label}: status symbol ${brief(glyph, 20)}`]);
}

/* ------------------------------- Better Stack ------------------------------ */

/** A Better Stack page's heading ("All services are online"), not its overview icon. */
export function betterStackVerdict(body, label) {
  const html = textOf(body);
  if (!html) return unreadable(label, body?.error ?? 'no HTML');
  const m = /status-page__title['"][^>]*>([^<]{1,200})</i.exec(html);
  if (!m) return unreadable(label, 'no page heading');
  const heading = m[1].trim();
  if (/^all services are (online|operational)\.?$/i.test(heading)) return r('fine', [`${label}: "${brief(heading, 60)}"`]);
  if (/(down|degrad|issue|outage|disrupt|maintenance|partial|problem|incident)/i.test(heading)) return r('trouble', [`${label}: "${brief(heading, 80)}"`]);
  return unreadable(label, `unrecognised heading "${brief(heading, 60)}"`);
}

/* -------------------------------- Salesforce ------------------------------- */

/** Salesforce status API product: every active production instance's status. */
export function salesforceVerdict(body, label) {
  if (failed(body) || !Array.isArray(body.Instances)) return unreadable(label, body?.error ?? 'no Instances array');
  const prod = body.Instances.filter((i) => i?.environment === 'production' && i?.isActive === true);
  if (prod.length === 0) return unreadable(label, 'no active production instances');
  const bad = prod.filter((i) => String(i.status ?? '').toUpperCase() !== 'OK');
  return bad.length
    ? r('trouble', [`${label}: ${bad.length} of ${prod.length} production instances not OK (${bad.slice(0, 5).map((i) => `${i.key}=${i.status}`).join(', ')})`])
    : r('fine', [`${label}: ${prod.length} production instances OK`]);
}

/* ---------------------------------- Zscaler -------------------------------- */

/**
 * One Zscaler cloud document: an event counts when its severity's legend
 * entry is marked visible (the service-impacting ones). The adapter maps the
 * legend NAME; this reads only the visible flag.
 */
export function zscalerCloudVerdict(body, label) {
  const data = body?.data;
  if (failed(body) || !data || !Array.isArray(data.severity) || !Array.isArray(data.category)) return unreadable(label, body?.error ?? 'no legend or categories');
  const visible = new Set(data.severity.filter((s) => String(s?.visible) === '1').map((s) => String(s.tid)));
  const legend = new Set(data.severity.map((s) => String(s?.tid)));
  const events = data.category.flatMap((c) => (Array.isArray(c?.subCategory) ? c.subCategory : []).flatMap((s) => (Array.isArray(s?.category_status) ? s.category_status.map((e) => ({ sub: s.name, ...e })) : [])));
  const odd = events.filter((e) => !legend.has(String(e.severityTid)));
  const impacting = events.filter((e) => visible.has(String(e.severityTid)));
  if (impacting.length) return r('trouble', [`${label}: ${impacting.length} service-impacting event(s): ${impacting.slice(0, 3).map((e) => `${brief(e.sub, 25)} — ${brief(e.title, 50)}`).join('; ')}`]);
  if (odd.length) return unreadable(label, `${odd.length} event(s) with a severity absent from the legend`);
  return r('fine', [`${label}: ${events.length} event(s), none service-impacting`]);
}

/**
 * Fold several sub-verdicts (clouds, data centres, sources) into one, worst
 * first: any trouble is trouble; else any unreadable is unreadable; else fine.
 * @param {Array<{verdict: string, evidence: string[]}>} parts
 */
export function worstOf(parts) {
  const evidence = parts.flatMap((p) => p.evidence);
  if (parts.some((p) => p.verdict === 'trouble')) return r('trouble', evidence);
  if (parts.some((p) => p.verdict === 'unreadable')) return r('unreadable', evidence);
  return r('fine', evidence);
}
