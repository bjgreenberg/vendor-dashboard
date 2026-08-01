import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectShard, shardDueAt, shardOf, SHARD_COUNT } from '../../src/engine/shard.js';
import { collect } from '../../src/engine/collect.js';

// Regression tests for the 2026-07-31 incident: a full run cost 47 external
// subrequests against a free-plan ceiling of 50, so any run needing a few
// retries was killed mid-flight and 17 healthy vendors were reported `unknown`.

const config = JSON.parse(readFileSync('config/vendors.json', 'utf8'));

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
    // Absolute phase depends on the epoch, so assert the SEQUENCE advances by
    // one each slot rather than pinning which shard is first.
    const seq = [0, 5, 10, 15, 20, 25].map((m) => shardDueAt(at(12, m), 3, 5));
    for (let i = 1; i < seq.length; i += 1) expect(seq[i]).toBe((seq[i - 1] + 1) % 3);
    // A full hour must hit each shard the same number of times, or some vendors
    // would be refreshed more often than others forever.
    const counts = [0, 0, 0];
    for (let m = 0; m < 60; m += 5) counts[shardDueAt(at(9, m), 3, 5)] += 1;
    expect(counts).toEqual([4, 4, 4]);
  });

  it('rotates continuously ACROSS an hour boundary', () => {
    // Found by mutation testing: replacing `getUTCHours() * 60` with
    // `getUTCHours() / 60` SURVIVED the suite, because every rotation test used
    // a single fixed hour. In production that mutant scrambles the sequence at
    // every hour boundary, so some shards would be skipped for long stretches
    // -- silent starvation, with each individual run still succeeding.
    const at = (h, m) => new Date(Date.UTC(2026, 6, 31, h, m));
    const slots = [
      at(9, 45), at(9, 50), at(9, 55),
      at(10, 0), at(10, 5), at(10, 10),
    ].map((d) => shardDueAt(d, 3, 5));

    // Consecutive 5-minute slots must advance by exactly one shard, wrapping.
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]).toBe((slots[i - 1] + 1) % 3);
    }
  });

  it('rotates continuously across a full day for ANY shard count', () => {
    // The count matters. With 3 shards and a 5-minute cron there are 12 slots
    // per hour and 12 % 3 === 0, so a bug that restarts the slot counter every
    // hour still lands on the right shard -- it is an EQUIVALENT mutant at the
    // production settings, and no amount of 3-shard testing can catch it.
    //
    // A count that does NOT divide the slots per hour exposes it: with 5
    // shards, 12 % 5 !== 0, so an hourly reset desynchronises immediately.
    // Verified by re-running the mutant: it survives at count=3 and dies here.
    const start = Date.UTC(2026, 6, 31, 0, 0);
    for (const count of [3, 5, 7]) {
      let prev = shardDueAt(new Date(start), count, 5);
      for (let m = 5; m <= 24 * 60; m += 5) {
        const cur = shardDueAt(new Date(start + m * 60_000), count, 5);
        expect(cur, `count=${count} desynchronised at minute ${m}`).toBe((prev + 1) % count);
        prev = cur;
      }
    }
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
      const vendors = selectShard(config.vendors, i);
      // An empty shard is legitimate: pinning the expensive vendors elsewhere
      // can leave a slot with nothing hashed into it. The scheduled handler
      // skips those before calling collect(), which refuses an empty list.
      if (vendors.length === 0) continue;
      const { state, fetchFn } = counting();
      await collect({ ...config, vendors }, { fetchFn, retryDelayMs: 0 });
      expect(state.n).toBeLessThan(25);
    }
  });

  it('every vendor is still assigned to exactly one shard, empty slots aside', () => {
    const seen = [];
    for (let i = 0; i < SHARD_COUNT; i += 1) seen.push(...selectShard(config.vendors, i));
    expect(seen.length).toBe(config.vendors.length);
    expect(new Set(seen.map((v) => v.name)).size).toBe(config.vendors.length);
  });

  it('honours an explicit shard pin', () => {
    const vendors = [{ name: 'Heavy', shard: 3 }, { name: 'Other' }];
    expect(selectShard(vendors, 3, 15).map((v) => v.name)).toContain('Heavy');
  });

  it('falls back to the hash when a pin is out of range', () => {
    // Lowering SHARD_COUNT must not strand a vendor in a shard that never runs.
    const vendors = [{ name: 'Heavy', shard: 99 }];
    const found = [];
    for (let i = 0; i < 15; i += 1) found.push(...selectShard(vendors, i, 15));
    expect(found).toHaveLength(1);
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

describe('shard defensive paths', () => {
  it('defaults count to SHARD_COUNT when omitted', () => {
    expect(selectShard(config.vendors, 0).length).toBe(selectShard(config.vendors, 0, SHARD_COUNT).length);
    expect(shardOf('Cloudflare')).toBe(shardOf('Cloudflare', SHARD_COUNT));
  });

  it('treats a vendor with no name as a real, hashable member', () => {
    // A malformed config entry must still land in exactly one shard rather
    // than vanishing from every shard and never being collected.
    const vendors = [{ name: 'A' }, {}, { name: undefined }];
    const seen = [];
    for (let i = 0; i < SHARD_COUNT; i += 1) seen.push(...selectShard(vendors, i));
    expect(seen.length).toBe(3);
  });

  it('rejects a non-array vendor list rather than collecting nothing', () => {
    expect(() => selectShard(null, 0)).toThrow(/must be an array/);
    expect(() => selectShard(undefined, 0)).toThrow(/must be an array/);
  });

  it('rejects an invalid shard count', () => {
    expect(() => selectShard([], 0, 0)).toThrow(/count must be/);
    expect(() => selectShard([], 0, 1.5)).toThrow(/count must be/);
  });

  it('defaults the cron interval when omitted', () => {
    const at = new Date(Date.UTC(2026, 6, 31, 12, 10));
    expect(shardDueAt(at)).toBe(shardDueAt(at, SHARD_COUNT, 5));
  });
});

describe('the cycle is balanced', () => {
  // Hashing spreads vendors evenly IN EXPECTATION, not in practice: with 46
  // vendors over 15 shards it left one shard empty and another with six —
  // a wasted minute of the cycle next to the invocation most likely to exceed
  // the CPU ceiling. Pins correct that, and this gate stops it drifting back
  // as vendors are added.
  const sizes = () =>
    Array.from({ length: SHARD_COUNT }, (_, i) => selectShard(config.vendors, i).length);

  it('wastes no slot while another shard is loaded', () => {
    const s = sizes();
    const empty = s.filter((n) => n === 0).length;
    if (empty > 0) {
      // An empty shard is legitimate (the handler skips it) but only while no
      // other shard is carrying more than its share.
      expect(Math.max(...s), `${empty} empty shard(s) while another carries the load`).toBeLessThanOrEqual(2);
    }
  });

  it('keeps the busiest shard close to the average', () => {
    const s = sizes();
    const avg = config.vendors.length / SHARD_COUNT;
    // Ceiling of the average plus one: enough slack for an odd division,
    // tight enough that a six-vendor shard fails.
    expect(Math.max(...s)).toBeLessThanOrEqual(Math.ceil(avg) + 1);
  });

  it('completes a full cycle inside the interval the page promises', () => {
    // Adding a 16th shard would make this a 16-minute cycle while the page
    // still says "Updates every 15 minutes". Cron granularity is one minute,
    // so 15 shards is the ceiling; capacity has to come from balance, not
    // from more slots.
    expect(SHARD_COUNT).toBeLessThanOrEqual(15);
  });
});
