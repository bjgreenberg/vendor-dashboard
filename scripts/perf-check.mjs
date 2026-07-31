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
const config = JSON.parse(readFileSync('config/vendors.example.json', 'utf8'));
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

process.exit(failed ? 1 : 0);
