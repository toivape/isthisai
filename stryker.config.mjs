/**
 * Mutation testing (issue #30). Vitest runs the unit tests; the TypeScript
 * checker drops mutants that no longer compile (for example a "block -> {}"
 * removal of a mandatory return) instead of misreporting them as killed.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner", "@stryker-mutator/typescript-checker"],
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  vitest: { configFile: "vite.config.ts" },
  reporters: ["clear-text", "progress", "html"],
  coverageAnalysis: "perTest",
  // Keep throwaway/local-only trees out of the sandbox copy.
  ignorePatterns: [".scratch/**", "dist/**", "reports/**"],
  // Only unit-tested pure logic is mutated. The exclusions are surfaces that
  // CLAUDE.md and PLAN.md §8 cover by manual testing in Brave instead of unit
  // tests: the chrome wiring in background/index.ts, the DOM shell in
  // content/index.ts, the blob reader (no unit test), the options/confirm
  // pages, and the i18n wrapper and size-limit constants.
  mutate: [
    "src/**/*.ts",
    "!src/background/index.ts",
    "!src/content/index.ts",
    "!src/content/readBlob.ts",
    "!src/confirm/**",
    "!src/options/**",
    "!src/shared/i18n.ts",
    "!src/shared/limits.ts",
  ],
  // The gate: exit non-zero under 90%. Baseline measured 2026-11-11: 95.54%
  // total / 96.5% covered; the remaining survivors are equivalent mutants (see
  // the test files' comments).
  thresholds: { high: 90, low: 85, break: 90 },
  timeoutMS: 30000,
};
