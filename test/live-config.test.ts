import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import base from "../vite.config";
import live from "../vitest.live.config";
import { FETCH_DEADLINE_MS } from "../src/shared/limits";

// The live suite must be reachable only through `npm run test:live`.

describe("test:live is isolated from npm test", () => {
  test("the live config collects only test/live", () => {
    expect(live.test?.include).toEqual(["test/live/*.live.ts"]);
  });

  test("the unit config collects only *.test.ts and excludes test/live", () => {
    expect(base.test?.include).toEqual(["test/**/*.test.ts"]);
    expect(base.test?.exclude).toContain("test/live/**");
  });

  test("the unit include pattern cannot reach a live file", () => {
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
    expect(live.test?.testTimeout).toBeGreaterThan(FETCH_DEADLINE_MS);
  });
});
