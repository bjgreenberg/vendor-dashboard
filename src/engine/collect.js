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

import { SEVERITY, compareRecords, rank, worst as worstOf } from './severity.js';
import { unknownRecord, makeRecord } from './record.js';
import { parseStatuspage } from './adapters/statuspage.js';
import { parseInstatus } from './adapters/instatus.js';
import { parseGoogle } from './adapters/google.js';
import { parseApple } from './adapters/apple.js';
import { parseOktaAtom } from './adapters/okta.js';
import { parseSalesforce } from './adapters/salesforce.js';
import { parseConcur } from './adapters/concur.js';
import { parseSorryApp } from './adapters/sorryapp.js';
import { parseBetterStack } from './adapters/betterstack.js';
import { parseMicrosoft, parseMicrosoftFeed, parseMicrosoftConsumer, parseMicrosoftAdminPost } from './adapters/microsoft.js';
import { parseAzureFeed, parseAzureDevOps, parseAzurePost } from './adapters/azure.js';
import { parseAws } from './adapters/aws.js';
import { parseIbmCloud } from './adapters/ibm.js';
import { parseOracle } from './adapters/oracle.js';
import { parseMetaStatus } from './adapters/metastatus.js';
import { parseSignal } from './adapters/signal.js';

/** Default per-vendor deadline. A hung status page must not stall the run. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Base backoff between retries; multiplied by attempt number and jittered. */
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * Total retries allowed across ALL vendors in one run.
 *
 * This bounds RETRIES only. It is not, and never was, a bound on the run's
 * total subrequests — see DEFAULT_SUBREQUEST_BUDGET, which is.
 */
const DEFAULT_RETRY_BUDGET = 10;

/**
 * Hard ceiling on subrequests for one invocation.
 *
 * The Workers *free* plan allows 50 EXTERNAL subrequests per invocation and
 * refuses `limits.subrequests` (paid-plan only). Exceeding it is not a
 * recoverable error: the runtime kills every remaining fetch, so vendors late
 * in the run report `unknown` while being healthy.
 *
 * This budget is deliberately lower than 50. Redirect chains are followed by
 * the runtime and count against the ceiling WITHOUT being visible to us as
 * fetch calls, so our count always understates the true spend — measured
 * 2026-07-31, three vendors redirect. The margin absorbs that.
 *
 * Reaching this budget is a real defect, not a routine condition: with
 * sharding a run costs ~16. It is a backstop that converts a fatal, silent,
 * whole-run failure into a bounded and LOUD one.
 */
const DEFAULT_SUBREQUEST_BUDGET = 40;

/** Marker so an exhausted budget is reported distinctly from a vendor outage. */
export const BUDGET_EXHAUSTED = 'subrequest budget exhausted';

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
  'azure-devops': parseAzureDevOps,
  'azure-post': parseAzurePost,
  'microsoft-consumer': parseMicrosoftConsumer,
  'microsoft-admin': parseMicrosoftAdminPost,
  aws: parseAws,
  oracle: parseOracle,
  metastatus: parseMetaStatus,
};

/**
 * Adapters that consume raw text.
 * @type {Record<string, (text: string, opts: any) => any>}
 */
const TEXT_ADAPTERS = {
  okta: parseOktaAtom,
  'microsoft-feed': parseMicrosoftFeed,
  'azure-feed': parseAzureFeed,
  'ibm-cloud': parseIbmCloud,
  signal: parseSignal,
  betterstack: parseBetterStack,
};

/**
 * HTTP statuses worth a second look.
 *
 * 404 is NOT retryable, despite once being listed here.
 *
 * It was added because Microsoft's endpoint measured ~50% availability on
 * 2026-07-31 — the same URL returning 200, then 404, then 404 within seconds.
 * That reading was real but the diagnosis was wrong: the route was being
 * PROGRESSIVELY DECOMMISSIONED, not flapping. By 2026-08-01 it answered 404
 * every time with `{"Message":"No HTTP resource was found ..."}`, and so did
 * the admin.microsoft.com sibling configured as its fallback.
 *
 * Retrying a retired route cannot succeed. It spends up to three subrequests
 * per vendor from a budget capped at 50 to arrive at the same `unknown` — and
 * on the free plan that spend is exactly what starved other vendors. A 404 is
 * a statement that the resource does not exist; the correct response is to fix
 * the URL, which is what was done (see adapters/microsoft.js).
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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
 * Callers may pass several URLs. Each is tried in turn with the full retry
 * policy before moving on, which matters when a vendor publishes the same feed
 * at more than one address with PARTLY INDEPENDENT availability. Microsoft is
 * the case in point: measured over six rounds, portal.office.com and
 * admin.microsoft.com each failed roughly half the time, but both failed
 * together only twice — so falling back converts a coin flip into a good bet.
 *
 * @param {string[]} urls primary first, then fallbacks
 * @param {object} ctx
 * @returns {Promise<{ok: true, body: string} | {ok: false, reason: string}>}
 */
async function fetchWithFallback(urls, ctx) {
  let lastReason = 'fetch failed';
  for (const url of urls) {
    const attempt = await fetchWithRetry(url, ctx);
    if (attempt.ok) return attempt;
    lastReason = attempt.reason;
    // Only spend a fallback if the budget still allows it.
    if (ctx.budget.remaining <= 0) break;
  }
  return { ok: false, reason: lastReason };
}

/**
 * @param {string} url
 * @param {object} ctx
 * @returns {Promise<{ok: true, body: string} | {ok: false, reason: string}>}
 */
/**
 * Decode a response body, honouring UTF-16.
 *
 * `response.text()` ALWAYS decodes as UTF-8 per the fetch spec, regardless of
 * the charset the server declared. AWS serves
 * health.aws.amazon.com/public/currentevents as
 * `application/json;charset=utf-16` with a BOM, so text() would return
 * mojibake and every parse would fail closed to `unknown` -- a vendor that
 * looks broken when it is merely unusual.
 *
 * Sniffs the BOM rather than trusting the header, because the bytes are the
 * ground truth and a mislabelled charset is commoner than a wrong BOM. Falls
 * back to UTF-8, which is what every other vendor here uses.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function decodeBody(response) {
  const declared = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
  if (!declared.includes('utf-16')) return response.text();

  const buf = new Uint8Array(await response.arrayBuffer());
  const encoding =
    buf[0] === 0xff && buf[1] === 0xfe
      ? 'utf-16le'
      : buf[0] === 0xfe && buf[1] === 0xff
        ? 'utf-16be'
        : 'utf-16le'; // declared utf-16 with no BOM: little-endian is the common case
  return new TextDecoder(encoding).decode(buf);
}

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

      return { ok: true, body: await decodeBody(response) };
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
/**
 * Collect a vendor whose status comes from SEVERAL endpoints, merged into one
 * row.
 *
 * Microsoft is the motivating case. It publishes four unrelated feeds --
 * consumer products, Azure, the M365 admin centre, the Power Platform admin
 * centre -- plus Azure DevOps on a separate host. As five sibling rows they
 * sorted apart alphabetically and read as five unrelated companies. As one row
 * with grouped components, a reader sees "Microsoft" and expands to find which
 * part is affected, which is the same progressive disclosure every other
 * multi-component vendor already uses.
 *
 * Merge rules, all of which follow from the governing rule:
 *   - Row severity is the WORST across sources. One healthy source cannot mask
 *     a broken sibling.
 *   - A source that fails contributes an `unknown` component and its reason,
 *     rather than being silently dropped. Dropping it would let the row read
 *     green while a quarter of it was never checked -- the starvation bug
 *     again, at vendor scope.
 *   - Components are prefixed with their group so an expanded list is
 *     readable; a source with no components of its own becomes a single
 *     component named for its group.
 *
 * Subrequest cost is unchanged: five sources cost the same five fetches these
 * did as five separate vendors.
 *
 * @param {object} vendor
 * @param {object} ctx
 */
async function collectComposite(vendor, ctx) {
  const { now } = ctx;
  const name = vendor?.name ?? 'unknown';
  const sources = Array.isArray(vendor.sources) ? vendor.sources : [];

  if (sources.length === 0) {
    return unknownRecord(name, 'composite vendor declared no sources', {
      now,
      sourceUrl: vendor?.pageUrl,
    });
  }

  const parts = await Promise.all(
    sources.map((s) =>
      collectOne({ ...s, name }, ctx).then(
        (r) => ({ source: s, record: r }),
        (e) => ({
          source: s,
          record: unknownRecord(name, `collector error: ${e}`, { now }),
        }),
      ),
    ),
  );

  const components = [];
  const warnings = [];
  const affected = [];

  for (const { source, record } of parts) {
    const group = source.group ?? record.service ?? 'Status';
    const own = Array.isArray(record.components) ? record.components : [];

    if (own.length > 0) {
      for (const c of own) {
        components.push({ ...c, name: `${group} · ${c.name}` });
      }
    } else {
      // A single-status source (e.g. "Azure: Available") has no components of
      // its own; represent it as one, so it is visible when expanded.
      components.push({
        name: group,
        severity: record.severity,
        description: record.description ?? '',
      });
    }

    for (const w of record.warnings ?? []) warnings.push(`${group}: ${w}`);
    if (rank(record.severity) > rank(SEVERITY.OPERATIONAL)) affected.push(group);
  }

  const severity = worstOf(components.map((c) => c.severity));

  return makeRecord({
    vendor: name,
    service: vendor.service ?? name,
    severity,
    incidentName: affected.length ? 'Service issue' : '',
    description: affected.length
      ? `Affected: ${[...new Set(affected)].join(', ')}.`
      : `All ${components.length} monitored Microsoft services report healthy.`,
    sourceUrl: vendor?.pageUrl ?? '',
    components,
    warnings,
    now,
  });
}

async function collectOne(vendor, ctx) {
  const { fetchFn, now, timeoutMs } = ctx;
  const name = vendor?.name ?? 'unknown';
  const opts = {
    vendor: name,
    scope: vendor?.scope,
    componentLevel: vendor?.componentLevel,
    serviceCatalog: vendor?.serviceCatalog,
    dataCenters: vendor?.dataCenters,
    sourceUrl: vendor?.pageUrl ?? vendor?.url,
    now,
  };

  const isJson = Object.hasOwn(JSON_ADAPTERS, vendor?.type);
  const isText = Object.hasOwn(TEXT_ADAPTERS, vendor?.type);
  if (!isJson && !isText) {
    return unknownRecord(name, `no adapter registered for type "${vendor?.type}"`, opts);
  }

  const urls = [vendor.url, ...(Array.isArray(vendor.fallbackUrls) ? vendor.fallbackUrls : [])];
  const attempt = await fetchWithFallback(urls, ctx);
  if (!attempt.ok) {
    return unknownRecord(name, attempt.reason, opts);
  }
  const body = attempt.body;

  try {
    if (isText) {
      // BetterStack renders its resource list from a separate /sections
      // fragment; the main page carries no resource names at all.
      if (vendor.type === 'betterstack' && vendor.componentsUrl) {
        try {
          const res = await fetchFn(vendor.componentsUrl, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          });
          opts.sections = await res.text();
        } catch {
          /* advisory: the page-level state still stands */
        }
      }
      return TEXT_ADAPTERS[vendor.type](body, opts);
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return unknownRecord(name, 'response was not valid JSON', opts);
    }

    // Instatus splits page state and components across two endpoints; merge
    // them when a componentsUrl is configured. Advisory, like Concur's banner:
    // if it fails, the page-level status still stands.
    // Google publishes its product catalogue separately from its incidents feed.
    if (vendor.type === 'google' && vendor.componentsUrl) {
      try {
        const res = await fetchFn(vendor.componentsUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        opts.products = JSON.parse(await res.text());
      } catch {
        /* catalogue is advisory; incidents still decide severity */
      }
    }

    if (vendor.type === 'instatus' && vendor.componentsUrl) {
      try {
        const res = await fetchFn(vendor.componentsUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        const extra = JSON.parse(await res.text());
        if (Array.isArray(extra?.components)) payload.components = extra.components;
      } catch {
        /* components are advisory; page.status still decides severity */
      }
    }

    // SorryApp splits its component list onto a second endpoint, advertised in
    // the page payload as `links.components.href`. Without it the row has a
    // page-level status and NOTHING underneath, so a reader cannot see what the
    // vendor even covers -- the same gap found on Oracle, IBM and Seismic.
    if (vendor.type === 'sorryapp' && vendor.componentsUrl) {
      try {
        const res = await fetchFn(vendor.componentsUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        const extra = JSON.parse(await res.text());
        const list = Array.isArray(extra) ? extra : extra?.components;
        if (Array.isArray(list)) payload.components = list;
      } catch {
        /* components are advisory; page state still decides severity */
      }
    }

    // AWS's service catalogue is a separate 1.25 MB document, found by reading
    // the Health Dashboard's network log. Passed as RAW TEXT: the adapter
    // regex-scans it for distinct service names at 1.71 ms, where JSON.parse
    // costs 4.07 ms for the same answer.
    if (vendor.type === 'aws' && vendor.componentsUrl) {
      try {
        const res = await fetchFn(vendor.componentsUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        opts.catalogueText = await res.text();
      } catch {
        /* catalogue is advisory; active events still decide severity */
      }
    }

    // Concur's service catalogue lives on a separate endpoint, found by reading
    // the status page's network log. Without it the row listed services only
    // while something was broken, and showed nothing at all when healthy.
    if (vendor.type === 'concur' && vendor.componentsUrl) {
      try {
        const res = await fetchFn(vendor.componentsUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        opts.serviceCatalogue = JSON.parse(await res.text());
      } catch {
        /* catalogue is advisory; incidents still decide severity */
      }
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
    subrequestBudget = DEFAULT_SUBREQUEST_BUDGET,
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

  // Count EVERY subrequest by wrapping fetchFn itself, rather than incrementing
  // at each call site. Call sites were the original bug: the retry path was
  // metered while base attempts, fallbacks and the advisory second calls
  // (Concur's banner, Google's catalogue, Perplexity's components) were not, so
  // the run had no bound at all. Wrapping the injected function means a new
  // fetch site cannot be added later without being counted.
  const meter = { spent: 0, max: subrequestBudget, denied: 0 };
  const meteredFetch = async (url, init) => {
    if (meter.spent >= meter.max) {
      meter.denied += 1;
      throw new Error(BUDGET_EXHAUSTED);
    }
    meter.spent += 1;
    return fetchFn(url, init);
  };

  // Concurrent by design (finding M5). allSettled is belt-and-braces: collectOne
  // already swallows its own failures, but a bug there must still not lose rows.
  // Shared, mutable retry budget. Bounds total subrequests for the whole run.
  const budget = { remaining: retryBudget };

  const settled = await Promise.allSettled(
    config.vendors.map((v) => {
      const ctx = { fetchFn: meteredFetch, now, timeoutMs, retryDelayMs, budget };
      return v?.type === 'composite' ? collectComposite(v, ctx) : collectOne(v, ctx);
    }),
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

  // An exhausted budget is an OPERATOR fault, not a vendor one. Without this,
  // it presents as N unrelated vendors having simultaneous outages -- which is
  // exactly how it presented on 2026-07-31, and why it went unnoticed: nothing
  // distinguished "we stopped asking" from "they are down".
  if (meter.denied > 0) {
    warnings.unshift(
      `collector: subrequest budget of ${meter.max} exhausted; ${meter.denied} request(s) were never made. ` +
        `Affected vendors are reported unknown but were NOT checked. Reduce vendors per shard or raise SHARD_COUNT.`,
    );
  }

  return {
    records,
    checkedAt,
    total: records.length,
    impacted,
    unknown,
    warnings,
    subrequests: meter.spent,
    budgetExhausted: meter.denied > 0,
  };
}

export { rank };
