import { defineConfig } from 'vitest/config';

// Structural test runner for the OS itself. Tests live under `tests/` and
// validate that the system stays internally consistent as it evolves —
// skills wire up, wikilinks resolve, archetype contracts hold, audit ↔
// code coverage doesn't drift, etc. See standard-testing.md for the full
// philosophy + tier split.

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Fail fast on missing fixtures / read errors so the failure points
    // directly at the broken invariant rather than a downstream stack trace.
    passWithNoTests: false,
    reporters: ['default'],
    // Most structural tests read the live vault and skills tree; they're
    // cheap individually but the cumulative count grows. Keep parallelism
    // sane so the output stays readable when a test fails.
    fileParallelism: true,
  },
});
