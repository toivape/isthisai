/**
 * Config for the pull-request mutation run (see .github/workflows/ci.yml).
 *
 * It inherits stryker.config.mjs and only changes what a PR needs:
 * - report-only: break is null, so a PR never fails on the score. The scoped
 *   subset can include files still below the gate; this check is feedback, not
 *   a merge blocker.
 * - the mutate scope is narrowed on the command line by
 *   scripts/changed-mutants.mjs (Stryker 10.x has no --since), which passes
 *   --mutate <comma-separated files>.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
import base from "./stryker.config.mjs";

export default {
  ...base,
  thresholds: { ...base.thresholds, break: null },
  // No HTML report in CI; the JSON report is the artifact and is small.
  reporters: ["clear-text", "json"],
};
