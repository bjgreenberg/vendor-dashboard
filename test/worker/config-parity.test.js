import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SHARD_COUNT } from '../../src/engine/shard.js';

// Preconditions asserted, not printed (testing.md §3c).
//
// Several facts in this repo are load-bearing but live in two files that
// nothing forces to agree. Each had a COMMENT saying "these must match" -- and
// a printed precondition is documentation, an asserted one is a gate. A comment
// cannot fail CI; every check below can.
//
// The motivating case: shard rotation is derived from the clock using
// CRON_EVERY_MINUTES. If wrangler.jsonc's cron interval changes and that
// constant does not, some shards are NEVER due and their vendors are never
// checked again -- silently, because each individual run still succeeds.

/** wrangler.jsonc is JSONC; strip comments before parsing. */
function readWrangler() {
  const raw = readFileSync('wrangler.jsonc', 'utf8');
  const stripped = raw
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(stripped);
}

const wrangler = readWrangler();
const indexSrc = readFileSync('src/worker/index.js', 'utf8');

describe('cron and shard rotation agree', () => {
  const crons = wrangler.triggers?.crons ?? [];

  it('declares exactly one cron trigger', () => {
    // Two schedules would fire two shards per slot and skew the rotation.
    expect(crons).toHaveLength(1);
  });

  /**
   * Minute interval of a cron expression.
   *
   * Handles BOTH forms: `*` means every minute, `*\/N` means every N. The gate
   * originally understood only `*\/N`, and correctly failed when the schedule
   * moved to `* * * * *` — the mismatch it exists to catch, arriving as a
   * syntax it could not read rather than a wrong number.
   *
   * @param {string} cron
   * @returns {number|null}
   */
  const minuteInterval = (cron) => {
    const field = String(cron).trim().split(/\s+/)[0];
    if (field === '*') return 1;
    const m = /^\*\/(\d+)$/.exec(field);
    return m ? Number(m[1]) : null;
  };

  it('CRON_EVERY_MINUTES matches the deployed cron interval', () => {
    const deployed = minuteInterval(crons[0]);
    expect(deployed, `cron "${crons[0]}" has no readable minute interval`).toBeTruthy();

    const declared = Number(/const CRON_EVERY_MINUTES = (\d+)/.exec(indexSrc)?.[1]);
    expect(declared, 'CRON_EVERY_MINUTES not found in src/worker/index.js').toBeTypeOf('number');

    expect(
      declared,
      `wrangler.jsonc fires every ${deployed}m but CRON_EVERY_MINUTES is ${declared}. ` +
        `Shard rotation is derived from the clock, so a mismatch starves some shards forever.`,
    ).toBe(deployed);
  });

  it('a full cycle refreshes every vendor within 15 minutes', () => {
    // The interval the page promises the reader in prose. If sharding is made
    // coarser without changing the copy, the page starts lying.
    expect(minuteInterval(crons[0]) * SHARD_COUNT).toBeLessThanOrEqual(15);
  });
});

describe('plan assumptions are declared, not implied', () => {
  it('declares the paid-plan CPU limit as a plan-lapse tripwire', () => {
    // INVERTED 2026-08-02 with the move to Workers Paid. This test used to
    // assert NO limits block (free plan rejects it, code 100328). Now the
    // block is deliberate and load-bearing: if the paid subscription ever
    // lapses, the next deploy fails loudly on this very setting instead of
    // production silently reverting to 10 ms kills mid-cron — the 2026-08-01
    // failure mode. Removing `limits` again must be a conscious decision.
    expect(wrangler.limits).toEqual({ cpu_ms: 30000 });
  });

  it('never declares custom_domain on a route', () => {
    // Wrangler force-overrides DNS with no changeset preview when stdout is not
    // a TTY -- on the zone the live site depends on.
    for (const route of wrangler.routes ?? []) {
      expect(route.custom_domain).toBeUndefined();
      expect(route.zone_name).toBeTruthy();
    }
  });

  it('keeps observability on', () => {
    // The one thing that turns the next silent failure into a query.
    expect(wrangler.observability?.enabled).toBe(true);
  });
});

describe('the vendor config is wired to the deployed asset paths', () => {
  it('BASE_PATH matches the route pattern', () => {
    const basePath = wrangler.vars?.BASE_PATH;
    expect(basePath).toBeTruthy();
    const pattern = (wrangler.routes ?? [])[0]?.pattern ?? '';
    expect(pattern).toContain(basePath);
  });

  it('serves assets from the directory that mirrors the route prefix', () => {
    // Workers static assets map URL path to file path directly, so a mismatch
    // here 404s every logo without any error being raised.
    expect(wrangler.assets?.directory).toBe('./public');
  });
});

describe('the page promises what the schedule actually delivers', () => {
  // The copy said "Updates every 15 minutes" while meta.checked_at is the LAST
  // RUN, which now happens every minute and covers only ~3 services. Read
  // together those implied the whole board was read at that timestamp.
  //
  // Sharding means the honest claim is PER SERVICE, which is also the claim
  // the schedule can actually keep.
  const render = readFileSync('src/worker/render.js', 'utf8');
  const crons = wrangler.triggers?.crons ?? [];
  const interval = (() => {
    const f = String(crons[0]).trim().split(/\s+/)[0];
    return f === '*' ? 1 : Number(/^\*\/(\d+)$/.exec(f)?.[1]);
  })();

  it('states the refresh PER SERVICE, not for the page as a whole', () => {
    expect(render).toMatch(/Each service is re-checked every 15 minutes/);
    expect(render).not.toMatch(/Updates every 15 minutes/);
  });

  it('labels the timestamp as the last COLLECTION, not a whole-board check', () => {
    // One invocation checks a shard, not the board.
    expect(render).toMatch(/Last collection/);
    expect(render).not.toMatch(/Last checked <time/);
  });

  it('the promised 15 minutes is what the shard cycle delivers', () => {
    // shards x cron interval = the period between two checks of one service.
    // This is the arithmetic the copy depends on; it is not a style choice.
    expect(interval * SHARD_COUNT).toBe(15);
  });
});
