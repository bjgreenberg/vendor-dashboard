/**
 * Cloudflare Worker entry point.
 *
 * Thin by design: this file wires Cloudflare bindings to the runtime-agnostic
 * engine and does no status logic of its own. Everything that decides whether a
 * vendor is healthy lives in src/engine/ and is unit-tested without a network
 * or a Worker runtime.
 */

import { collect, DEFAULT_SUBREQUEST_BUDGET } from '../engine/collect.js';
import { selectShard, shardDueAt, SHARD_COUNT } from '../engine/shard.js';
import { writeRun, readSnapshot, readMeta, writeTruthCheck } from './storage.js';
import { renderDashboard } from './render.js';
import vendorConfig from '../../config/vendors.json';

/** Must match `triggers.crons` in wrangler.jsonc; shard rotation is derived from it. */
const CRON_EVERY_MINUTES = 1;

/**
 * Scheduled collection.
 *
 * Deliberately lets a thrown error escape: a failed run is recorded as a failed
 * Cron invocation (visible in observability and the Cron "Past Events" table)
 * and the previous snapshot is left intact. Swallowing the error would leave a
 * stale board looking freshly-verified — the failure mode this whole rewrite
 * exists to eliminate.
 *
 * @param {ScheduledController} controller
 * @param {{DB: D1Database}} env
 */
async function scheduled(controller, env) {
  const started = Date.now();

  // Collect one shard per invocation. Two free-plan ceilings originally
  // forced the split (50 subrequests, 10 ms CPU — both bit in production).
  // Workers Paid (2026-08-02) removed the hard limits, but sharding stays:
  // it keeps each invocation tiny, bounds any one vendor's blast radius, and
  // is battle-tested. One invocation covers ~3 vendors; every vendor is still
  // refreshed once per 15 minutes.
  const at = new Date(controller.scheduledTime ?? Date.now());
  const shard = shardDueAt(at, SHARD_COUNT, CRON_EVERY_MINUTES);
  const vendors = selectShard(vendorConfig.vendors, shard, SHARD_COUNT);

  // An EMPTY shard is legitimate once vendors can be pinned: pinning the
  // expensive ones elsewhere can leave a slot with nothing hashed into it.
  // collect() refuses an empty vendor list -- rightly, because that guard
  // exists to stop an empty snapshot rendering as "all systems operational" --
  // so the skip belongs here, before the call, rather than by weakening it.
  //
  // Logged rather than silent: a shard that is empty because a config edit went
  // wrong looks identical to one that is empty by design, and only the log
  // distinguishes them.
  if (vendors.length === 0) {
    console.log(
      JSON.stringify({ event: 'shard_empty', shard, shard_count: SHARD_COUNT }),
    );
    return;
  }

  const run = await collect({ ...vendorConfig, vendors }, { fetchFn: fetch.bind(globalThis) });

  // Pass the FULL configured vendor list, not the shard: it is what lets
  // storage prune rows for vendors that have been removed from config
  // entirely, which a shard-scoped delete can never reach.
  await writeRun(env.DB, run, {
    knownVendors: vendorConfig.vendors.map((v) => v.name),
  });

  // Structured, one event per line, machine-parseable. No vendor content is
  // logged beyond names and severities.
  console.log(
    JSON.stringify({
      event: 'collection_complete',
      checked_at: run.checkedAt,
      shard,
      shard_count: SHARD_COUNT,
      total: run.total,
      impacted: run.impacted,
      unknown: run.unknown,
      subrequests: run.subrequests,
      subrequest_budget: DEFAULT_SUBREQUEST_BUDGET,
      duration_ms: Date.now() - started,
    }),
  );

  // SELF-MONITORING.
  //
  // The 2026-07-31 incident was not a gap in logging -- `collection_complete`
  // had been emitting `unknown: 17` every run for hours. The gap was that
  // nothing ever compared that number against a threshold, so the only detector
  // in the system was a human noticing orange boxes on his phone. These checks
  // are that comparison. They log at ERROR so they are separable from routine
  // output by severity alone (`wrangler tail --status=error` shows only
  // exceptions, so a plain console.warn here would have stayed invisible).
  const alerts = [];

  if (run.budgetExhausted) {
    alerts.push({
      alert: 'subrequest_budget_exhausted',
      detail: `${run.subrequests} subrequests spent; some vendors were never checked`,
    });
  }

  // A whole shard failing is infrastructure (budget, DNS, egress), not 14
  // vendors coincidentally breaking at once.
  if (run.total > 0 && run.unknown / run.total >= 0.5) {
    alerts.push({
      alert: 'unknown_rate_high',
      detail: `${run.unknown}/${run.total} vendors unresolved in shard ${shard}`,
    });
  }

  // Approaching the collector's own budget is the leading indicator — it is
  // what a run looks like the day before something starts truncating. The
  // plan ceiling is 1,000 (Workers Paid); the budget below is our own sanity
  // bound, so the alert fires with headroom left to act.
  if (run.subrequests >= DEFAULT_SUBREQUEST_BUDGET * 0.75) {
    alerts.push({
      alert: 'subrequest_headroom_low',
      detail: `${run.subrequests} of the collector's ${DEFAULT_SUBREQUEST_BUDGET} budget; a shard should cost ~5 — look for a retry storm or config mistake`,
    });
  }

  for (const a of alerts) {
    console.error(JSON.stringify({ event: 'collection_alert', shard, ...a }));
  }

  // Surface config drift and staleness rather than letting it accumulate silently.
  for (const warning of run.warnings) {
    console.warn(JSON.stringify({ event: 'collection_warning', detail: warning }));
  }
}

/**
 * HTTP handler: the dashboard plus a JSON endpoint.
 *
 * @param {Request} request
 * @param {{DB: D1Database, BASE_PATH?: string}} env
 */
async function handleFetch(request, env) {
  const url = new URL(request.url);
  const base = env.BASE_PATH ?? '';
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname;

  if (path === '/health') {
    // A real health answer, not a static {ok:true} (audit findings H3 + L3).
    // Three questions, all answered by actual reads: Worker up (we are
    // responding), D1 reachable (the query below throws loudly if not — a 500
    // is the CORRECT signal for the monitor's curl -f), snapshot fresh.
    //
    // Stale after THREE full 15-minute cycles where the page banner warns at
    // two (render.js STALE_AFTER_MS): the banner is an early hint for a human
    // reader; this endpoint pages a human, so it gets one extra cycle of
    // hysteresis to keep a single slow shard from flapping the alert.
    const HEALTH_STALE_AFTER_MS = 3 * 15 * 60 * 1000;

    const meta = await readMeta(env.DB);
    if (!meta?.checked_at) {
      return json(
        { ok: false, reason: 'no collection has ever completed' },
        { 'Cache-Control': 'no-store' },
        503,
      );
    }

    const ageMs = Date.now() - Date.parse(meta.checked_at);
    const fresh = Number.isFinite(ageMs) && ageMs <= HEALTH_STALE_AFTER_MS;
    return json(
      {
        ok: fresh,
        ...(fresh ? {} : { reason: 'snapshot is stale — collection has stopped' }),
        checked_at: meta.checked_at,
        age_minutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null,
        total: meta.total,
        impacted: meta.impacted,
        unknown: meta.unknown,
      },
      { 'Cache-Control': 'no-store' },
      fresh ? 200 : 503,
    );
  }

  if (path === '/api/truth-check') {
    return handleTruthCheck(request, env);
  }

  const { records, meta, truthCheck } = await readSnapshot(env.DB);

  if (path === '/api/status') {
    return json({ meta, records, truthCheck }, { 'Cache-Control': 'public, max-age=60' });
  }

  if (path === '/' || path === '/index.html') {
    // Per-response nonce gates the single inline script, so the CSP can forbid
    // everything else outright rather than allowing 'unsafe-inline' scripts.
    const nonce = crypto.randomUUID().replace(/-/g, '');
    return new Response(renderDashboard({ records, meta, truthCheck, basePath: base, nonce, host: url.hostname }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        // Vendor incident text is attacker-influenced third-party content
        // (audit finding M4). The renderer escapes on output; CSP is the
        // second line of defence.
        'Content-Security-Policy':
          // 'self' is required for the site's own /assets/site.css,
          // /assets/js/theme.js and /assets/js/consent.js, which this page
          // reuses so it matches the site, shares its appearance preference,
          // and honours the same analytics consent decision.
          //
          // The two remote origins are the site's analytics, added 2026-08-04
          // so this page reports alongside the rest of briangreenberg.net
          // (render.js ANALYTICS):
          //   static.cloudflareinsights.com  the cookieless beacon script
          //   www.googletagmanager.com       the Google tag, which the consent
          //                                  gate injects only after consent
          // connect-src opens for exactly those two to report back, and
          // nothing else. Everything not named here stays denied, and the
          // inline script remains nonce-gated rather than 'unsafe-inline'.
          `default-src 'none'; ` +
          `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com https://www.googletagmanager.com; ` +
          `style-src 'self' 'unsafe-inline'; ` +
          `img-src 'self' data: https://www.google-analytics.com; ` +
          `font-src 'self'; ` +
          `connect-src https://cloudflareinsights.com https://static.cloudflareinsights.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; ` +
          `base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Strict-Transport-Security': HSTS,
      },
    });
  }

  return new Response('Not found', {
    status: 404,
    headers: { 'Strict-Transport-Security': HSTS },
  });
}

/**
 * The external truth-check workflow's write path (spec:
 * docs/superpowers/specs/2026-09-05-truth-check-design.md). Bearer-token
 * gated on a Worker secret; disabled (501) until one is configured so a fork
 * needs nothing. The body is a trust boundary: shape-checked and bounded
 * before it reaches D1, and vendor names are rendered escaped like any other
 * vendor string.
 * @param {Request} request
 * @param {{DB: D1Database, TRUTH_CHECK_TOKEN?: string}} env
 */
async function handleTruthCheck(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, { Allow: 'POST', 'Cache-Control': 'no-store' }, 405);
  }
  const expected = env.TRUTH_CHECK_TOKEN;
  if (typeof expected !== 'string' || expected.length === 0) {
    return json({ error: 'truth-check not configured on this deployment' }, { 'Cache-Control': 'no-store' }, 501);
  }
  const auth = request.headers.get('Authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!constantTimeEqual(presented, expected)) {
    return json({ error: 'unauthorized' }, { 'Cache-Control': 'no-store' }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body must be JSON' }, { 'Cache-Control': 'no-store' }, 400);
  }
  const stamp = validateStamp(body);
  if (!stamp) {
    return json({ error: 'malformed stamp' }, { 'Cache-Control': 'no-store' }, 400);
  }
  await writeTruthCheck(env.DB, stamp);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'Strict-Transport-Security': HSTS } });
}

/**
 * Shape + bounds check for the stamp. Returns the cleaned stamp or null.
 * @param {any} body
 */
function validateStamp(body) {
  if (!body || typeof body !== 'object') return null;
  const count = (v) => Number.isInteger(v) && v >= 0 && v <= 10_000;
  // An ISO-8601 stamp is under 40 characters; anything longer is not a date.
  if (typeof body.checkedAt !== 'string' || body.checkedAt.length === 0 || body.checkedAt.length > 40) return null;
  if (Number.isNaN(Date.parse(body.checkedAt))) return null;
  if (![body.covered, body.total, body.agreed, body.disagreements].every(count)) return null;
  if (!Array.isArray(body.falseGreen) || body.falseGreen.length > 200) return null;
  if (!body.falseGreen.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200)) return null;
  // Internal consistency — an inconsistent stamp would render contradictory
  // verification text, so it is refused like any other malformed body.
  if (body.covered > body.total || body.agreed > body.covered || body.disagreements > body.covered) return null;
  if (body.disagreements !== body.falseGreen.length) return null;
  return {
    checkedAt: new Date(body.checkedAt).toISOString(),
    covered: body.covered,
    total: body.total,
    agreed: body.agreed,
    disagreements: body.disagreements,
    falseGreen: body.falseGreen,
  };
}

/**
 * Length-independent comparison — a bearer token must not leak by timing.
 * Portable (no crypto.subtle.timingSafeEqual dependency): compares every
 * byte of the longer string against the shorter one padded, then folds the
 * length difference in.
 * @param {string} a @param {string} b
 */
function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Every response this Worker serves upholds the zone's transport posture —
// the route intercepts /service-status*, so the site's own headers never
// apply here (site-auditor headers.hsts finding, 2026-08-04).
const HSTS = 'max-age=31536000; includeSubDomains';

/** @param {any} body @param {Record<string,string>} [headers] @param {number} [status] */
function json(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Strict-Transport-Security': HSTS,
      ...headers,
    },
  });
}

export default {
  scheduled,
  fetch: handleFetch,
};
