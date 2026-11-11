import { describe, expect, test, vi } from "vitest";
import {
  collectImage,
  decodeBase64WithLimit,
  decodeDataUrl,
  fetchImageBytes,
  IMAGE_ACCEPT,
  readBlobRequest,
  sha256Hex,
} from "../src/background/fetchImage";
import { needsPermissionRequest, originsToCheck } from "../src/background/permissions";
import { decodeBase64, encodeBase64 } from "../src/shared/base64";
import { MAX_BLOB_BYTES, MAX_IMAGE_BYTES } from "../src/shared/limits";
import { isReadBlob } from "../src/shared/types";
import { minimalPng } from "./helpers/images";

const KIB = 1024;
const MIB = KIB * KIB;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at += 65536) {
    crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, length)));
  }
  return bytes;
}

function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

// A fetch fake that honours the abort signal like the real one: rejects with
// AbortError when aborted before the response resolves.
function neverEndingFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
      void resolve;
    });
}

describe("base64", () => {
  test("round trips arbitrary bytes", () => {
    const bytes = randomBytes(3 * MIB + 7);
    expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
  });

  test("rejects invalid base64", () => {
    expect([...decodeBase64("AAAA")]).toEqual([0, 0, 0]);
    expect(() => decodeBase64("A")).toThrow();
  });
});

describe("decodeBase64WithLimit", () => {
  test("returns bytes under the limit", () => {
    const result = decodeBase64WithLimit(encodeBase64(new Uint8Array([1, 2, 3])), 10);
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.mediaType).toBe("");
  });

  test("rejects a payload over the limit with too_large", () => {
    const big = encodeBase64(new Uint8Array(MAX_BLOB_BYTES + 1).fill(0));
    expect(decodeBase64WithLimit(big, MAX_BLOB_BYTES)).toEqual({ kind: "error", error: { code: "too_large" } });
  });

  test("a payload exactly at the limit passes, one byte over is too_large", () => {
    const atLimit = encodeBase64(new Uint8Array(1000).fill(0));
    expect(decodeBase64WithLimit(atLimit, 1000).kind).toBe("bytes");
    const over = encodeBase64(new Uint8Array(1001).fill(0));
    expect(decodeBase64WithLimit(over, 1000)).toEqual({ kind: "error", error: { code: "too_large" } });
  });

  test("the padded length estimate counts the stripped '=' bytes", () => {
    // "YQ==" decodes to 1 byte; the limit must compare decoded size, so a
    // limit of 1 accepts it and a limit of 0 rejects it.
    expect(decodeBase64WithLimit("YQ==", 1).kind).toBe("bytes");
    expect(decodeBase64WithLimit("YQ==", 0)).toEqual({ kind: "error", error: { code: "too_large" } });
    // "YWI=" decodes to 2 bytes (single '=').
    expect(decodeBase64WithLimit("YWI=", 2).kind).toBe("bytes");
    expect(decodeBase64WithLimit("YWI=", 1)).toEqual({ kind: "error", error: { code: "too_large" } });
    // No padding: "YWJj" decodes to 3 bytes.
    expect(decodeBase64WithLimit("YWJj", 3).kind).toBe("bytes");
    expect(decodeBase64WithLimit("YWJj", 2)).toEqual({ kind: "error", error: { code: "too_large" } });
  });

  test("invalid base64 gives fetch_failed", () => {
    expect(decodeBase64WithLimit("!!", MAX_BLOB_BYTES)).toEqual({ kind: "error", error: { code: "fetch_failed" } });
  });
});

describe("decodeDataUrl", () => {
  const PNG_1PX =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("the exported Accept header is the browser's image value", () => {
    expect(IMAGE_ACCEPT).toBe("image/jxl,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
  });

  test("decodes a base64 data URL", () => {
    const result = decodeDataUrl(`data:image/png;base64,${PNG_1PX}`);
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(result.mediaType).toBe("image/png");
  });

  test("decodes a percent-encoded (non-base64) data URL", () => {
    const png = minimalPng();
    const escaped = [...png].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
    const result = decodeDataUrl(`data:image/png,${escaped}`);
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([...png]);
    expect(result.mediaType).toBe("image/png");
  });

  test("uppercase-hex percent escapes are decoded", () => {
    const result = decodeDataUrl("data:image/png,%89PNG%0D%0A");
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  });

  test("a literal character that is not a valid escape is kept verbatim", () => {
    // "%2" and "%zz" are not escapes; both characters stay as written.
    const result = decodeDataUrl("data:image/png,%2zz");
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([0x25, 0x32, 0x7a, 0x7a]);
  });

  test("a non-ASCII character in the payload is unsupported_type", () => {
    expect(decodeDataUrl("data:image/png,é")).toEqual({ kind: "error", error: { code: "unsupported_type" } });
  });

  test("a data: URL without a comma is unsupported_type", () => {
    expect(decodeDataUrl("data:image/png;base64")).toEqual({ kind: "error", error: { code: "unsupported_type" } });
  });

  test("a URL that is not the data: scheme is unsupported even with a comma", () => {
    // "xxxxx" + "image/png..." must not be treated as a data: URL.
    expect(decodeDataUrl("xxxxximage/png;base64,YQ==")).toEqual({ kind: "error", error: { code: "unsupported_type" } });
  });

  test("the base64 marker is recognised with mixed case and whitespace", () => {
    const png = minimalPng();
    const encoded = encodeBase64(png);
    for (const marker of [";base64", ";BASE64", "; base64 "]) {
      const result = decodeDataUrl(`data:image/png${marker},${encoded}`);
      expect(result.kind, marker).toBe("bytes");
      // Assert the decoded bytes, not just the shape: a non-base64
      // interpretation would also return "bytes" but with the literal text.
      if (result.kind === "bytes") expect([...result.bytes], marker).toEqual([...png]);
    }
    // A payload that happens to contain "base64" as data is not base64-decoded.
    const notBase64 = decodeDataUrl("data:image/png,purebase64text");
    expect(notBase64.kind).toBe("bytes");
    if (notBase64.kind !== "bytes") return;
    expect(new TextDecoder().decode(notBase64.bytes)).toBe("purebase64text");
  });

  test("a non-base64 parameter does not trigger base64 decoding", () => {
    // The "charset" parameter makes params non-empty; it must not count as the
    // base64 marker, so the payload stays literal text.
    const result = decodeDataUrl("data:image/png;charset=utf-8,hello");
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect(new TextDecoder().decode(result.bytes)).toBe("hello");
  });

  test("a literal 0x7f byte is accepted (only code points above 0x7f are rejected)", () => {
    const result = decodeDataUrl("data:image/png,\u007f");
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([0x7f]);
  });

  test("decodes a base64 payload that carries percent escapes", () => {
    const png = minimalPng();
    const escaped = [...encodeBase64(png)].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    const result = decodeDataUrl(`data:image/png;base64,${escaped}`);
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([...png]);
  });

  test("decodes multi-MiB data URLs in both encodings", () => {
    const big = new Uint8Array(2 * MIB);
    big.set(minimalPng());
    const b64 = decodeDataUrl(`data:image/png;base64,${encodeBase64(big)}`);
    expect(b64.kind).toBe("bytes");
    if (b64.kind === "bytes") expect(b64.bytes.length).toBe(big.length);

    const escaped = [...big.subarray(0, 512 * KIB)].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
    const pct = decodeDataUrl(`data:image/png,${escaped}`);
    expect(pct.kind).toBe("bytes");
    if (pct.kind === "bytes") expect(pct.bytes.length).toBe(512 * KIB);
  });

  test("enforces the limit on decoded bytes at the boundary, in every encoding", () => {
    const at = (n: number): Uint8Array => new Uint8Array(n).fill(0x41);
    const pct = (bytes: Uint8Array): string => [...bytes].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
    const b64Escaped = (bytes: Uint8Array): string =>
      [...encodeBase64(bytes)].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    const encodings: Array<[string, (bytes: Uint8Array) => string]> = [
      ["data:image/png;base64,", encodeBase64],
      ["data:image/png,", pct],
      ["data:image/png;base64,", b64Escaped],
    ];
    for (const [prefix, encode] of encodings) {
      const ok = decodeDataUrl(prefix + encode(at(1000)), 1000);
      expect(ok.kind, `${prefix} at the limit`).toBe("bytes");
      expect(decodeDataUrl(prefix + encode(at(1001)), 1000), `${prefix} over the limit`).toEqual({
        kind: "error",
        error: { code: "too_large" },
      });
    }
  });

  test("rejects an oversized payload by length before decoding", () => {
    // A payload long enough to trip the pre-decode length check but made of
    // characters that are not valid base64: the pre-check must win, so the
    // result is too_large, not the unsupported_type a decode failure gives.
    expect(decodeDataUrl(`data:image/png;base64,${"!".repeat(5000)}`, 1000)).toEqual({
      kind: "error",
      error: { code: "too_large" },
    });
    expect(decodeDataUrl(`data:image/png,${"a".repeat(2000)}`, 1000)).toEqual({ kind: "error", error: { code: "too_large" } });
    expect(decodeDataUrl(`data:image/png;base64,${"A".repeat(2000)}`, 1000)).toEqual({ kind: "error", error: { code: "too_large" } });
  });

  test("the media type is empty: collectImage sniffs it from the bytes", async () => {
    const streamed = await fetchImageBytes("https://cdn.example/i.png", {
      fetchImpl: async () => streamResponse([minimalPng()]),
    });
    expect(streamed.kind === "bytes" && streamed.mediaType).toBe("");
    const noBody = await fetchImageBytes("https://cdn.example/i.png", {
      fetchImpl: async () => new Response(minimalPng().slice().buffer, { status: 200 }),
    });
    expect(noBody.kind === "bytes" && noBody.mediaType).toBe("");
  });

  test("non-image and malformed data URLs give unsupported_type", () => {
    expect(decodeDataUrl("data:text/plain;base64,aGk=")).toEqual({ kind: "error", error: { code: "unsupported_type" } });
    expect(decodeDataUrl("data:image/png;base64,!!!")).toEqual({ kind: "error", error: { code: "unsupported_type" } });
    expect(decodeDataUrl("https://example.com/x.png")).toEqual({ kind: "error", error: { code: "unsupported_type" } });
  });
});

describe("originsToCheck / needsPermissionRequest", () => {
  test("frame and image origin are the only patterns needed", () => {
    expect(originsToCheck("https://page.example/a", "https://page.example/b.png")).toEqual(["https://page.example/*"]);
    expect(originsToCheck("https://page.example/a", "https://cdn.example/b.png")).toEqual([
      "https://page.example/*",
      "https://cdn.example/*",
    ]);
  });

  test("data: and blob: image urls skip the image origin", () => {
    expect(originsToCheck("https://page.example/a", "data:image/png;base64,AAA")).toEqual(["https://page.example/*"]);
    expect(originsToCheck("https://page.example/a", "blob:https://page.example/uuid")).toEqual([
      "https://page.example/*",
    ]);
    expect(originsToCheck("about:blank", "data:image/png;base64,AAA")).toEqual([]);
  });

  test("needsPermissionRequest follows the plan rule", () => {
    const main = "https://page.example/";
    expect(needsPermissionRequest(main, main, "https://page.example/i.png")).toBe(false);
    expect(needsPermissionRequest(main, main, "https://cdn.example/i.png")).toBe(true);
    expect(needsPermissionRequest(main, main, "data:image/png;base64,AAA")).toBe(false);
  });

  test("a cross-origin frame needs the permission whatever the image url is", () => {
    const main = "https://page.example/";
    const frame = "https://embed.example/f.html";
    expect(needsPermissionRequest(main, frame, "data:image/png;base64,AAA")).toBe(true);
    expect(needsPermissionRequest(main, frame, "blob:https://embed.example/uuid")).toBe(true);
    expect(needsPermissionRequest(main, frame, "https://page.example/i.png")).toBe(true);
  });

  test("a frame without an http(s) origin does not trigger the prompt", () => {
    expect(needsPermissionRequest("https://page.example/", "about:blank", "data:image/png;base64,AAA")).toBe(false);
  });
});

describe("fetchImageBytes", () => {
  test("returns all bytes for a stream under the limit", async () => {
    const body = minimalPng();
    const fetchImpl = vi.fn(async () => streamResponse([body]));
    const result = await fetchImageBytes("https://cdn.example/i.png", { fetchImpl });
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([...body]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("sends no credentials and the image Accept header", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return streamResponse([minimalPng()]);
    }) as typeof fetch;
    await fetchImageBytes("https://cdn.example/i.png", { fetchImpl });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe("https://cdn.example/i.png");
    expect(init?.credentials).toBe("omit");
    // Assert the literal: comparing against the imported constant would move
    // with the mutant and detect nothing.
    expect(init?.headers).toEqual({
      Accept: "image/jxl,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("honours a caller-supplied deadline instead of the default", async () => {
    vi.useFakeTimers();
    try {
      const outcome = fetchImageBytes("https://cdn.example/i.png", { fetchImpl: neverEndingFetch(), deadlineMs: 1000 });
      await vi.advanceTimersByTimeAsync(999);
      // Not yet aborted at 999 ms: prove by resolving nothing and only then
      // crossing the deadline.
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toEqual({ kind: "error", error: { code: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  });

  test("clears its deadline timer when the fetch finishes", async () => {
    vi.useFakeTimers();
    try {
      await fetchImageBytes("https://cdn.example/i.png", { fetchImpl: async () => streamResponse([minimalPng()]) });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a non-Abort DOMException maps to fetch_failed, not timeout", async () => {
    const fetchImpl = async () => {
      throw new DOMException("boom", "NetworkError");
    };
    expect(await fetchImageBytes("https://cdn.example/i.png", { fetchImpl })).toEqual({
      kind: "error",
      error: { code: "fetch_failed" },
    });
  });

  test("stops reading once more than 50 MiB has arrived", async () => {
    const chunk = new Uint8Array(30 * MIB).fill(1);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk); // 60 MiB; a third would follow in reality
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const result = await fetchImageBytes("https://cdn.example/i.png", { fetchImpl });
    expect(result).toEqual({ kind: "error", error: { code: "too_large" } });
    expect(cancelled).toBe(true);
  });

  test("accepts a stream exactly at 50 MiB and rejects one byte over", async () => {
    const exact = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));
        controller.close();
      },
    });
    const ok = await fetchImageBytes("https://cdn.example/i.png", {
      fetchImpl: async () => new Response(exact, { status: 200 }),
    });
    expect(ok.kind).toBe("bytes");

    const over = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
    });
    const tooLarge = await fetchImageBytes("https://cdn.example/i.png", {
      fetchImpl: async () => new Response(over, { status: 200 }),
    });
    expect(tooLarge).toEqual({ kind: "error", error: { code: "too_large" } });
  }, 20_000);

  test("assembles a multi-chunk stream in order", async () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);
    const result = await fetchImageBytes("https://cdn.example/i.png", {
      fetchImpl: async () => streamResponse([first, second]),
    });
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("maps a non-abort error while reading the body to fetch_failed", async () => {
    const fetchImpl = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 200 });
    };
    expect(await fetchImageBytes("https://cdn.example/i.png", { fetchImpl })).toEqual({
      kind: "error",
      error: { code: "fetch_failed" },
    });
  });

  test("a response with no body falls back to arrayBuffer and enforces the cap", async () => {
    const fetchImpl = async () => new Response(minimalPng().slice().buffer, { status: 200 });
    const result = await fetchImageBytes("https://cdn.example/i.png", { fetchImpl });
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([...minimalPng()]);
    expect(result.mediaType).toBe("");
  });

  test("maps a non-2xx response to fetch_failed", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    expect(await fetchImageBytes("https://cdn.example/i.png", { fetchImpl })).toEqual({
      kind: "error",
      error: { code: "fetch_failed" },
    });
  });

  test("maps a network error to fetch_failed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchImageBytes("https://cdn.example/i.png", { fetchImpl })).toEqual({
      kind: "error",
      error: { code: "fetch_failed" },
    });
  });

  test("aborts at 25 s in the header phase and in the body phase", async () => {
    vi.useFakeTimers();
    try {
      const headerOutcome = fetchImageBytes("https://cdn.example/i.png", { fetchImpl: neverEndingFetch() });
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(headerOutcome).resolves.toEqual({ kind: "error", error: { code: "timeout" } });

      // Body phase: real fetch ties the body stream to the abort signal; on
      // abort the parked read rejects with AbortError (the browser tears the
      // connection down itself; reader.cancel in finally is a safety net).
      const bodyFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(new Uint8Array(1024));
            // never closes: the body trickles forever
          },
        });
        init?.signal?.addEventListener("abort", () => {
          controller?.error(new DOMException("The operation was aborted.", "AbortError"));
        });
        return new Response(body, { status: 200 });
      };
      const bodyOutcome = fetchImageBytes("https://cdn.example/i.png", { fetchImpl: bodyFetch });
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(bodyOutcome).resolves.toEqual({ kind: "error", error: { code: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});

describe("sha256Hex", () => {
  test("computes the SHA-256 hex digest of known bytes", async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("collectImage", () => {
  const noBlob = async (): Promise<never> => {
    throw new Error("not a blob url");
  };

  test("happy path: fetch, sniff, hash", async () => {
    const body = minimalPng();
    const fetchImpl = vi.fn(async () => streamResponse([body]));
    const collected = await collectImage("https://cdn.example/i.png", { fetchImpl, readBlob: noBlob });
    expect(collected.kind).toBe("image");
    if (collected.kind !== "image") return;
    expect(collected.mediaType).toBe("image/png");
    expect(collected.size).toBe(body.length);
    expect(collected.imageHash).toBe(await sha256Hex(body));
  });

  test("unknown sniffed type gives unsupported_type", async () => {
    const fetchImpl = vi.fn(async () => streamResponse([new TextEncoder().encode("<svg xmlns=")]));
    const collected = await collectImage("https://cdn.example/i.svg", { fetchImpl, readBlob: noBlob });
    expect(collected).toEqual({ kind: "error", error: { code: "unsupported_type" } });
  });

  test("data: url is decoded without fetch", async () => {
    const PNG_1PX =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const fetchImpl = vi.fn();
    const collected = await collectImage(`data:image/png;base64,${PNG_1PX}`, {
      fetchImpl,
      readBlob: noBlob,
    });
    expect(collected.kind).toBe("image");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("blob: url goes through readBlob and round-trips base64", async () => {
    const body = minimalPng();
    const collected = await collectImage("blob:https://page.example/uuid", {
      fetchImpl: async () => {
        throw new Error("blob must not be fetched by the worker");
      },
      readBlob: async () => ({ ok: true, base64: encodeBase64(body) }),
    });
    expect(collected.kind).toBe("image");
    if (collected.kind !== "image") return;
    expect(collected.mediaType).toBe("image/png");
    expect(collected.size).toBe(body.length);
  });

  test("blob: read failure and too-large reply map to fetch_failed / too_large", async () => {
    const noFetch = async (): Promise<never> => {
      throw new Error("no fetch");
    };
    const failed = await collectImage("blob:https://page.example/uuid", { fetchImpl: noFetch, readBlob: async () => ({ ok: false }) });
    expect(failed).toEqual({ kind: "error", error: { code: "fetch_failed" } });

    const tooLarge = encodeBase64(new Uint8Array(MAX_BLOB_BYTES + 1).fill(7));
    const oversized = await collectImage("blob:https://page.example/uuid", {
      fetchImpl: noFetch,
      readBlob: async () => ({ ok: true, base64: tooLarge }),
    });
    expect(oversized).toEqual({ kind: "error", error: { code: "too_large" } });
  });

  test("blob: too_large reply from the page maps to too_large", async () => {
    const collected = await collectImage("blob:https://page.example/uuid", {
      readBlob: async () => ({ ok: false, reason: "too_large" }),
    });
    expect(collected).toEqual({ kind: "error", error: { code: "too_large" } });
  });
});

describe("readBlobRequest", () => {
  test("builds a message the content script's guard accepts", () => {
    const message = readBlobRequest("check-1", "blob:https://page.example/uuid");
    expect(isReadBlob(message)).toBe(true);
    expect(message).toEqual({ type: "readBlob", checkId: "check-1", url: "blob:https://page.example/uuid" });
  });
});
