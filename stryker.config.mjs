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
  // Baseline measured 2026-11-11: 73.44% total / 77.7% covered. The surviving
  // mutants are concentrated in c2pa.ts, xmp.ts and fetchImage.ts edge branches
  // and are future test work; keep break a little under the baseline so a real
  // regression fails the run without flapping.
  thresholds: { high: 85, low: 70, break: 70 },
  timeoutMS: 30000,
};
