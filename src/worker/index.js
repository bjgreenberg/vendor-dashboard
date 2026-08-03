/**
 * Cloudflare Worker entry point.
 *
 * Thin by design: this file wires Cloudflare bindings to the runtime-agnostic
 * engine and does no status logic of its own. Everything that decides whether a
 * vendor is healthy lives in src/engine/ and is unit-tested without a network
 * or a Worker runtime.
 */

import { collect } from '../engine/collect.js';
import { selectShard, shardDueAt, SHARD_COUNT } from '../engine/shard.js';
import { writeRun, readSnapshot, readMeta } from './storage.js';
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

  // Collect one shard per invocation. Two free-plan ceilings forced the split:
  // 50 external subrequests (a full run measured ~47, so retries killed it
  // mid-flight and unreached vendors reported `unknown`) and 10 ms of CPU
  // (two multi-megabyte parsers in one invocation exceeded it). With 15 shards
  // on an every-minute cron, one invocation covers ~3 vendors and every vendor
  // is still refreshed once per 15 minutes.
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
      subrequest_ceiling: 50,
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

  // Approaching the ceiling is the leading indicator. It is what a run looked
  // like the day before it started failing, and it is the only signal that
  // arrives while there is still time to act.
  if (run.subrequests >= 40) {
    alerts.push({
      alert: 'subrequest_headroom_low',
      detail: `${run.subrequests} of a 50 ceiling; raise SHARD_COUNT before this starts truncating runs`,
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

  const { records, meta } = await readSnapshot(env.DB);

  if (path === '/api/status') {
    return json({ meta, records }, { 'Cache-Control': 'public, max-age=60' });
  }

  if (path === '/' || path === '/index.html') {
    // Per-response nonce gates the single inline script, so the CSP can forbid
    // everything else outright rather than allowing 'unsafe-inline' scripts.
    const nonce = crypto.randomUUID().replace(/-/g, '');
    return new Response(renderDashboard({ records, meta, basePath: base, nonce, host: url.hostname }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        // Vendor incident text is attacker-influenced third-party content
        // (audit finding M4). The renderer escapes on output; CSP is the
        // second line of defence.
        'Content-Security-Policy':
          // 'self' is required for the site's own /assets/site.css and
          // /assets/js/theme.js, which this page reuses so it matches the site
          // and shares its appearance preference. Everything else stays denied,
          // and the inline script is nonce-gated rather than 'unsafe-inline'.
          `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    });
  }

  return new Response('Not found', { status: 404 });
}

/** @param {any} body @param {Record<string,string>} [headers] @param {number} [status] */
function json(body, headers = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export default {
  scheduled,
  fetch: handleFetch,
};
