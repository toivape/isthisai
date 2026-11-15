import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { openAiErrorMessage } from "../src/shared/openaiErrors";
import type { OpenAiErrorCode } from "../src/shared/types";

const CODES: OpenAiErrorCode[] = [
  "no_key",
  "invalid_key",
  "cancelled",
  "check_expired",
  "hash_mismatch",
  "unsupported_type",
  "fetch_failed",
  "timeout",
  "http_400",
  "http_401",
  "http_404",
  "http_4xx",
  "http_5xx",
  "rate_limited",
  "network",
  "bad_response",
];

function localeKeys(locale: string): Set<string> {
  return new Set(Object.keys(JSON.parse(readFileSync(`_locales/${locale}/messages.json`, "utf8")) as Record<string, unknown>));
}

describe("openAiErrorMessage", () => {
  test("every error code maps to a message key that both locales define", () => {
    // A key that exists in neither locale would render as an empty string in the
    // UI, which is worse than a vague message.
    const en = localeKeys("en");
    const fi = localeKeys("fi");
    for (const code of CODES) {
      const { key } = openAiErrorMessage({ code });
      expect(key, code).not.toBe("");
      expect(en.has(key), `${code} -> ${key} missing from en`).toBe(true);
      expect(fi.has(key), `${code} -> ${key} missing from fi`).toBe(true);
    }
  });

  test("a rate limit without a countdown gives the plain message", () => {
    expect(openAiErrorMessage({ code: "rate_limited" })).toEqual({ key: "error_openai_rate_limited" });
    // A countdown of zero would read as "try again in 0 s", which is worse than
    // saying nothing about the time.
    expect(openAiErrorMessage({ code: "rate_limited", retryAfterSec: 0 })).toEqual({ key: "error_openai_rate_limited" });
  });

  test("a rate limit with a countdown reports the seconds", () => {
    expect(openAiErrorMessage({ code: "rate_limited", retryAfterSec: 42 })).toEqual({
      key: "error_openai_rate_limited_after",
      substitutions: ["42"],
    });
  });

  test("other codes carry no substitutions", () => {
    for (const code of CODES) {
      if (code === "rate_limited") continue;
      expect(openAiErrorMessage({ code }).substitutions, code).toBeUndefined();
    }
  });
});
