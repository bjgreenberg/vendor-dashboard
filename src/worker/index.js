/**
 * Cloudflare Worker entry point.
 *
 * Thin by design: this file wires Cloudflare bindings to the runtime-agnostic
 * engine and does no status logic of its own. Everything that decides whether a
 * vendor is healthy lives in src/engine/ and is unit-tested without a network
 * or a Worker runtime.
 */

import { collect, DEFAULT_SUBREQUEST_BUDGET } from '../engine/collect.js';
import { relookCandidates, classifyRelook } from '../engine/relook.js';
import { selectShard, shardDueAt, SHARD_COUNT } from '../engine/shard.js';
import { writeRun, readSnapshot, readMeta, writeTruthCheck, readNewStreaks } from './storage.js';
import { siteAssetVersions } from './site-assets.js';
import { renderLlmsTxt, renderMarkdown } from './llms.js';
import { agentOf, countFetch, stats as aiFetchStats } from './ai-fetches.js';
import { renderDashboard, CANONICAL_HOST } from './render.js';
import vendorConfig from '../../config/vendors.json';

/** Must match `triggers.crons` in wrangler.jsonc; shard rotation is derived from it. */
const CRON_EVERY_MINUTES = 1;

/** Every configured vendor's name: what lets storage prune rows for removed vendors. */
const KNOWN_VENDOR_NAMES = vendorConfig.vendors.map((v) => v.name);

/** How many times a run looks again at a vendor whose fetch failed, and how long it waits before each. */
const RELOOKS = 2;
const RELOOK_DELAY_MS = 60_000;

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
  const at = new Date(controller.scheduledTime ?? Date.now());
  const shard = shardDueAt(at, SHARD_COUNT, CRON_EVERY_MINUTES);
  const vendors = selectShard(vendorConfig.vendors, shard, SHARD_COUNT);

  // The batch, then another look at whichever of its vendors failed in a way
  // a minute might fix. If the batch throws, that error escapes and there is
  // no re-look: the note above on why a thrown run must be visible applies.
  await lookAgain(env, shard, await collectBatch(env, shard, vendors));
}

/**
 * collect(), plus the one log line that must not be lost.
 *
 * Shared by the batch and the re-looks so they cannot drift apart: each fetch
 * that failed at least once and then answered logs which try and how long it
 * took, BEFORE any D1 write. That line is the only trace a recovered stall
 * leaves, and a run that waited one out and then lost its write must not lose
 * the evidence too.
 *
 * @param {object[]} vendors
 * @param {number} shard
 * @param {object} [tag] extra fields for the log line, e.g. {relook: true, look: 1}
 */
async function collectLogged(vendors, shard, tag = {}) {
  const run = await collect({ ...vendorConfig, vendors }, { fetchFn: fetch.bind(globalThis) });
  for (const r of run.retried) {
    console.log(JSON.stringify({ event: 'fetch_retried_ok', shard, ...tag, ...r }));
  }
  return run;
}

/**
 * SELF-MONITORING, shared by the batch and the re-looks.
 *
 * The 2026-07-31 incident was not a gap in logging -- `collection_complete`
 * had been emitting `unknown: 17` every run for hours. The gap was that
 * nothing ever compared that number against a threshold, so the only detector
 * in the system was a human noticing orange boxes on his phone. These checks
 * are that comparison. They log at ERROR so they are separable from routine
 * output by severity alone (`wrangler tail --status=error` shows only
 * exceptions, so a plain console.warn here would have stayed invisible).
 *
 * @param {object} run a collect() result
 * @param {number} shard
 * @param {{batch: boolean, tag?: object}} opts `batch` is false for a
 *   re-look, which then skips two checks. A re-look collects just the vendors
 *   that already failed, so "most of them are still unknown" says nothing
 *   new. And for a vendor that is still failing, its warning is the batch's
 *   over again (the same failed fetch, up to twice more), so `lookAgain`
 *   logs only the warnings that say something new: those of a vendor it gave
 *   up on. The other alerts here are raised either way.
 */
function selfMonitor(run, shard, { batch, tag = {} }) {
  const alerts = [];

  if (run.budgetExhausted) {
    alerts.push({
      alert: 'subrequest_budget_exhausted',
      detail: `${run.subrequests} subrequests spent; some vendors were never checked`,
    });
  }

  // A whole shard failing is infrastructure (budget, DNS, egress), not 14
  // vendors coincidentally breaking at once.
  if (batch && run.total > 0 && run.unknown / run.total >= 0.5) {
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
      detail: `${run.subrequests} of the collector's ${DEFAULT_SUBREQUEST_BUDGET} budget; a run should cost ~5 — look for a retry storm or config mistake`,
    });
  }

  for (const a of alerts) {
    console.error(JSON.stringify({ event: 'collection_alert', shard, ...tag, ...a }));
  }

  // Surface config drift and staleness rather than letting it accumulate silently.
  if (!batch) return;
  for (const warning of run.warnings) {
    console.warn(JSON.stringify({ event: 'collection_warning', ...tag, detail: warning }));
  }
}

/**
 * Look again, a minute after the batch and a minute after that look ends, at
 * the vendors of THIS batch that have just gone unknown because a fetch failed in a way that
 * waiting might fix.
 *
 * WHY: the patient last try (10 s, 10 s, 25 s) cut unknown checks from 0.41%
 * to 0.06% in its first 16 hours, but a feed that stalls for longer than
 * ~46 s is still written `unknown`, and stayed on the board that way until
 * its batch came round again 15 minutes later. NetSuite and Dropbox both did
 * on 2026-10-02. Their feeds were answering again within a minute or two.
 *
 * WHY HERE, in the run that saw the failure, and not in the next minutes'
 * runs reading a queue from D1: which vendors failed, and whether the failure
 * is worth another look, come from collect() itself (`run.waitable`), so
 * there is no queue, no claim, no second run racing for the same vendor, and
 * no reason text to interpret. An earlier draft did it across runs; three
 * review passes on PR #160 found a lost update, a double claim and a starved
 * queue in it. A scheduled Worker may run for 15 minutes and waiting costs no
 * CPU, so what this adds is affordable: two waits and two full sets of tries,
 * about four minutes. If the platform ends the invocation early, the
 * vendor simply waits for its batch, as it always did.
 *
 * WHO: a vendor that is `waitable` AND whose unknown streak is one check old
 * (readNewStreaks). The second condition is the cap. A vendor that has been
 * down for hours fails every batch; without it, each of those batches would
 * take two more looks and hold its run open four minutes, for as long as the
 * outage lasted. An outage gets its re-looks once, at the start.
 *
 * THE RULE THAT MAKES IT SAFE: a re-look may only IMPROVE a row (decided by
 * classifyRelook in the engine). It writes a vendor only when that vendor was
 * read WHOLE, from one document per source: every source answered, the
 * adapter understood each one, and no extra document was involved. Otherwise
 * it writes nothing. So `unknown` is never written here, and a
 * vendor built from several feeds that answered only in part is left as the
 * batch wrote it — a verified outage on one feed cannot be replaced by a
 * milder reading that is missing that feed.
 * The write does not stamp the run clock (`stampRun: false`), and it does not
 * prune removed vendors: both belong to the batch, and a prune from a run
 * that has been waiting for minutes would use a vendor list a deploy may have
 * changed in the meantime.
 *
 * A vendor leaves the list when it recovers, or when its failure is no longer
 * one that waiting fixes (a stall that has become a 404).
 *
 * It NEVER rejects: a re-look is a bonus. A failure in one look is logged at
 * ERROR, with the vendors and the look, and the next look (if one is left)
 * tries again. That includes a failed write: a vendor that was read but not
 * written keeps its place. A re-look that runs out of subrequest budget ends them: it
 * could not ask everyone, so nothing it read is written.
 *
 * NOT for vendors that read more than one document (a component list, a
 * catalogue, one document per data centre or cloud): see relookCandidates and
 * classifyRelook in the engine.
 *
 * Known cost: the invocation stays open, so its log lines (the batch's
 * included) reach Workers Logs when the re-looks finish, not when the batch
 * does.
 *
 * @param {{DB: D1Database}} env
 * @param {number} shard
 * @param {object[]} vendors the batch's vendors that collect() marked waitable
 */
async function lookAgain(env, shard, vendors) {
  const names = (list) => list.map((v) => v.name).sort();
  const failed = (look, affected, error) =>
    console.error(
      JSON.stringify({
        event: 'collection_alert',
        shard,
        relook: true,
        look,
        alert: 'relook_failed',
        vendors: names(affected),
        detail: String(error?.message ?? error),
      }),
    );

  const eligible = relookCandidates(vendors);
  let pending;
  try {
    // Only vendors whose outage has just begun.
    const fresh = new Set(await readNewStreaks(env.DB, eligible.map((v) => v.name)));
    pending = eligible.filter((v) => fresh.has(v.name));
  } catch (error) {
    failed(0, eligible, error);
    return;
  }

  // A vendor that failed waitably and still gets no re-look is said so, with
  // the reason. Without this line a search for its `relook_complete` finds
  // nothing, and "left out on purpose" looks the same as "the run was ended
  // during its wait". Two cases never reach this line: a batch that ran out
  // of budget (no vendors are passed in), and a failed streak read (the
  // `relook_failed` line above names the vendors it was asked about).
  if (pending.length < vendors.length) {
    console.log(
      JSON.stringify({
        event: 'relook_skipped',
        shard,
        multi_document: names(vendors.filter((v) => !eligible.includes(v))), // reads more than one document
        // No unknown streak began with this batch: the vendor was already
        // unknown before it, or its row is not unknown at all (a vendor of
        // several feeds, one stalled, the others read).
        no_new_streak: names(eligible.filter((v) => !pending.includes(v))),
      }),
    );
  }

  for (let look = 1; look <= RELOOKS && pending.length > 0; look += 1) {
    const tag = { relook: true, look };
    try {
      await new Promise((resolve) => setTimeout(resolve, RELOOK_DELAY_MS));
      const started = Date.now();
      const run = await collectLogged(pending, shard, tag);
      selfMonitor(run, shard, { batch: false, tag });

      // Every relook_complete line carries the same five lists.
      const line = (lists) =>
        console.log(
          JSON.stringify({
            event: 'relook_complete',
            shard,
            look,
            recovered: [], // read in full and written
            still_failing: [], // still failing in a way a minute might fix
            gave_up: [], // not read whole, and not for a waitable reason
            not_written: [], // read whole, but the write failed (see relook_failed)
            not_checked: [], // our own budget ran out before they could be asked
            ...lists,
            subrequests: run.subrequests,
            duration_ms: Date.now() - started,
          }),
        );

      if (run.budgetExhausted) {
        // It could not ask everyone, so nothing it read is written and no
        // further look is taken. selfMonitor has raised the alert.
        line({ not_checked: names(pending) });
        return;
      }

      const { recovered, stillFailing, gaveUp } = classifyRelook(run, pending);
      // Why a vendor was given up on is new information: the failure is no
      // longer the kind the batch saw (a stall that became a 404), and the
      // row still carries the batch's reason. Said once, here.
      const lost = new Set(gaveUp.map((v) => v.name));
      for (const r of run.records) {
        if (!lost.has(r.vendor)) continue;
        for (const w of r.warnings ?? []) {
          console.warn(JSON.stringify({ event: 'collection_warning', ...tag, detail: `${r.vendor}: ${w}` }));
        }
      }
      let written = recovered;
      let unwritten = [];
      if (recovered.length > 0) {
        try {
          await writeRun(env.DB, { ...run, records: recovered }, { stampRun: false });
        } catch (error) {
          // Read, but not written. They keep their place, so the next look
          // (if one is left) reads and writes them again.
          const read = new Set(recovered.map((r) => r.vendor));
          unwritten = pending.filter((v) => read.has(v.name));
          written = [];
          failed(look, unwritten, error);
        }
      }

      line({
        recovered: written.map((r) => r.vendor).sort(),
        still_failing: names(stillFailing),
        gave_up: names(gaveUp),
        not_written: names(unwritten),
      });
      pending = [...stillFailing, ...unwritten];
    } catch (error) {
      // This look is lost; the vendors keep their place and the next look,
      // if one is left, tries again.
      failed(look, pending, error);
    }
  }
}

/**
 * Collect, write and self-monitor one batch (shard).
 *
 * @param {{DB: D1Database}} env
 * @param {number} shard
 * @param {object[]} vendors
 * @returns {Promise<object[]>} the batch's vendors that are worth another look
 */
async function collectBatch(env, shard, vendors) {
  const started = Date.now();

  // Collect one shard per invocation. Two free-plan ceilings originally
  // forced the split (50 subrequests, 10 ms CPU — both bit in production).
  // Workers Paid (2026-08-02) removed the hard limits, but sharding stays:
  // it keeps each invocation tiny, bounds any one vendor's blast radius, and
  // is battle-tested. One invocation covers ~3 vendors; every vendor is still
  // refreshed once per 15 minutes.

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
    return [];
  }

  const run = await collectLogged(vendors, shard);

  // Pass the FULL configured vendor list, not the shard: it is what lets
  // storage prune rows for vendors that have been removed from config
  // entirely, which a shard-scoped delete can never reach.
  await writeRun(env.DB, run, { knownVendors: KNOWN_VENDOR_NAMES });

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
      // Fetches that failed at least once and then answered (detail is in
      // the fetch_retried_ok lines above).
      retried_ok: run.retriedOk,
      duration_ms: Date.now() - started,
    }),
  );

  selfMonitor(run, shard, { batch: true });

  // Who is worth another look? Nobody, when the batch ran out of subrequest
  // budget: that is an operator fault, and such a batch starts no streaks, so
  // "a streak one check old" would be read from an earlier cycle.
  if (run.budgetExhausted) return [];
  const waitable = new Set(run.waitable);
  return vendors.filter((v) => waitable.has(v.name));
}

/**
 * HTTP handler: the dashboard plus a JSON endpoint.
 *
 * @param {Request} request
 * @param {{DB: D1Database, BASE_PATH?: string}} env
 */
async function handleFetch(request, env, ctx) {
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

  // AI-fetch stats need none of the snapshot: answer before reading it
  // (Copilot, #156 — mission-control polls this).
  if (path === '/ai-fetches.json') {
    const body = await aiFetchStats(env.DB, { site: 'briangreenberg.net/service-status' });
    return json(body, { 'Cache-Control': 'public, max-age=300' });
  }

  const { records, meta, truthCheck } = await readSnapshot(env.DB);

  if (path === '/api/status') {
    return json({ meta, records, truthCheck }, { 'Cache-Control': 'public, max-age=60' });
  }

  // AI-tool views of the same snapshot (worklist #127): an llms.txt for this
  // subpath and the llmstxt.org clean-Markdown copy of the page.
  if (path === '/llms.txt' || path === '/index.md') {
    const view = { records, meta, truthCheck, origin: url.origin, base };
    const llms = path === '/llms.txt';
    // Count who fetches the AI views (worklist #127), after the response.
    // GET/HEAD only, like the shared handler (Copilot, #156).
    if (request.method === 'GET' || request.method === 'HEAD') {
      const counted = countFetch(env.DB, {
        kind: llms ? 'llms.txt' : 'markdown',
        agent: agentOf(request.headers.get('User-Agent')),
        day: new Date().toISOString().slice(0, 10),
      });
      if (ctx?.waitUntil) ctx.waitUntil(counted);
      else await counted;
    }
    return new Response(llms ? renderLlmsTxt(view) : renderMarkdown(view), {
      headers: {
        'Content-Type': llms ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
        'Strict-Transport-Security': HSTS,
      },
    });
  }

  if (path === '/' || path === '/index.html') {
    // Per-response nonce gates the single inline script, so the CSP can forbid
    // everything else outright rather than allowing 'unsafe-inline' scripts.
    const nonce = crypto.randomUUID().replace(/-/g, '');
    // The site's assets exist only on the site's host; elsewhere (workers.dev)
    // the plain links are all there is.
    const assetVersions = url.hostname === CANONICAL_HOST ? await siteAssetVersions() : null;
    return new Response(renderDashboard({ records, meta, truthCheck, basePath: base, nonce, host: url.hostname, assetVersions }), {
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

// How far ahead of the Worker's clock a stamp's checkedAt may sit. Runner and
// Worker clocks drift by seconds; a stamp minutes ahead is not a clock.
const STAMP_MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * Shape + bounds check for the stamp. Returns the cleaned stamp or null.
 * @param {any} body
 */
function validateStamp(body) {
  if (!body || typeof body !== 'object') return null;
  const count = (v) => Number.isInteger(v) && v >= 0 && v <= 10_000;
  // An ISO-8601 stamp is under 40 characters; anything longer is not a date.
  if (typeof body.checkedAt !== 'string' || body.checkedAt.length === 0 || body.checkedAt.length > 40) return null;
  const checkedAtMs = Date.parse(body.checkedAt);
  if (Number.isNaN(checkedAtMs)) return null;
  // A future stamp would hold off "Truth check overdue" for as long as it
  // says — the one thing a leaked token must not buy. Allow ordinary clock
  // skew between the runner and the Worker, nothing more.
  if (checkedAtMs - Date.now() > STAMP_MAX_FUTURE_MS) return null;
  if (![body.covered, body.total, body.agreed, body.disagreements].every(count)) return null;
  if (!Array.isArray(body.falseGreen) || body.falseGreen.length > 200) return null;
  if (!body.falseGreen.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200)) return null;
  // Internal consistency — an inconsistent stamp would render contradictory
  // verification text, so it is refused like any other malformed body.
  if (body.covered > body.total || body.agreed > body.covered || body.disagreements > body.covered) return null;
  // The names of the vendors the check cannot read yet. Optional (an older
  // runner sends none); when sent, bounded like falseGreen and never more
  // names than the gap between total and covered.
  const uncovered = body.uncovered ?? [];
  if (!Array.isArray(uncovered) || uncovered.length > 200) return null;
  if (!uncovered.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200)) return null;
  if (uncovered.length > body.total - body.covered) return null;
  if (body.disagreements !== body.falseGreen.length) return null;
  return {
    checkedAt: new Date(body.checkedAt).toISOString(),
    covered: body.covered,
    total: body.total,
    agreed: body.agreed,
    disagreements: body.disagreements,
    falseGreen: body.falseGreen,
    uncovered,
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
