import { describe, expect, test } from "vitest";
import { getCheck, getResult, putCheck, putResult, type CacheStore } from "../src/background/cache";
import type { CheckRecord, CheckResult } from "../src/shared/types";

// A real SHA-256 hex digest, so the key test exercises the actual shape.
const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    imageHash: HASH,
    mediaType: "image/png",
    verdict: "no_signal",
    localC2pa: { manifest: "absent", aiAction: false },
    localXmp: { state: "not_detected" },
    openai: { state: "not_checked" },
    ...overrides,
  };
}

function record(overrides: Partial<CheckRecord> = {}): CheckRecord {
  return {
    checkId: "check-1",
    srcUrl: "https://page.example/i.png",
    frameUrl: "https://page.example/",
    tabId: 7,
    frameId: 0,
    imageHash: HASH,
    mediaType: "image/png",
    size: 1234,
    ...overrides,
  };
}

// Hand-written fake for the injected storage interface; records every set so
// tests can inspect the key and the exact value written.
function fakeStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const sets: { key: string; value: unknown }[] = [];
  const store: CacheStore = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value);
      sets.push({ key, value });
    },
  };
  return { store, data, sets };
}

// No image bytes may ever be cached (PLAN §4 "Cache").
function containsBinary(value: unknown): boolean {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (Array.isArray(value)) return value.some(containsBinary);
  if (typeof value === "object" && value !== null) return Object.values(value).some(containsBinary);
  return false;
}

describe("cache keys", () => {
  test("a result is stored under result: + the SHA-256 hex", async () => {
    const { store, sets } = fakeStore();
    await putResult(store, result());
    expect(sets).toHaveLength(1);
    expect(sets[0].key).toBe(`result:${HASH}`);
  });

  test("a check record is stored under check: + checkId", async () => {
    const { store, sets } = fakeStore();
    await putCheck(store, record({ checkId: "abc" }));
    expect(sets[0].key).toBe("check:abc");
  });
});

describe("results", () => {
  test("getResult returns what putResult stored", async () => {
    const { store } = fakeStore();
    const stored = result({ verdict: "ai_signal", localC2pa: { manifest: "present", aiAction: true } });
    await putResult(store, stored);
    expect(await getResult(store, HASH)).toEqual(stored);
  });

  test("getResult returns undefined for a key that was never stored", async () => {
    const { store } = fakeStore();
    expect(await getResult(store, HASH)).toBeUndefined();
  });

  test("a result with a local signal-level error is stored (deterministic, PLAN §4 Cache)", async () => {
    const { store } = fakeStore();
    const stored = result({ verdict: "incomplete", localC2pa: { manifest: "error", aiAction: false } });
    await putResult(store, stored);
    expect(await getResult(store, HASH)).toEqual(stored);
  });

  test("getResult ignores a stored value that is not a CheckResult", async () => {
    const { store } = fakeStore({ [`result:${HASH}`]: { code: "fetch_failed" } });
    expect(await getResult(store, HASH)).toBeUndefined();
  });
});

describe("check records", () => {
  test("getCheck returns what putCheck stored", async () => {
    const { store } = fakeStore();
    const stored = record();
    await putCheck(store, stored);
    expect(await getCheck(store, "check-1")).toEqual(stored);
  });

  test("getCheck returns undefined for an unknown checkId", async () => {
    const { store } = fakeStore();
    expect(await getCheck(store, "missing")).toBeUndefined();
  });

  test("getCheck ignores a stored value that is not a CheckRecord", async () => {
    const { store } = fakeStore({ "check:x": { checkId: "x" } });
    expect(await getCheck(store, "x")).toBeUndefined();
  });
});

describe("no bytes are cached", () => {
  test("the stored result contains no binary and survives JSON round-trip", async () => {
    const { store, sets } = fakeStore();
    await putResult(store, result());
    expect(containsBinary(sets[0].value)).toBe(false);
    expect(JSON.parse(JSON.stringify(sets[0].value))).toEqual(sets[0].value);
  });

  test("the stored check record contains no binary and survives JSON round-trip", async () => {
    const { store, sets } = fakeStore();
    await putCheck(store, record());
    expect(containsBinary(sets[0].value)).toBe(false);
    expect(JSON.parse(JSON.stringify(sets[0].value))).toEqual(sets[0].value);
  });
});
