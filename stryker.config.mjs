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
  // Mutation runs are instrumented and several times slower, so they use a
  // config that only raises the vitest test timeout (see the file's comment).
  vitest: { configFile: "vitest.mutation.config.ts" },
  reporters: ["clear-text", "progress", "html"],
  coverageAnalysis: "perTest",
  // Keep throwaway/local-only trees out of the sandbox copy.
  ignorePatterns: [".scratch/**", "dist/**", "reports/**"],
  // Only unit-tested pure logic is mutated. The exclusions are surfaces that
  // CLAUDE.md and PLAN.md §8 cover by manual testing in Brave instead of unit
  // tests: the chrome wiring in background/index.ts, confirm/confirm.ts and
  // options/options.ts, the DOM shell in content/index.ts and its popup/toast
  // rendering in content/popup.ts, the blob reader (no unit test), and the i18n
  // wrapper and size-limit constants.
  //
  // Excluded by file, not by directory: confirm/view.ts and options/state.ts are
  // pure and unit-tested, so they stay in scope. A page's directory says nothing
  // about whether its logic is testable, and excluding a directory silently drops
  // whatever pure module later lands in it.
  mutate: [
    "src/**/*.ts",
    "!src/background/index.ts",
    "!src/content/index.ts",
    "!src/content/popup.ts",
    "!src/content/readBlob.ts",
    "!src/confirm/confirm.ts",
    "!src/options/options.ts",
    "!src/shared/i18n.ts",
    "!src/shared/limits.ts",
  ],
  // The gate: exit non-zero under 90%. Baseline measured 2026-11-11: 95.54%
  // total / 96.5% covered; the remaining survivors are equivalent mutants (see
  // the test files' comments).
  thresholds: { high: 90, low: 85, break: 90 },
  timeoutMS: 30000,
};
