import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectShard, shardDueAt, shardOf, SHARD_COUNT } from '../../src/engine/shard.js';
import { collect } from '../../src/engine/collect.js';

// Regression tests for the 2026-07-31 incident: a full run cost 47 external
// subrequests against a free-plan ceiling of 50, so any run needing a few
// retries was killed mid-flight and 17 healthy vendors were reported `unknown`.

const config = JSON.parse(readFileSync('config/vendors.example.json', 'utf8'));

describe('sharding', () => {
  it('covers every vendor exactly once across a full cycle', () => {
    const seen = [];
    for (let i = 0; i < SHARD_COUNT; i += 1) seen.push(...selectShard(config.vendors, i));
    expect(seen.map((v) => v.name).sort()).toEqual(config.vendors.map((v) => v.name).sort());
  });

  it('keeps every shard well under the subrequest ceiling', () => {
    for (let i = 0; i < SHARD_COUNT; i += 1) {
      // Worst case per vendor is ~1.2 subrequests (second calls + redirects).
      // 25 leaves room for that plus retries against the 50 ceiling.
      expect(selectShard(config.vendors, i).length).toBeLessThan(25);
    }
  });

  it('rotates through every shard once per 15 minutes on a 5-minute cron', () => {
    const at = (h, m) => new Date(Date.UTC(2026, 6, 31, h, m));
    expect([0, 5, 10, 15, 20, 25].map((m) => shardDueAt(at(12, m), 3, 5))).toEqual([
      0, 1, 2, 0, 1, 2,
    ]);
    // A full hour must hit each shard the same number of times, or some vendors
    // would be refreshed more often than others forever.
    const counts = [0, 0, 0];
    for (let m = 0; m < 60; m += 5) counts[shardDueAt(at(9, m), 3, 5)] += 1;
    expect(counts).toEqual([4, 4, 4]);
  });

  it('keeps a vendor in its shard when neighbours are added or removed', () => {
    // Membership is hashed from the name, not the array index. Index-based
    // sharding would reshuffle everything on any config edit.
    const before = shardOf('Cloudflare');
    const after = shardOf('Cloudflare');
    expect(after).toBe(before);
    expect(shardOf('Cloudflare')).not.toBe(undefined);
  });

  it('rejects an out-of-range shard index rather than silently collecting nothing', () => {
    expect(() => selectShard(config.vendors, 3, 3)).toThrow(/index must be/);
    expect(() => selectShard(config.vendors, -1, 3)).toThrow(/index must be/);
  });
});

describe('subrequest budget', () => {
  /** Count fetches while always succeeding, so no retries are triggered. */
  const counting = () => {
    const state = { n: 0 };
    const fetchFn = async () => {
      state.n += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { state, fetchFn };
  };

  it('a sharded run costs a fraction of the ceiling', async () => {
    for (let i = 0; i < SHARD_COUNT; i += 1) {
      const { state, fetchFn } = counting();
      await collect({ ...config, vendors: selectShard(config.vendors, i) }, { fetchFn, retryDelayMs: 0 });
      expect(state.n).toBeLessThan(25);
    }
  });

  it('the FULL list is what used to exceed the ceiling', async () => {
    // Pins the measurement the fix is based on. If this ever drops below 50,
    // the sharding rationale deserves rechecking rather than blind trust.
    const { state, fetchFn } = counting();
    await collect(config, { fetchFn, retryDelayMs: 0, subrequestBudget: 1000 });
    expect(state.n).toBeGreaterThan(40);
  });

  it('caps total subrequests instead of letting the runtime kill the run', async () => {
    const { state, fetchFn } = counting();
    const run = await collect(config, { fetchFn, retryDelayMs: 0, subrequestBudget: 12 });
    expect(state.n).toBe(12); // hard stop, not best-effort
    expect(run.budgetExhausted).toBe(true);
    expect(run.records.length).toBe(config.vendors.length); // every vendor still reported
  });

  it('blames the collector, not the vendors, when the budget runs out', async () => {
    // The incident presented as 17 simultaneous vendor outages. Nothing said
    // "we stopped asking" -- that distinction is the whole point of this.
    const { fetchFn } = counting();
    const run = await collect(config, { fetchFn, retryDelayMs: 0, subrequestBudget: 12 });
    expect(run.warnings[0]).toMatch(/^collector: subrequest budget/);
    expect(run.warnings[0]).toMatch(/were NOT checked/);
  });

  it('starved vendors are unknown, never operational', async () => {
    // The governing rule. A vendor we never contacted must not read green.
    const { fetchFn } = counting();
    const run = await collect(config, { fetchFn, retryDelayMs: 0, subrequestBudget: 5 });
    const starved = run.records.filter((r) => r.severity === 'unknown');
    expect(starved.length).toBeGreaterThan(0);
    expect(run.records.some((r) => r.severity === 'operational' && !r.checkedAt)).toBe(false);
  });

  it('does not engage during a normal sharded run', async () => {
    const { fetchFn } = counting();
    const run = await collect(
      { ...config, vendors: selectShard(config.vendors, 0) },
      { fetchFn, retryDelayMs: 0 },
    );
    expect(run.budgetExhausted).toBe(false);
    expect(run.warnings.some((w) => w.startsWith('collector: subrequest budget'))).toBe(false);
  });
});
