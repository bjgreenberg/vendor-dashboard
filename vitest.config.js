import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],

    // Determinism (testing.md §7): a fixed seed so file ordering is
    // reproducible and an order-dependent test fails every run, not one in ten.
    sequence: { seed: 20260731 },

    coverage: {
      provider: 'v8',
      // The WHOLE deployable surface. index.js was excluded until audit
      // finding M4 — the scheduled() handler and its self-monitoring alerts
      // had no coverage gate at all.
      include: ['src/engine/**', 'src/worker/**'],
      reporter: ['text', 'lcov'],

      // BRANCH coverage, and the gate FAILS the build (testing.md §3a). Line
      // coverage hides untaken `if`/`catch` paths, which in this codebase is
      // exactly where "fail closed to unknown" lives -- an untested catch
      // block is how a vendor silently reads green.
      //
      // perFile: EVERY file must clear the floor individually. The previous
      // config said "tiered per-file" but only three named files were; the
      // rest was one blended 80%, and concur-status.js sat at 16.66% branch
      // inside a passing gate (audit finding M4). A blended number lets a
      // well-tested adapter mask an untested one — the exact failure the
      // comment claimed to prevent.
      //
      // Floor 75, ratchet upward: raise it when the laggards improve; never
      // lower it to admit new code.
      thresholds: {
        perFile: true,
        branches: 75,
        functions: 75,
        lines: 75,
        statements: 75,
        'src/engine/severity.js': { branches: 90, functions: 90, lines: 90, statements: 90 },
        'src/engine/shard.js': { branches: 90, functions: 90, lines: 90, statements: 90 },
        'src/worker/storage.js': { branches: 90, functions: 90, lines: 90, statements: 90 },
      },
    },
  },
});
