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

/**
 * Identify ourselves honestly.
 *
 * Audit finding L2: the predecessor forged a Chrome 91 user agent from 2021.
 * A stale forged UA is *more* likely to be filtered by bot protection than an
 * honest one, and vendors generally welcome well-behaved status pollers.
 */
export const USER_AGENT = 'vendor-dashboard/2.0 (+https://briangreenberg.net/status; status monitor)';

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

  let body;
  try {
    // AbortSignal.timeout is available in Workers and modern Node. Guard anyway
    // so an environment lacking it degrades to "no deadline" rather than crashing.
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;

    const response = await fetchFn(vendor.url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/xml, text/html' },
    });

    if (response && response.ok === false) {
      return unknownRecord(name, `fetch returned HTTP ${response.status}`, opts);
    }
    body = await response.text();
  } catch (error) {
    return unknownRecord(name, `fetch failed: ${error?.message ?? String(error)}`, opts);
  }

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
  const { fetchFn, now = () => new Date(), timeoutMs = DEFAULT_TIMEOUT_MS } = ctx ?? {};

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
  const settled = await Promise.allSettled(
    config.vendors.map((v) => collectOne(v, { fetchFn, now, timeoutMs })),
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
