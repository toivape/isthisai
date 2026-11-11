// Selects the production files to mutate for a pull-request mutation run.
//
// Stryker 10.x has no `--since` option (verified with `stryker run --help`), so
// the changed-file set is computed with git and passed to `--mutate` by
// scripts/mutation-changed.mjs. The set is the changed files under the mutate
// scope (stryker.config.mjs), plus the source files that changed test files
// import — so a PR that only touches tests still checks the code those tests
// cover.
//
// The pure parts (glob matching, import extraction, selection) are exported and
// unit-tested in test/changedMutants.test.ts; the git call is the only I/O.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import base from "../stryker.config.mjs";

const toPosix = (path) => path.split(sep).join("/");

/** Translates a Stryker mutate glob (`**`, `*`, `?`) into an anchored RegExp. */
export function globToRegExp(pattern) {
  let out = "^";
  for (let at = 0; at < pattern.length; at++) {
    const ch = pattern[at];
    if (ch === "*") {
      if (pattern[at + 1] === "*") {
        // "**/" may match nothing (zero directories); a bare "**" matches across "/".
        if (pattern[at + 2] === "/") {
          out += "(?:.*/)?";
          at += 2;
        } else {
          out += ".*";
          at += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

/** True when a repo-relative path is inside the mutate scope (negations win). */
export function isMutable(path, patterns = base.mutate) {
  const positives = patterns.filter((p) => !p.startsWith("!"));
  const negatives = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  if (negatives.some((p) => globToRegExp(p).test(path))) return false;
  return positives.some((p) => globToRegExp(p).test(path));
}

/** Every module specifier a source file imports.
 *
 * Only import statements are matched, never import-looking text inside a string
 * literal (a test may contain `'import x from "./a"'` as data). A real import
 * statement starts a line — or is the `} from "..."` tail of a multi-line one —
 * which is what the anchoring below relies on. Skips `import type` (no runtime
 * behaviour; following it would drag src/shared/types.ts into every run). */
export function importSpecifiers(source) {
  const specifiers = new Set();
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trimStart();
    if (/^import\s+type\b/.test(trimmed)) continue;
    // A statement start: `import ...` or a `} from "..."` closing a multi-line import.
    const isImportStart = /^import\b/.test(trimmed) || (trimmed.startsWith("}") && trimmed.includes(" from "));
    const isDynamicImport = /^(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?import\(/.test(trimmed);
    if (!isImportStart && !isDynamicImport) continue;
    const specifier = findSpecifier(trimmed, lines, index);
    if (specifier !== undefined) specifiers.add(specifier);
  }
  return [...specifiers];
}

// The module specifier of one import statement, whether it fits on the line or
// continues onto following lines (`import {\n x\n} from "m"`).
function findSpecifier(firstLine, lines, index) {
  let text = firstLine;
  let scan = index;
  while (!text.includes("from ") && !/["']/.test(text.replace(/^import\s*\(?\s*/, "")) && scan + 1 < lines.length) {
    scan++;
    text += " " + lines[scan].trim();
  }
  const quoted = text.match(/["']([^"']+)["']/g);
  if (!quoted || quoted.length === 0) return undefined;
  const last = quoted[quoted.length - 1];
  return last.slice(1, -1);
}

/**
 * Resolves a relative import to a repo-relative .ts/.tsx path, or undefined for
 * a bare package specifier or a path that does not exist.
 */
export function resolveImport(importer, specifier, fileExists = (p) => existsSync(p)) {
  if (!specifier.startsWith(".")) return undefined;
  const target = toPosix(normalize(join(dirname(importer), specifier)));
  const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`];
  return candidates.find((candidate) => fileExists(candidate));
}

const isTestFile = (path) => path.startsWith("test/") && path.endsWith(".test.ts");

/**
 * The union of changed mutable files and the mutable files imported by changed
 * test files. Sorted for a stable command line.
 */
export function selectMutants(changedFiles, readFile = (p) => readFileSync(p, "utf8"), fileExists) {
  const selected = new Set();
  for (const file of changedFiles) {
    if (isMutable(file)) {
      selected.add(file);
      continue;
    }
    if (isTestFile(file)) {
      let source;
      try {
        source = readFile(file);
      } catch {
        continue; // a changed test file that cannot be read contributes nothing
      }
      for (const specifier of importSpecifiers(source)) {
        const resolved = resolveImport(file, specifier, fileExists);
        if (resolved && isMutable(resolved)) selected.add(resolved);
      }
    }
  }
  return [...selected].sort();
}

function changedFiles(baseRef) {
  const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`], {
    encoding: "utf8",
  });
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export { changedFiles };
