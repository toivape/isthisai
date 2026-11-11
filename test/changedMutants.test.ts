import { describe, expect, test, vi } from "vitest";
import {
  globToRegExp,
  importSpecifiers,
  isMutable,
  resolveImport,
  selectMutants,
} from "../scripts/changed-mutants.mjs";

describe("globToRegExp", () => {
  test("matches a single segment with *", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/nested/a.ts")).toBe(false);
  });

  test("**/ matches zero or more directories", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/background/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
  });

  test("a bare ** matches across separators", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
  });

  test("is anchored and escapes regex metacharacters", () => {
    expect(globToRegExp("src/*.ts").test("xsrc/a.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a.tsx")).toBe(false);
    expect(globToRegExp("a.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("a.ts").test("axts")).toBe(false);
  });

  test("? matches exactly one non-slash character", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a/.ts")).toBe(false);
  });
});

describe("isMutable", () => {
  test("accepts production files under src and rejects everything else", () => {
    expect(isMutable("src/background/xmp.ts")).toBe(true);
    expect(isMutable("src/shared/types.ts")).toBe(true);
    expect(isMutable("src/content/badge.ts")).toBe(true);
    expect(isMutable("test/xmp.test.ts")).toBe(false);
    expect(isMutable("scripts/changed-mutants.mjs")).toBe(false);
    expect(isMutable("README.md")).toBe(false);
  });

  test("honours the exclusions in stryker.config.mjs", () => {
    expect(isMutable("src/background/index.ts")).toBe(false);
    expect(isMutable("src/content/index.ts")).toBe(false);
    expect(isMutable("src/content/readBlob.ts")).toBe(false);
    expect(isMutable("src/confirm/confirm.ts")).toBe(false);
    expect(isMutable("src/options/options.ts")).toBe(false);
    expect(isMutable("src/shared/i18n.ts")).toBe(false);
    expect(isMutable("src/shared/limits.ts")).toBe(false);
  });
});

describe("importSpecifiers", () => {
  test("collects static, side-effect and dynamic imports", () => {
    const source = [
      'import a from "./a";',
      "import { b } from '../b';",
      'import "./side-effect";',
      'const c = await import("./c");',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["./a", "../b", "./side-effect", "./c"]);
  });

  test("reads the specifier of a multi-line import from its closing line", () => {
    const source = ["import {", "  a,", "  b,", '} from "../src/background/xmp";'].join("\n");
    expect(importSpecifiers(source)).toEqual(["../src/background/xmp"]);
  });

  test("skips type-only imports so shared type modules are not dragged in", () => {
    const source = [
      'import type { CheckResult } from "../src/shared/types";',
      'import { type Other } from "../src/shared/other";',
      'import { scanXmp } from "../src/background/xmp";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["../src/shared/other", "../src/background/xmp"]);
  });

  test("ignores import-looking text inside string literals used as test data", () => {
    // A test that asserts on import strings must not be read as importing them.
    const source = [
      'import { describe } from "vitest";',
      "const readFile = () => 'import { scanXmp } from \"../src/background/xmp\";';",
      "expect(selectMutants([\"test/x.test.ts\"], () => 'import { b } from \"../b\";')).toEqual([]);",
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["vitest"]);
  });
});

describe("resolveImport", () => {
  const exists = (paths: string[]): ((p: string) => boolean) => (p: string) => paths.includes(p);

  test("resolves a relative specifier to a .ts file", () => {
    expect(resolveImport("test/xmp.test.ts", "../src/background/xmp", exists(["src/background/xmp.ts"]))).toBe(
      "src/background/xmp.ts",
    );
  });

  test("resolves an extension-less index", () => {
    expect(resolveImport("test/a.test.ts", "../src/background", exists(["src/background/index.ts"]))).toBe(
      "src/background/index.ts",
    );
  });

  test("returns undefined for a bare package specifier or a missing file", () => {
    expect(resolveImport("test/a.test.ts", "vitest", () => true)).toBeUndefined();
    expect(resolveImport("test/a.test.ts", "../src/nope", () => false)).toBeUndefined();
  });
});

describe("selectMutants", () => {
  test("includes changed mutable sources and skips test and non-source files", () => {
    const selected = selectMutants(["src/background/xmp.ts", "README.md", "scripts/dev.mjs"]);
    expect(selected).toEqual(["src/background/xmp.ts"]);
  });

  test("a changed test file pulls in the source it imports", () => {
    const readFile = vi.fn(() => 'import { scanXmp } from "../src/background/xmp";');
    const fileExists = (p: string) => p === "src/background/xmp.ts";
    expect(selectMutants(["test/xmp.test.ts"], readFile, fileExists)).toEqual(["src/background/xmp.ts"]);
  });

  test("a changed test importing an excluded source contributes nothing", () => {
    const readFile = () => 'import { readBlobInPage } from "../src/content/readBlob";';
    const fileExists = (p: string) => p === "src/content/readBlob.ts";
    expect(selectMutants(["test/blob.test.ts"], readFile, fileExists)).toEqual([]);
  });

  test("deduplicates a file that is both changed and imported by a changed test", () => {
    const readFile = () => 'import { scanXmp } from "../src/background/xmp";';
    const fileExists = (p: string) => p === "src/background/xmp.ts";
    expect(selectMutants(["src/background/xmp.ts", "test/xmp.test.ts"], readFile, fileExists)).toEqual([
      "src/background/xmp.ts",
    ]);
  });

  test("returns a sorted, empty list when nothing relevant changed", () => {
    expect(selectMutants(["README.md", "package.json"])).toEqual([]);
  });
});
