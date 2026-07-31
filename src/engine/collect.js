/**
 * Collection orchestrator.
 *
 * Runtime-agnostic by construction: the caller injects `fetchFn` and `now`, so
 * this same module runs under a Cloudflare Worker, plain Node, a GCP Cloud Run
 * service, or a test with zero network. That injection is what keeps RHR's
 * hosting options open (see the RHR project notes).
 *
 * Preserves the one property the predecessor genuinely got right: every vendor
 * is isolated, so one vendor's outage or payload change degrades exactly one
 * row and never the run. It corrects what the predecessor got wrong: a failed
 * check now reports UNKNOWN rather than a green row (audit finding H4), and
 * vendors are fetched concurrently with a deadline rather than serially with
 * none (finding M5).
 */

import { SEVERITY, compareRecords, rank } from './severity.js';
import { unknownRecord } from './record.js';
import { parseStatuspage } from './adapters/statuspage.js';
import { parseInstatus } from './adapters/instatus.js';
import { parseGoogle } from './adapters/google.js';
import { parseApple } from './adapters/apple.js';
import { parseOktaAtom } from './adapters/okta.js';
import { parseSalesforce } from './adapters/salesforce.js';
import { parseConcur } from './adapters/concur.js';
import { parseSorryApp } from './adapters/sorryapp.js';
import { parseBetterStack } from './adapters/betterstack.js';
import { parseMicrosoft } from './adapters/microsoft.js';

/** Default per-vendor deadline. A hung status page must not stall the run. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Base backoff between retries; multiplied by attempt number and jittered. */
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * Total retries allowed across ALL vendors in one run.
 *
 * Sized against the Workers free-plan ceiling of 50 subrequests per invocation:
 * ~34 vendors plus Concur's banner is ~35 first attempts, leaving roughly 15 of
 * headroom. 10 keeps a margin for redirect chains, which also count.
 */
const DEFAULT_RETRY_BUDGET = 10;

/**
 * Identify ourselves honestly.
 *
 * Audit finding L2: the predecessor forged a Chrome 91 user agent from 2021.
 * A stale forged UA is *more* likely to be filtered by bot protection than an
 * honest one, and vendors generally welcome well-behaved status pollers.
 */
export const USER_AGENT = 'vendor-dashboard/2.0 (+https://briangreenberg.net/service-status; status monitor)';

/**
 * Adapters that consume parsed JSON.
 * @type {Record<string, (payload: any, opts: any) => any>}
 */
const JSON_ADAPTERS = {
  statuspage: parseStatuspage,
  instatus: parseInstatus,
  google: parseGoogle,
  apple: parseApple,
  salesforce: parseSalesforce,
  concur: parseConcur,
  sorryapp: parseSorryApp,
  microsoft: parseMicrosoft,
};

/**
 * Adapters that consume raw text.
 * @type {Record<string, (text: string, opts: any) => any>}
 */
const TEXT_ADAPTERS = {
  okta: parseOktaAtom,
  betterstack: parseBetterStack,
};

/**
 * HTTP statuses worth a second look.
 *
 * 404 is deliberately included, which is unusual. Microsoft's status endpoint
 * was measured at roughly 50% availability on 2026-07-31 — the same URL
 * returning 200, then 404, then 404 within seconds, and its sibling on
 * admin.microsoft.com alternating 404/200/404/200. Treating that as permanent
 * would render a healthy vendor UNKNOWN half the time: technically fail-closed,
 * but the kind of noise that trains an operator to stop reading the board.
 *
 * The cost of being wrong is bounded — after the attempt cap the answer is
 * still UNKNOWN, never a green row.
 */
const RETRYABLE_STATUS = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

/** Attempts per vendor, including the first. */
const MAX_ATTEMPTS = 3;

/**
 * Fetch with bounded retry.
 *
 * Retries consume a budget SHARED across the whole run, not just per vendor.
 * On the Workers free plan the subrequest ceiling is 50 per invocation; 34
 * vendors each retrying twice would be 102 and the run would be killed
 * mid-flight. The shared budget makes the worst case arithmetic rather than
 * hopeful.
 *
 * @param {string} url
 * @param {object} ctx
 * @returns {Promise<{ok: true, body: string} | {ok: false, reason: string}>}
 */
async function fetchWithRetry(url, ctx) {
  const { fetchFn, timeoutMs, retryDelayMs, budget } = ctx;
  let lastReason = 'fetch failed';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      // Budget is shared and mutable; when it runs out, stop retrying.
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      if (retryDelayMs > 0) {
        // Backoff with jitter so a flaky vendor is not hammered in lockstep.
        const wait = retryDelayMs * attempt * (0.5 + Math.random());
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    try {
      // AbortSignal.timeout exists in Workers and modern Node. Guard anyway so
      // an environment lacking it degrades to "no deadline" rather than crashing.
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined;

      const response = await fetchFn(url, {
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/xml, text/html' },
      });

      if (response && response.ok === false) {
        lastReason = `fetch returned HTTP ${response.status}`;
        if (RETRYABLE_STATUS.has(response.status)) continue;
        return { ok: false, reason: lastReason };
      }

      return { ok: true, body: await response.text() };
    } catch (error) {
      // A network-level failure is transient by nature; retry it.
      lastReason = `fetch failed: ${error?.message ?? String(error)}`;
    }
  }

  return { ok: false, reason: lastReason };
}

/**
 * Fetch and parse a single vendor. Never throws — every failure path returns an
 * UNKNOWN record so the caller always gets one row per configured vendor.
 *
 * @param {object} vendor config entry
 * @param {object} ctx
 * @returns {Promise<import('./record.js').StatusRecord>}
 */
async function collectOne(vendor, ctx) {
  const { fetchFn, now, timeoutMs } = ctx;
  const name = vendor?.name ?? 'unknown';
  const opts = {
    vendor: name,
    scope: vendor?.scope,
    dataCenters: vendor?.dataCenters,
    sourceUrl: vendor?.pageUrl ?? vendor?.url,
    now,
  };

  const isJson = Object.hasOwn(JSON_ADAPTERS, vendor?.type);
  const isText = Object.hasOwn(TEXT_ADAPTERS, vendor?.type);
  if (!isJson && !isText) {
    return unknownRecord(name, `no adapter registered for type "${vendor?.type}"`, opts);
  }

  const attempt = await fetchWithRetry(vendor.url, ctx);
  if (!attempt.ok) {
    return unknownRecord(name, attempt.reason, opts);
  }
  const body = attempt.body;

  try {
    if (isText) return TEXT_ADAPTERS[vendor.type](body, opts);

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return unknownRecord(name, 'response was not valid JSON', opts);
    }

    // Concur needs a second, optional payload; a failed banner must not sink it.
    if (vendor.type === 'concur' && vendor.bannerUrl) {
      try {
        const bannerRes = await fetchFn(vendor.bannerUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        opts.banner = JSON.parse(await bannerRes.text());
      } catch {
        /* banner is advisory; absence is not a failure */
      }
    }

    return JSON_ADAPTERS[vendor.type](payload, opts);
  } catch (error) {
    return unknownRecord(name, `adapter threw: ${error?.message ?? String(error)}`, opts);
  }
}

/**
 * Run a full collection pass.
 *
 * Throws on invalid configuration — deliberately. A run with no vendors would
 * otherwise write an empty snapshot that renders as a fully green board, which
 * is the worst possible failure for a monitoring tool. Better to fail the run
 * loudly and leave the previous snapshot in place.
 *
 * @param {{vendors: object[]}} config
 * @param {object} ctx
 * @param {(url: string, init?: any) => Promise<any>} ctx.fetchFn
 * @param {() => Date} [ctx.now]
 * @param {number} [ctx.timeoutMs]
 * @returns {Promise<{records: any[], checkedAt: string, total: number, impacted: number, unknown: number, warnings: string[]}>}
 */
export async function collect(config, ctx) {
  const {
    fetchFn,
    now = () => new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    retryBudget = DEFAULT_RETRY_BUDGET,
  } = ctx ?? {};

  if (!config || !Array.isArray(config.vendors)) {
    throw new Error('collect: config.vendors must be an array');
  }
  if (config.vendors.length === 0) {
    throw new Error('collect: no vendors configured — refusing to write an empty (all-green) snapshot');
  }
  if (typeof fetchFn !== 'function') {
    throw new Error('collect: a fetchFn must be injected');
  }

  const checkedAt = now().toISOString();

  // Concurrent by design (finding M5). allSettled is belt-and-braces: collectOne
  // already swallows its own failures, but a bug there must still not lose rows.
  // Shared, mutable retry budget. Bounds total subrequests for the whole run.
  const budget = { remaining: retryBudget };

  const settled = await Promise.allSettled(
    config.vendors.map((v) => collectOne(v, { fetchFn, now, timeoutMs, retryDelayMs, budget })),
  );

  const records = settled.map((outcome, i) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : unknownRecord(config.vendors[i]?.name ?? 'unknown', `collector error: ${outcome.reason}`, { now }),
  );

  records.sort(compareRecords);

  const unknown = records.filter((r) => r.severity === SEVERITY.UNKNOWN).length;
  const impacted = records.filter(
    (r) => r.severity !== SEVERITY.OPERATIONAL && r.severity !== SEVERITY.UNKNOWN,
  ).length;

  const warnings = records.flatMap((r) => (r.warnings ?? []).map((w) => `${r.vendor}: ${w}`));

  return { records, checkedAt, total: records.length, impacted, unknown, warnings };
}

export { rank };
