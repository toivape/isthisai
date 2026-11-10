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

// No image bytes may ever be cached (PLAN §4 "Cache"). This catches binary
// containers AND long encoded payloads hidden in strings (a data: URL stores
// the image as base64, which a typed-array-only check would miss).
const LONG_ENCODED = /[A-Za-z0-9+/%]{512,}/;

function containsBinary(value: unknown): boolean {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (typeof value === "string") return LONG_ENCODED.test(value);
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

// A data: URL srcUrl carries the encoded image, so storing it verbatim is
// storing image bytes (and would blow the 10 MB session quota).
describe("data: URLs never put their payload in the cache", () => {
  const PAYLOAD = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(200);
  const BASE64 = `data:image/png;base64,${PAYLOAD}`;

  test("a base64 data: URL is stored without its payload", async () => {
    const { store, sets } = fakeStore();
    await putCheck(store, record({ srcUrl: BASE64 }));
    const stored = sets[0].value as CheckRecord;
    expect(stored.srcUrl).toBe("data:image/png;base64,");
    expect(JSON.stringify(stored)).not.toContain(PAYLOAD);
  });

  test("a percent-encoded data: URL is stored without its payload", async () => {
    const { store, sets } = fakeStore();
    await putCheck(store, record({ srcUrl: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E" }));
    expect((sets[0].value as CheckRecord).srcUrl).toBe("data:image/svg+xml,");
  });

  test("a malformed data: URL with no comma is stored without its body", async () => {
    const { store, sets } = fakeStore();
    await putCheck(store, record({ srcUrl: `data:image/png;base64${PAYLOAD}` }));
    const stored = sets[0].value as CheckRecord;
    expect(stored.srcUrl).toBe("data:");
    expect(JSON.stringify(stored)).not.toContain(PAYLOAD);
  });

  test("a 1 MiB image stays a tiny record (session quota guard)", async () => {
    const { store, sets } = fakeStore();
    const big = `data:image/png;base64,${"A".repeat(1024 * 1024)}`;
    await putCheck(store, record({ srcUrl: big }));
    expect(JSON.stringify(sets[0].value).length).toBeLessThan(500);
  });

  test("getCheck returns the payload-free reference", async () => {
    const { store } = fakeStore();
    await putCheck(store, record({ srcUrl: BASE64 }));
    expect((await getCheck(store, "check-1"))?.srcUrl).toBe("data:image/png;base64,");
  });

  test("http and blob: URLs are stored unchanged", async () => {
    const { store, sets } = fakeStore();
    await putCheck(store, record({ srcUrl: "https://cdn.example/a,b.png?x=1,2" }));
    expect((sets[0].value as CheckRecord).srcUrl).toBe("https://cdn.example/a,b.png?x=1,2");
    await putCheck(store, record({ checkId: "c2", srcUrl: "blob:https://page.example/uuid" }));
    expect((sets[1].value as CheckRecord).srcUrl).toBe("blob:https://page.example/uuid");
  });
});
