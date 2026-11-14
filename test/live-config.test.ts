import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import base from "../vite.config";
import live from "../vitest.live.config";
import { FETCH_DEADLINE_MS } from "../src/shared/limits";

// Issue #19: the live suite must be reachable only through `npm run test:live`.
// A live test silently joining `npm test` would either call the network in CI
// or fail there for want of a key, so the two configs are checked against each
// other rather than trusted.

describe("test:live is isolated from npm test", () => {
  test("the live config collects only test/live", () => {
    expect(live.test?.include).toEqual(["test/live/*.live.ts"]);
  });

  test("the unit config collects only *.test.ts and excludes test/live", () => {
    expect(base.test?.include).toEqual(["test/**/*.test.ts"]);
    expect(base.test?.exclude).toContain("test/live/**");
  });

  test("the unit include pattern cannot reach a live file", () => {
    // Belt and braces: `test/**/*.test.ts` demands the .test.ts suffix, so the
    // exclude above is not the only thing keeping live files out.
    for (const file of readdirSync("test/live")) {
      expect(file, file).not.toMatch(/\.test\.ts$/);
    }
  });

  test("the live directory has files, so the assertions above are not vacuous", () => {
    const files = readdirSync("test/live");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file, file).toMatch(/\.live\.ts$/);
  });

  test("the live test timeout leaves the client's deadline in charge", () => {
    // Otherwise a slow-but-valid response fails on vitest's 5 s default, and the
    // upload outlives the test that started it.
    expect(live.test?.testTimeout).toBeGreaterThan(FETCH_DEADLINE_MS);
  });
});
