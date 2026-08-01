#!/usr/bin/env node
/**
 * perf-check.mjs — the CPU-budget tier (testing.md §1, §6).
 *
 * Run on demand or nightly, NEVER as a per-PR gate:
 *
 *   npm run perf
 *
 * WHY IT IS NOT A UNIT TEST. This began life as
 * `expect(Date.now() - t0).toBeLessThan(50)` inside the vitest suite. Rewriting
 * it as a machine-relative ratio to survive a loaded CI runner did not fix it —
 * it failed 2 runs in 3 on an idle laptop, because at sub-millisecond durations
 * the measurement is dominated by JIT warm-up and GC, not by the algorithm.
 * A flaky gate is worse than no gate: it teaches people to re-run until green,
 * and then a real regression gets re-run past too.
 *
 * WHAT IT GUARDS. Workers **free** plan allows 10 ms of CPU per Cron Trigger.
 * Okta's status page is ~347 KB and the adapter parses it with indexOf plus a
 * linear bracket walk specifically to stay inside that. If someone replaces
 * that with a regex over the whole document, collection starts being killed
 * mid-run — which reports healthy vendors as `unknown`, the same user-visible
 * failure as the subrequest incident, from a different cause.
 *
 * Reports numbers and exits non-zero only on a gross regression, so it is
 * usable as a nightly job without becoming a source of noise.
 */

import { readFileSync } from 'node:fs';
import { parseOkta } from '../src/engine/adapters/okta.js';
import { collect } from '../src/engine/collect.js';
import { selectShard, SHARD_COUNT } from '../src/engine/shard.js';

const now = () => new Date('2026-07-31T23:30:00Z');

/** Median of n runs, after a warm-up, in milliseconds. */
function median(fn, runs = 9) {
  fn(); // warm up the JIT
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

const CPU_BUDGET_MS = 10;
let failed = false;

function report(label, ms, budget) {
  const pct = ((ms / budget) * 100).toFixed(0);
  const verdict = ms > budget ? 'OVER BUDGET' : 'ok';
  if (ms > budget) failed = true;
  console.log(`  ${label.padEnd(44)} ${ms.toFixed(2).padStart(7)} ms  (${pct}% of ${budget} ms)  ${verdict}`);
}

console.log(`\nCPU budget checks — Workers free plan allows ${CPU_BUDGET_MS} ms per Cron Trigger\n`);

// 1. The single most expensive parse in the collector.
const oktaPage =
  'x'.repeat(300_000) +
  '[{"attributes":{"type":"Incident__c"},"Status__c":"Resolved"}]' +
  'y'.repeat(47_000);
report('Okta — 347 KB page, targeted scan', median(() => parseOkta(oktaPage, { vendor: 'Okta', now })), CPU_BUDGET_MS);

// 2. Scaling: parsing must not be linear in document size.
const huge = 'x'.repeat(3_000_000) + '[{"attributes":{"type":"Incident__c"},"Status__c":"Resolved"}]';
const small = Math.max(median(() => parseOkta(oktaPage, { vendor: 'Okta', now })), 0.001);
const big = median(() => parseOkta(huge, { vendor: 'Okta', now }));
console.log(`  ${'Okta — 10x document, cost ratio'.padEnd(44)} ${(big / small).toFixed(2).padStart(7)} x        (linear would be ~10x)`);

// 3. A whole shard's worth of parsing, against recorded payloads.
const config = JSON.parse(readFileSync('config/vendors.json', 'utf8'));
const shard = selectShard(config.vendors, 0, SHARD_COUNT);
const stub = async () =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

// Measured as CPU, not wall time. The collector awaits ~14 concurrent fetches,
// so wall time counts scheduling and event-loop idle that Cloudflare does not
// bill against the 10 ms CPU budget — an early version of this script reported
// 20 ms "OVER BUDGET" for work that actually costs a fraction of that.
const cpu0 = process.cpuUsage();
await collect({ ...config, vendors: shard }, { fetchFn: stub, now, retryDelayMs: 0 });
const cpu = process.cpuUsage(cpu0);
const shardCpuMs = (cpu.user + cpu.system) / 1000;

// INFORMATIONAL, not a pass/fail gate. Node's process.cpuUsage() covers the
// whole process — module graph loading, Response construction in the stub, GC
// — on a different V8 build and a different machine from workerd. It reads
// several times higher than the figure Cloudflare bills, so gating on it would
// fail permanently while production is provably fine. The authoritative number
// is `cpuTime` in Workers Logs; this line exists to catch a 10x shift, which a
// human reading the trend will notice.
console.log(
  `  ${`one shard (${shard.length} vendors), node CPU`.padEnd(44)} ${shardCpuMs
    .toFixed(2)
    .padStart(7)} ms         (informational — see note)`,
);

console.log(
  `\nCPU measured via process.cpuUsage(), not wall time: the collector awaits\n` +
    `~${shard.length} concurrent fetches, and event-loop idle is not billed.\n` +
    `Workers Logs reports the authoritative production figure.\n`,
);


// ---------------------------------------------------------------------------
// PER-SHARD CPU, the check that would have caught the 2026-08-01 outage.
//
// Every cron from 16:00Z failed with `exceededResources` at cpuP99 = 10,000 us
// -- the free plan's 10 ms CPU ceiling -- because Oracle (1.63 MB), IBM
// (2.44 MB) and AWS (1.25 MB catalogue) landed in shards together. Collection
// stopped for over three hours.
//
// Nothing alerted. The in-handler alerts cannot fire, because an invocation
// killed for exceeding CPU never reaches them; the only detector was the
// staleness banner on the page, i.e. a human noticing. This check moves that
// detection BEFORE the deploy.
//
// Measured against live payloads, so it reflects what the vendors actually
// serve today rather than a fixture recorded when they were small.
// ---------------------------------------------------------------------------
console.log(`\nPer-shard PARSE CPU (${SHARD_COUNT} shards) — ceiling is ${CPU_BUDGET_MS} ms per invocation\n`);

const WARN_AT_MS = 4; // well under the ceiling: act long before it bites

// Measure PARSING ONLY.
//
// A first version timed collect() against the live network and reported every
// shard at 50-400 ms "OVER CEILING" — that was Node's TLS handshakes and HTTP
// decoding, work workerd does outside our CPU budget. It would have been a
// permanently-red gate, i.e. useless, which is the same mistake as the flaky
// timing test removed earlier.
//
// So: fetch every payload FIRST (uncounted), then run collect() against an
// in-memory fetch stub. What remains is adapter parsing and record assembly —
// the work Cloudflare actually bills us for.
const bodyFor = new Map();
async function prefetch(url) {
  if (bodyFor.has(url)) return;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'vendor-dashboard/2.0 (perf-check)' } });
    bodyFor.set(url, await res.text());
  } catch {
    bodyFor.set(url, '');
  }
}

const urlsOf = (v) =>
  (v.type === 'composite' ? (v.sources ?? []).map((s) => s.url) : [v.url]).concat(
    [v.componentsUrl, v.bannerUrl].filter(Boolean),
  );

const cachedFetch = async (url) =>
  new Response(bodyFor.get(String(url)) ?? '', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const shardCosts = [];
for (let i = 0; i < SHARD_COUNT; i += 1) {
  const vendors = selectShard(config.vendors, i);
  if (vendors.length === 0) continue;
  for (const v of vendors) for (const u of urlsOf(v)) await prefetch(u);

  await collect({ ...config, vendors }, { fetchFn: cachedFetch, now, retryDelayMs: 0 }); // warm
  const before = process.cpuUsage();
  await collect({ ...config, vendors }, { fetchFn: cachedFetch, now, retryDelayMs: 0 });
  const used = process.cpuUsage(before);
  shardCosts.push({ i, ms: (used.user + used.system) / 1000, names: vendors.map((v) => v.name) });
}

shardCosts.sort((a, b) => b.ms - a.ms);
for (const s of shardCosts.slice(0, 6)) {
  const flag = s.ms > CPU_BUDGET_MS ? 'OVER CEILING' : s.ms > WARN_AT_MS ? 'near ceiling' : 'ok';
  if (s.ms > WARN_AT_MS) failed = true;
  console.log(
    `  shard ${String(s.i).padStart(2)}  ${s.ms.toFixed(2).padStart(7)} ms  ${flag.padEnd(13)} ${s.names.join(', ').slice(0, 58)}`,
  );
}
console.log(
  `\nA shard trending past ${WARN_AT_MS} ms is the signal to raise SHARD_COUNT, BEFORE production\n` +
    `starts failing with exceededResources. On 2026-08-01 it failed for 3.5 hours and the only\n` +
    `detector was the staleness banner — in-handler alerts cannot fire when the invocation is killed.\n`,
);

process.exit(failed ? 1 : 0);
