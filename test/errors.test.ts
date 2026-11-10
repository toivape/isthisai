import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { errorMessageKey, resultWindowPath } from "../src/shared/errors";
import type { CheckErrorCode } from "../src/shared/types";

const CODES: CheckErrorCode[] = ["permission_denied", "fetch_failed", "timeout", "too_large", "unsupported_type"];

describe("errorMessageKey", () => {
  test.each(["en", "fi"])("every check error code has a non-empty %s message", (locale) => {
    const messages = JSON.parse(readFileSync(`_locales/${locale}/messages.json`, "utf8"));
    for (const code of CODES) {
      expect(messages[errorMessageKey(code)]?.message, code).toBeTruthy();
    }
  });

  test("keys follow the error_<code> convention", () => {
    expect(errorMessageKey("timeout")).toBe("error_timeout");
  });
});

describe("resultWindowPath", () => {
  test("carries the error code only when there is an error", () => {
    expect(resultWindowPath()).toBe("src/confirm/confirm.html?view=result");
    expect(resultWindowPath({ code: "permission_denied" })).toBe("src/confirm/confirm.html?view=result&error=permission_denied");
  });
});
