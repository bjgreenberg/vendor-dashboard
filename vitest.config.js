import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],

    // Determinism (testing.md §7): a fixed seed so file ordering is
    // reproducible and an order-dependent test fails every run, not one in ten.
    sequence: { seed: 20260731 },

    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/worker/render.js', 'src/worker/storage.js'],
      reporter: ['text', 'lcov'],

      // BRANCH coverage, and the gate FAILS the build (testing.md §3a). Line
      // coverage hides untaken `if`/`catch` paths, which in this codebase is
      // exactly where "fail closed to unknown" lives -- an untested catch
      // block is how a vendor silently reads green.
      //
      // Tiered PER-FILE on the dangerous code rather than as one blended
      // number, so a thoroughly-tested adapter cannot mask an untested core.
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
        'src/engine/severity.js': { branches: 90, functions: 90, lines: 90, statements: 90 },
        'src/engine/shard.js': { branches: 90, functions: 90, lines: 90, statements: 90 },
        'src/worker/storage.js': { branches: 90, functions: 90, lines: 90, statements: 90 },
      },
    },
  },
});
