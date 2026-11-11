// Runs mutation testing scoped to the files a pull request changed.
//
// Stryker 10.x has no `--since` option, so the changed-file set is computed here
// (scripts/changed-mutants.mjs) and passed to `--mutate`. The config is the
// report-only PR config (stryker.pr.config.mjs): the run never fails a PR on the
// score, it only reports.
//
// Usage: node scripts/mutation-changed.mjs [--base <ref>]
//   0  the run finished (or there was nothing to mutate)
//   non-zero  Stryker could not run at all
import { spawnSync } from "node:child_process";
import { selectMutants, changedFiles } from "./changed-mutants.mjs";

const baseIndex = process.argv.indexOf("--base");
const baseRef = baseIndex === -1 ? process.env.MUTATION_BASE_REF ?? "origin/main" : process.argv[baseIndex + 1];

let files;
try {
  files = selectMutants(changedFiles(baseRef));
} catch {
  console.error(`Cannot diff against "${baseRef}"; is it fetched? (git fetch origin <base>)`);
  process.exit(1);
}
if (files.length === 0) {
  console.log(`No mutable files changed versus ${baseRef}; skipping mutation run.`);
  process.exit(0);
}
console.log(`Mutating ${files.length} file(s) versus ${baseRef}: ${files.join(", ")}`);
const result = spawnSync(
  "npx",
  ["stryker", "run", "--mutate", files.join(","), "stryker.pr.config.mjs"],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
