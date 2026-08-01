import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { SEVERITY, worst, rank } from '../../src/engine/severity.js';
import { hashName, shardOf, selectShard, shardDueAt, SHARD_COUNT } from '../../src/engine/shard.js';
import { esc, safeUrl } from '../../src/worker/render.js';

// Property-based tests (testing.md §6).
//
// Example-based tests check the cases I thought of. Every input here is
// third-party: vendor status pages I do not control, and vendor names from a
// config that changes. These assert INVARIANTS under generated input rather
// than exact values -- "never crashes, never returns a half-parsed object,
// output stays within bounds".
//
// Seeded for reproducibility (§7). When a counterexample is found, promote the
// minimized case into a permanent example-based regression test rather than
// leaving it to the generator to rediscover.
const RUN = { seed: 20260731, numRuns: 500 };

describe('severity ordering', () => {
  const anySeverity = fc.constantFrom(...Object.values(SEVERITY));

  it('worst() is commutative, associative and idempotent', () => {
    fc.assert(
      fc.property(anySeverity, anySeverity, anySeverity, (a, b, c) => {
        expect(worst([a, b])).toBe(worst([b, a]));
        expect(worst([worst([a, b]), c])).toBe(worst([a, worst([b, c])]));
        expect(worst([a, a])).toBe(a);
      }),
      RUN,
    );
  });

  it('worst() always returns one of its inputs, never an invented value', () => {
    fc.assert(
      fc.property(fc.array(anySeverity, { minLength: 1 }), (list) => {
        expect(list).toContain(worst(list));
      }),
      RUN,
    );
  });

  it('never lets an unverified check outrank a healthy one', () => {
    // The governing rule of this codebase, as a property: mixing `unknown`
    // into any set can never produce `operational`. A regression here is a
    // silent false green across every vendor at once.
    fc.assert(
      fc.property(fc.array(anySeverity, { minLength: 1 }), (list) => {
        expect(worst([...list, SEVERITY.UNKNOWN])).not.toBe(SEVERITY.OPERATIONAL);
        expect(rank(worst([...list, SEVERITY.UNKNOWN]))).toBeGreaterThanOrEqual(
          rank(SEVERITY.UNKNOWN),
        );
      }),
      RUN,
    );
  });

  it('treats unrecognised vocabulary as unknown, never as healthy', () => {
    // A vendor inventing a new status string must not read green.
    fc.assert(
      fc.property(fc.string(), (junk) => {
        fc.pre(!Object.values(SEVERITY).includes(junk));
        expect(worst([junk])).not.toBe(SEVERITY.OPERATIONAL);
      }),
      RUN,
    );
  });
});

describe('sharding', () => {
  it('always returns a valid shard index for any vendor name', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 12 }), (name, count) => {
        const s = shardOf(name, count);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(count);
      }),
      RUN,
    );
  });

  it('hashes deterministically — the same name always lands in the same shard', () => {
    // If this ever fails, vendors migrate between shards on every run and the
    // refresh interval silently becomes unbounded.
    fc.assert(
      fc.property(fc.string(), (name) => {
        expect(hashName(name)).toBe(hashName(name));
        expect(hashName(name)).toBeGreaterThanOrEqual(0);
        expect(hashName(name)).toBeLessThanOrEqual(0xffffffff);
      }),
      RUN,
    );
  });

  it('partitions any vendor list — every vendor collected exactly once', () => {
    // The invariant that matters: no vendor is dropped (never refreshed, goes
    // stale forever) and none is duplicated across shards.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 1, max: 8 }),
        (names, count) => {
          const vendors = names.map((name) => ({ name }));
          const collected = [];
          for (let i = 0; i < count; i += 1) collected.push(...selectShard(vendors, i, count));
          expect(collected.map((v) => v.name).sort()).toEqual([...names].sort());
        },
      ),
      RUN,
    );
  });

  it('every shard is due at some point in any 24 hours', () => {
    // A shard that is never due is a set of vendors that is never checked --
    // the silent-starvation failure, in a form a config edit could reintroduce.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (count) => {
        const every = 5;
        const seen = new Set();
        for (let m = 0; m < 24 * 60; m += every) {
          seen.add(shardDueAt(new Date(Date.UTC(2026, 6, 31, 0, m)), count, every));
        }
        expect(seen.size).toBe(count);
      }),
      RUN,
    );
  });
});

describe('render escaping', () => {
  // Every string here originates on a third-party status page (M4). These are
  // the functions standing between that content and a public site.
  it('never emits a raw HTML-significant character', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = esc(s);
        expect(out).not.toMatch(/[<>&"']/.source ? /<|>|"|'/ : /$^/);
        expect(out).not.toContain('<');
        expect(out).not.toContain('>');
      }),
      RUN,
    );
  });

  it('escaping is idempotent in effect — no double-unescaping reopens an injection', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(esc(esc(s))).not.toContain('<script');
      }),
      RUN,
    );
  });

  it('safeUrl admits only http(s), never a script-bearing scheme', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = safeUrl(s);
        if (out) expect(out).toMatch(/^https?:\/\//i);
      }),
      RUN,
    );
  });

  it('rejects javascript: and data: however they are cased or padded', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('javascript:', 'JavaScript:', 'data:', 'DATA:', 'vbscript:'),
        fc.string(),
        fc.stringMatching(/^[ \t\n\r]*$/),
        (scheme, rest, pad) => {
          expect(safeUrl(`${pad}${scheme}${rest}`)).toBeFalsy();
        },
      ),
      RUN,
    );
  });
});

describe('config as a hostile input', () => {
  const config = JSON.parse(readFileSync('config/vendors.json', 'utf8'));

  it('every configured vendor lands in a real shard', () => {
    for (const v of config.vendors) {
      const s = shardOf(v.name, SHARD_COUNT);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(SHARD_COUNT);
    }
  });

  it('vendor names are unique — a duplicate would be silently overwritten in the snapshot', () => {
    // snapshot is keyed by vendor; two rows with one name means one vendor is
    // invisible and its outage never shows.
    const names = config.vendors.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
