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
import ts from "typescript";
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

/** Every runtime module specifier a source file imports.
 *
 * Parsed with the TypeScript compiler (already a devDependency) rather than a
 * regex: a regex cannot tell a real import from import-looking text in a string
 * literal (test fixtures contain those) and misses destructured dynamic imports
 * (`const { x } = await import("...")`). Type-only imports and `typeof
 * import(...)` are skipped: they carry no runtime behaviour, and following them
 * would drag shared type modules into every run. */
export function importSpecifiers(source) {
  const file = ts.createSourceFile("imports.ts", source, ts.ScriptTarget.Latest);
  const specifiers = new Set();
  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]); // dynamic import, any binding form
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...specifiers];
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
