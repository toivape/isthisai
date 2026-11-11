// Type declarations for scripts/changed-mutants.mjs. The script stays .mjs
// (like scripts/dev.mjs, outside tsconfig); this declaration lets the TypeScript
// test that covers its pure functions resolve types for it.

/** Translates a Stryker mutate glob (**, *, ?) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp;

/** True when a repo-relative path is inside the mutate scope (negations win). */
export function isMutable(path: string, patterns?: readonly string[]): boolean;

/** Every runtime module specifier a source file imports (type-only skipped). */
export function importSpecifiers(source: string): string[];

/** Resolves a relative import to a repo-relative path, or undefined. */
export function resolveImport(
  importer: string,
  specifier: string,
  fileExists?: (path: string) => boolean,
): string | undefined;

/** Changed mutable files plus the mutable sources changed test files import. */
export function selectMutants(
  changedFiles: string[],
  readFile?: (path: string) => string,
  fileExists?: (path: string) => boolean,
): string[];

/** Repo-relative paths changed in `git diff <baseRef>...HEAD` (added/copied/modified/renamed). */
export function changedFiles(baseRef: string): string[];
