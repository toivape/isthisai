import { describe, expect, test, vi } from "vitest";
import { type CacheStore } from "../src/background/cache";
import { sha256Hex, type CollectedImage } from "../src/background/fetchImage";
import {
  consentWindowPath,
  mapReloadError,
  runOpenAiFlow,
  senderMatches,
  uploadRegistry,
  type OpenAiFlowDeps,
  type OpenAiFlowOutcome,
  type UploadRegistry,
} from "../src/background/openaiFlow";
import type { CheckErrorCode, CheckRecord, CheckResult, CheckUpdate, OpenAiErrorCode } from "../src/shared/types";
import { minimalGif, minimalPng, minimalWebp } from "./helpers/images";

// The OpenAI check flow (PLAN §4 step 8) as a pure function over injected deps:
// the worker's chrome wiring is not exercised here, only the decisions.

const CHECK_ID = "c1";
const SENDER = { tabId: 7, frameId: 0 };
// Not key-shaped on purpose: no real or plausible key value appears in tests.
const KEY = "placeholder-not-a-key";

function record(overrides: Partial<CheckRecord> = {}): CheckRecord {
  return {
    checkId: CHECK_ID,
    srcUrl: "https://cdn.example/i.png",
    frameUrl: "https://page.example/",
    tabId: SENDER.tabId,
    frameId: SENDER.frameId,
    imageHash: "unset",
    mediaType: "image/png",
    size: 4,
    ...overrides,
  };
}

function storedResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    imageHash: "unset",
    mediaType: "image/png",
    verdict: "no_signal",
    localC2pa: { manifest: "absent", aiAction: false },
    localXmp: { state: "not_detected" },
    openai: { state: "not_checked" },
    ...overrides,
  };
}

function isoBmff(brand: string): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(`ftyp${brand}`), 4);
  return bytes;
}

// A minimal OpenAI response: both image entries, as the API always sends them.
function provenanceResponse(c2pa: Record<string, unknown> = {}, synthid: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      results: [
        { type: "c2pa", outcome: "not_detected", ...c2pa },
        { type: "synthid", outcome: "not_detected", ...synthid },
      ],
    }),
    { status: 200 },
  );
}

// One fake fetch for both paths: the conversion re-fetch is a GET, the upload a
// POST, so the calls can be told apart by method.
function fakeFetch(converted: Uint8Array, upload: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (init.method === "POST") return upload;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(converted);
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    uploads: () => calls.filter((c) => c.init.method === "POST"),
    converts: () => calls.filter((c) => c.init.method !== "POST"),
  };
}

function uploadedFile(call: { init: RequestInit }): File {
  return (call.init.body as FormData).get("file") as File;
}

interface HarnessOptions {
  record?: CheckRecord;
  stored?: CheckResult;
  key?: string | undefined;
  consent?: boolean;
  reload?: CollectedImage;
  reloadError?: CheckErrorCode;
  storeWriteThrows?: boolean;
  fetchImpl?: typeof fetch;
  /** Overrides the in-memory store (for storage-failure cases). */
  store?: CacheStore;
  /** Overrides the upload registry (for concurrency and dedup cases). */
  uploads?: UploadRegistry;
}

function harness(options: HarnessOptions = {}) {
  const updates: CheckUpdate[] = [];
  const consentRequests: Array<{ checkId: string; path: string }> = [];
  const reloadCalls: CheckRecord[] = [];
  const data = new Map<string, unknown>();
  if (options.record !== undefined) data.set(`check:${options.record.checkId}`, options.record);
  if (options.stored !== undefined) data.set(`result:${options.stored.imageHash}`, options.stored);

  const memory: CacheStore = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      if (options.storeWriteThrows === true) throw new Error("Session storage quota bytes exceeded");
      data.set(key, value);
    },
  };
  const store = options.store ?? memory;
  const readKey = vi.fn(async () => options.key);
  const requestConsent = vi.fn(async (request: { checkId: string; path: string }) => {
    consentRequests.push(request);
    return options.consent ?? true;
  });
  const readImage = vi.fn(async (rec: CheckRecord): Promise<CollectedImage> => {
    reloadCalls.push(rec);
    if (options.reloadError !== undefined) return { kind: "error", error: { code: options.reloadError } };
    if (options.reload === undefined) throw new Error("reload not configured");
    return options.reload;
  });

  const deps: OpenAiFlowDeps = {
    store,
    readKey,
    requestConsent,
    readImage,
    // A fresh registry per harness keeps the tests hermetic; the concurrency test
    // shares one across two flows on purpose.
    uploads: options.uploads ?? uploadRegistry(),
    sendUpdate: (update) => {
      updates.push(update);
    },
    fetchImpl: options.fetchImpl,
  };
  return { deps, data, updates, consentRequests, reloadCalls, readKey, readImage };
}

// A consistent record/result/reload triplet around one set of bytes.
async function fixture(bytes: Uint8Array, mediaType: string, srcUrl = "https://cdn.example/i.png") {
  const imageHash = await sha256Hex(bytes);
  const collected: CollectedImage = { kind: "image", bytes, mediaType, size: bytes.length, imageHash };
  return {
    imageHash,
    collected,
    record: record({ srcUrl, imageHash, mediaType, size: bytes.length }),
    stored: storedResult({ imageHash, mediaType }),
  };
}

function run(deps: OpenAiFlowDeps, sender = SENDER) {
  return runOpenAiFlow(deps, { checkId: CHECK_ID, sender });
}

describe("senderMatches", () => {
  test("the tab and the frame must both match", () => {
    const rec = record();
    expect(senderMatches(rec, SENDER)).toBe(true);
    expect(senderMatches(rec, { tabId: 8, frameId: 0 })).toBe(false);
    expect(senderMatches(rec, { tabId: 7, frameId: 1 })).toBe(false);
    expect(senderMatches(rec, { tabId: undefined, frameId: 0 })).toBe(false);
    expect(senderMatches(rec, { tabId: 7, frameId: undefined })).toBe(false);
  });
});

describe("consentWindowPath", () => {
  test("carries the image's origin, media type and size", () => {
    const path = consentWindowPath(record({ srcUrl: "https://cdn.example/i.avif", mediaType: "image/avif", size: 459248 }));
    expect(path).toBe(
      "src/confirm/confirm.html?view=confirm&checkId=c1&mediaType=image%2Favif&sizeBytes=459248&origin=https%3A%2F%2Fcdn.example",
    );
  });

  test("a data: image has no origin, so the line is omitted", () => {
    // new URL("data:...").origin is the string "null"; httpOrigin maps it to
    // nothing so the window hides the line instead of showing "null".
    const params = new URLSearchParams(consentWindowPath(record({ srcUrl: "data:image/png;base64," })).split("?")[1]);
    expect(params.has("origin")).toBe(false);
    expect(params.get("checkId")).toBe(CHECK_ID);
    expect(params.get("mediaType")).toBe("image/png");
    expect(params.get("sizeBytes")).toBe("4");
  });
});

describe("mapReloadError", () => {
  test("maps the local fetch codes onto the OpenAI error set", () => {
    expect(mapReloadError("timeout")).toBe("timeout");
    expect(mapReloadError("unsupported_type")).toBe("unsupported_type");
    expect(mapReloadError("fetch_failed")).toBe("fetch_failed");
    // There is no OpenAI code for a local size or permission failure; the image
    // could not be re-obtained, which is what fetch_failed says.
    expect(mapReloadError("too_large")).toBe("fetch_failed");
    expect(mapReloadError("permission_denied")).toBe("fetch_failed");
  });
});

describe("runOpenAiFlow: request validation", () => {
  test("a missing check record gives check_expired and opens no window", async () => {
    const h = harness({ stored: storedResult({ imageHash: "other" }) });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "check_expired" } });
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.consentRequests).toEqual([]);
    expect(h.reloadCalls).toEqual([]);
  });

  test("a sender whose tab does not match the record is ignored", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY });
    expect(await run(h.deps, { tabId: 99, frameId: SENDER.frameId })).toEqual({ kind: "ignored" });
    expect(h.readKey).not.toHaveBeenCalled();
    expect(h.consentRequests).toEqual([]);
    expect(h.reloadCalls).toEqual([]);
  });

  test("a sender whose frame does not match the record is ignored", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY });
    expect(await run(h.deps, { tabId: SENDER.tabId, frameId: 3 })).toEqual({ kind: "ignored" });
    expect(h.reloadCalls).toEqual([]);
  });

  test("no stored key gives no_key, before any fetch or window", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, fetchImpl });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "no_key" } });
    expect(h.consentRequests).toEqual([]);
    expect(h.reloadCalls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("an empty stored key is no_key, not an invalid one", async () => {
    // "" would otherwise reach isSendableKey and come back invalid_key, telling
    // the user to re-save a key they never had (same rule as testKey, #10).
    const f = await fixture(minimalPng(), "image/png");
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: "" });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "no_key" } });
    expect(h.consentRequests).toEqual([]);
  });

  test("an unsendable key gives invalid_key, before any fetch or window", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: "bad\nkey" });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "invalid_key" } });
    expect(h.consentRequests).toEqual([]);
    expect(h.reloadCalls).toEqual([]);
  });

  test("a stored result that is gone gives check_expired rather than uploading", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const h = harness({ record: f.record, reload: f.collected, key: KEY });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "check_expired" } });
    expect(h.consentRequests).toEqual([]);
    expect(h.reloadCalls).toEqual([]);
  });

  test("a store that rejects on read is logged and gives check_expired", async () => {
    const store: CacheStore = {
      get: async () => {
        throw new Error("session storage unavailable");
      },
      set: async () => {},
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = harness({ store, reload: undefined, key: KEY });
      expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "check_expired" } });
      expect(errorSpy).toHaveBeenCalledWith("cache read failed", expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("a result read failure is logged and gives check_expired", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const store: CacheStore = {
      get: async (key) => {
        if (key === `check:${f.record.checkId}`) return f.record;
        throw new Error("session storage unavailable");
      },
      set: async () => {},
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = harness({ store, reload: f.collected, key: KEY });
      expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "check_expired" } });
      expect(errorSpy).toHaveBeenCalledWith("cache read failed", expect.any(Error));
      expect(h.reloadCalls).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("runOpenAiFlow: consent", () => {
  test("a declined confirmation gives cancelled and nothing is uploaded", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, consent: false, fetchImpl });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "cancelled" } });
    expect(h.consentRequests).toEqual([{ checkId: CHECK_ID, path: consentWindowPath(f.record) }]);
    // Consent comes before the bytes come back, so a decline never re-fetches.
    expect(h.reloadCalls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });
});

describe("runOpenAiFlow: re-fetch and hash", () => {
  test("the record's srcUrl is re-fetched, hash-checked and uploaded", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const { fetchImpl, uploads } = fakeFetch(minimalWebp(), provenanceResponse());
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    const outcome = await run(h.deps);

    expect(outcome.kind).toBe("done");
    expect(h.reloadCalls).toEqual([f.record]);
    expect(h.consentRequests).toEqual([{ checkId: CHECK_ID, path: consentWindowPath(f.record) }]);
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0].url).toBe("https://api.openai.com/v1/content_provenance_checks");
    expect(uploads()[0].init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(uploadedFile(uploads()[0]).type).toBe("image/png");
  });

  test("a hash mismatch gives hash_mismatch and nothing is uploaded", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const changed = await fixture(minimalWebp(), "image/webp");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const h = harness({ record: f.record, stored: f.stored, reload: changed.collected, key: KEY, fetchImpl });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "hash_mismatch" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  const mappings: Array<[CheckErrorCode, OpenAiErrorCode]> = [
    ["fetch_failed", "fetch_failed"],
    ["timeout", "timeout"],
    ["unsupported_type", "unsupported_type"],
    ["too_large", "fetch_failed"],
  ];
  for (const [reloadError, expected] of mappings) {
    test(`a re-fetch failure ${reloadError} maps to ${expected} and uploads nothing`, async () => {
      const f = await fixture(minimalPng(), "image/png");
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const h = harness({ record: f.record, stored: f.stored, reloadError, key: KEY, fetchImpl });
      expect(await run(h.deps)).toEqual({ kind: "error", error: { code: expected } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }
});

describe("runOpenAiFlow: server conversion", () => {
  test("an AVIF image is re-fetched with the accepted media types and uploaded as serverConverted", async () => {
    const f = await fixture(isoBmff("avif"), "image/avif");
    const { fetchImpl, converts, uploads } = fakeFetch(minimalWebp(), provenanceResponse());
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    const outcome = await run(h.deps);

    if (outcome.kind !== "done") throw new Error("expected done");
    expect(converts()).toHaveLength(1);
    // Assert the literal: comparing against the imported constant would move
    // with the mutant and detect nothing.
    expect(converts()[0].init.headers).toEqual({ Accept: "image/webp,image/png,image/jpeg" });
    expect(uploads()).toHaveLength(1);
    expect(uploadedFile(uploads()[0]).type).toBe("image/webp");
    expect(outcome.result.openai).toMatchObject({ state: "done", serverConverted: true });
  });

  test("a HEIC image takes the same path as AVIF", async () => {
    const f = await fixture(isoBmff("heic"), "image/heic");
    const { fetchImpl, converts, uploads } = fakeFetch(minimalPng(), provenanceResponse());
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    expect((await run(h.deps)).kind).toBe("done");
    expect(converts()).toHaveLength(1);
    expect(uploadedFile(uploads()[0]).type).toBe("image/png");
  });

  test("a GIF is uploaded directly, with no conversion re-fetch", async () => {
    const f = await fixture(minimalGif(), "image/gif");
    const { fetchImpl, converts, uploads } = fakeFetch(minimalWebp(), provenanceResponse());
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    const outcome = await run(h.deps);

    if (outcome.kind !== "done") throw new Error("expected done");
    expect(converts()).toEqual([]);
    expect(uploadedFile(uploads()[0]).type).toBe("image/gif");
    expect(outcome.result.openai).toMatchObject({ serverConverted: false });
  });

  test("a conversion that returns an unsupported type again gives unsupported_type", async () => {
    const f = await fixture(isoBmff("avif"), "image/avif");
    const { fetchImpl, uploads } = fakeFetch(isoBmff("avif"), provenanceResponse());
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "unsupported_type" } });
    expect(uploads()).toEqual([]);
  });

  test("a failing conversion re-fetch gives the mapped error and uploads nothing", async () => {
    const f = await fixture(isoBmff("avif"), "image/avif");
    const methods: Array<string | undefined> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      methods.push(init.method);
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "fetch_failed" } });
    expect(methods).toEqual([undefined]);
  });

  test("the converted bytes are not hash-checked: the server re-encoded the image", async () => {
    const f = await fixture(isoBmff("avif"), "image/avif");
    const converted = minimalWebp();
    const { fetchImpl, uploads } = fakeFetch(converted, provenanceResponse());
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    expect((await run(h.deps)).kind).toBe("done");
    // The hash check applies to the reloaded original only; the converted copy
    // differs by construction and must still be uploaded.
    expect(await sha256Hex(converted)).not.toBe(f.imageHash);
    expect(uploads()).toHaveLength(1);
  });

  test("an AVIF from a data: url gives unsupported_type without a conversion fetch", async () => {
    const f = await fixture(isoBmff("avif"), "image/avif", "data:image/avif;base64,");
    const { fetchImpl, calls } = fakeFetch(minimalWebp(), provenanceResponse());
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    // There is no server to ask for another format.
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "unsupported_type" } });
    expect(calls).toEqual([]);
  });
});

describe("runOpenAiFlow: merge, cache and report", () => {
  test("a successful upload merges the signals, recomputes the verdict and caches it", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const { fetchImpl } = fakeFetch(minimalWebp(), provenanceResponse({ outcome: "not_detected" }, { outcome: "detected", model: "gpt-image" }));
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    const outcome = await run(h.deps);

    if (outcome.kind !== "done") throw new Error("expected done");
    expect(outcome.result.openai).toEqual({
      state: "done",
      serverConverted: false,
      c2pa: { outcome: "not_detected" },
      synthid: { outcome: "detected", model: "gpt-image" },
    });
    expect(outcome.result.verdict).toBe("ai_signal");
    // The local parts are the ones the earlier check stored.
    expect(outcome.result.localC2pa).toEqual(f.stored.localC2pa);

    expect(h.data.get(`result:${f.imageHash}`)).toEqual(outcome.result);
    const done = h.updates[0];
    if (done.status !== "done") throw new Error("expected a done update");
    expect(done.result).toEqual(outcome.result);
    expect(done.openai).toEqual({ available: true });
    expect(done.srcUrl).toBe(f.record.srcUrl);
  });

  test("an OpenAI error is reported and never cached", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const { fetchImpl } = fakeFetch(minimalWebp(), new Response("nope", { status: 429, headers: { "retry-after": "30" } }));
    const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl });
    expect(await run(h.deps)).toEqual({ kind: "error", error: { code: "rate_limited", retryAfterSec: 30 } });
    expect(h.updates).toEqual([]);
    // The earlier local result is untouched, so a retry really retries.
    expect(h.data.get(`result:${f.imageHash}`)).toBe(f.stored);
  });

  test("a cache write failure still sends the user their result", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const { fetchImpl } = fakeFetch(minimalWebp(), provenanceResponse());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = harness({ record: f.record, stored: f.stored, reload: f.collected, key: KEY, fetchImpl, storeWriteThrows: true });
      const outcome = await run(h.deps);
      expect(outcome.kind).toBe("done");
      expect(h.updates).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith("cache write failed", expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("a stored result that already has the OpenAI step is returned without a second upload", async () => {
    const f = await fixture(minimalPng(), "image/png");
    const cached = storedResult({
      imageHash: f.imageHash,
      verdict: "ai_signal",
      openai: { state: "done", serverConverted: false, c2pa: { outcome: "detected", validation: "trusted" }, synthid: { outcome: "not_detected" } },
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const h = harness({ record: f.record, stored: cached, reload: f.collected, key: KEY, fetchImpl });
    expect(await run(h.deps)).toEqual({ kind: "done", result: cached });
    expect(h.consentRequests).toEqual([]);
    expect(h.reloadCalls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    // The popup still gets the result it asked for.
    expect(h.updates).toHaveLength(1);
  });

  test("a result completed while the window was open is not uploaded again", async () => {
    // Two checks of the same image: this flow read not_checked, then the other
    // one finished while this confirmation was open. Re-reading after consent is
    // what keeps the same image from being sent twice in a session.
    const f = await fixture(minimalPng(), "image/png");
    const completed = storedResult({
      imageHash: f.imageHash,
      verdict: "ai_signal",
      openai: { state: "done", serverConverted: false, c2pa: { outcome: "detected", validation: "trusted" }, synthid: { outcome: "not_detected" } },
    });
    let reads = 0;
    const store: CacheStore = {
      get: async (key) => {
        if (key === `check:${CHECK_ID}`) return f.record;
        if (key === `result:${f.imageHash}`) return reads++ === 0 ? f.stored : completed;
        return undefined;
      },
      set: async () => {},
    };
    const { fetchImpl, uploads } = fakeFetch(minimalWebp(), provenanceResponse());
    const h = harness({ store, reload: f.collected, key: KEY, fetchImpl });

    expect(await run(h.deps)).toEqual({ kind: "done", result: completed });
    expect(uploads()).toEqual([]);
    expect(h.reloadCalls).toEqual([]);
    const done = h.updates[0];
    if (done.status !== "done") throw new Error("expected a done update");
    expect(done.result).toEqual(completed);
  });

  test("the merge uses the freshest stored result, not the one read before the upload", async () => {
    // A local re-check of the same image can write the result while the upload is
    // in flight; merging onto the pre-upload read would undo it.
    const f = await fixture(minimalPng(), "image/png");
    const newer = storedResult({
      imageHash: f.imageHash,
      verdict: "ai_signal",
      localC2pa: { manifest: "present", aiAction: true, claimedIssuer: "OpenAI OpCo, LLC" },
    });
    let reads = 0;
    const store: CacheStore = {
      get: async (key) => {
        if (key === `check:${CHECK_ID}`) return f.record;
        if (key === `result:${f.imageHash}`) return reads++ < 2 ? f.stored : newer;
        return undefined;
      },
      set: async () => {},
    };
    const { fetchImpl } = fakeFetch(minimalWebp(), provenanceResponse());
    const h = harness({ store, reload: f.collected, key: KEY, fetchImpl });

    const outcome = await run(h.deps);
    if (outcome.kind !== "done") throw new Error("expected done");
    expect(outcome.result.localC2pa).toEqual(newer.localC2pa);
    expect(outcome.result.openai).toMatchObject({ state: "done" });
  });
});

describe("uploadRegistry", () => {
  test("runs one upload per hash and hands its outcome to a later caller", async () => {
    const registry = uploadRegistry();
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async (): Promise<OpenAiFlowOutcome> => {
      started += 1;
      await gate;
      return { kind: "ignored" };
    };

    const first = registry.run("hash", run);
    const second = registry.run("hash", run);
    expect(started).toBe(1);
    release();
    expect(await first).toEqual(await second);
    expect(started).toBe(1);

    // Once it has settled, a new caller starts a fresh run.
    await expect(registry.run("hash", run)).resolves.toEqual({ kind: "ignored" });
    expect(started).toBe(2);
  });

  test("different hashes do not wait for each other", async () => {
    const registry = uploadRegistry();
    const started: string[] = [];
    const run = (tag: string) => async (): Promise<OpenAiFlowOutcome> => {
      started.push(tag);
      return { kind: "ignored" };
    };
    await Promise.all([registry.run("a", run("a")), registry.run("b", run("b"))]);
    expect(started).toEqual(["a", "b"]);
  });

  test("remembers a success and never an error, so an error stays retryable", async () => {
    const registry = uploadRegistry();
    const result = storedResult({ imageHash: "h" });

    await registry.run("h", async () => ({ kind: "error", error: { code: "network" } }));
    expect(registry.get("h")).toBeUndefined();

    await registry.run("h", async () => ({ kind: "done", result }));
    expect(registry.get("h")).toEqual(result);
  });
});

describe("runOpenAiFlow: one upload per image", () => {
  test("two checks of the same image upload once, and each caller gets a done update", async () => {
    // Two checkIds, one image: both flows read not_checked and both are approved.
    // The per-hash lock has to make the second one reuse the first's outcome.
    const f = await fixture(minimalPng(), "image/png");
    const data = new Map<string, unknown>([
      [`check:${f.record.checkId}`, f.record],
      ["check:c2", { ...f.record, checkId: "c2" }],
      [`result:${f.imageHash}`, f.stored],
    ]);
    const store: CacheStore = {
      get: async (key) => data.get(key),
      set: async (key, value) => {
        data.set(key, value);
      },
    };

    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploads = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (init.method !== "POST") throw new Error("no conversion expected");
      uploads += 1;
      await uploadGate;
      return provenanceResponse({}, { outcome: "detected" });
    }) as unknown as typeof fetch;

    const registry = uploadRegistry();
    const updates: Array<{ checkId: string; update: CheckUpdate }> = [];
    const depsFor = (checkId: string): OpenAiFlowDeps => ({
      store,
      readKey: async () => KEY,
      requestConsent: async () => true,
      readImage: async () => f.collected,
      uploads: registry,
      sendUpdate: (update) => {
        updates.push({ checkId, update });
      },
      fetchImpl,
    });

    const first = runOpenAiFlow(depsFor(f.record.checkId), { checkId: f.record.checkId, sender: SENDER });
    const second = runOpenAiFlow(depsFor("c2"), { checkId: "c2", sender: SENDER });
    // Let both flows reach the lock; the first holds it on the gated upload.
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseUpload();
    const [a, b] = await Promise.all([first, second]);

    expect(uploads).toBe(1);
    expect(a.kind).toBe("done");
    expect(b).toEqual(a);
    expect(updates.map((entry) => entry.checkId).sort()).toEqual(["c1", "c2"]);
    expect(updates.every((entry) => entry.update.status === "done")).toBe(true);
  });

  test("an upload that succeeded is not repeated when its cache write failed", async () => {
    // The done marker is written after the upload, so a rejected result write
    // leaves the cache saying not_checked; the worker's own memory is what keeps
    // the image from being sent a second time in the same worker lifetime.
    const f = await fixture(minimalPng(), "image/png");
    const store: CacheStore = {
      get: async (key) => {
        if (key === `check:${CHECK_ID}`) return f.record;
        if (key === `result:${f.imageHash}`) return f.stored;
        return undefined;
      },
      set: async () => {
        throw new Error("Session storage quota bytes exceeded");
      },
    };
    const { fetchImpl, uploads } = fakeFetch(minimalWebp(), provenanceResponse({}, { outcome: "detected" }));
    const registry = uploadRegistry();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const first = harness({ store, reload: f.collected, key: KEY, fetchImpl, uploads: registry });
      expect((await run(first.deps)).kind).toBe("done");
      expect(uploads()).toHaveLength(1);

      // A second check of the same image: the cache still says not_checked, but
      // no second window is opened and nothing is uploaded.
      const second = harness({ store, reload: f.collected, key: KEY, fetchImpl, uploads: registry });
      expect((await run(second.deps)).kind).toBe("done");
      expect(uploads()).toHaveLength(1);
      expect(second.consentRequests).toEqual([]);
      expect(second.reloadCalls).toEqual([]);
      expect(second.updates).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
