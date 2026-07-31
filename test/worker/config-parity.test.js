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

  it('CRON_EVERY_MINUTES matches the deployed cron interval', () => {
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(crons[0]);
    expect(m, `cron "${crons[0]}" is not a simple */N minute schedule`).toBeTruthy();
    const deployed = Number(m[1]);

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
    const every = Number(/^\*\/(\d+)/.exec(crons[0])[1]);
    expect(every * SHARD_COUNT).toBeLessThanOrEqual(15);
  });
});

describe('free-plan ceilings are respected', () => {
  it('does not declare a limits block', () => {
    // `limits` is paid-plan only; deploying it fails outright with code 100328.
    expect(wrangler.limits).toBeUndefined();
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
