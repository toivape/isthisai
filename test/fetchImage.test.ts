import { describe, expect, test, vi } from "vitest";
import {
  collectImage,
  decodeBase64WithLimit,
  decodeDataUrl,
  fetchImageBytes,
  readBlobRequest,
  sha256Hex,
} from "../src/background/fetchImage";
import { needsPermissionRequest, originsToCheck } from "../src/background/permissions";
import { decodeBase64, encodeBase64 } from "../src/shared/base64";
import { MAX_BLOB_BYTES } from "../src/shared/limits";
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
  });

  test("rejects a payload over the limit with too_large", () => {
    const big = encodeBase64(new Uint8Array(MAX_BLOB_BYTES + 1).fill(0));
    expect(decodeBase64WithLimit(big, MAX_BLOB_BYTES)).toEqual({ kind: "error", error: { code: "too_large" } });
  });

  test("invalid base64 gives fetch_failed", () => {
    expect(decodeBase64WithLimit("!!", MAX_BLOB_BYTES)).toEqual({ kind: "error", error: { code: "fetch_failed" } });
  });
});

describe("decodeDataUrl", () => {
  const PNG_1PX =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

  test("decodes a base64 payload that carries percent escapes", () => {
    const png = minimalPng();
    const escaped = [...encodeBase64(png)].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    const result = decodeDataUrl(`data:image/png;base64,${escaped}`);
    expect(result.kind).toBe("bytes");
    if (result.kind !== "bytes") return;
    expect([...result.bytes]).toEqual([...png]);
  });

  test("rejects an oversized payload by length before decoding", () => {
    expect(decodeDataUrl(`data:image/png,${"a".repeat(2000)}`, 1000)).toEqual({ kind: "error", error: { code: "too_large" } });
    expect(decodeDataUrl(`data:image/png;base64,${"A".repeat(2000)}`, 1000)).toEqual({
      kind: "error",
      error: { code: "too_large" },
    });
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
    expect(needsPermissionRequest(main, main, "https://page.example/i.png", false)).toBe(false);
    expect(needsPermissionRequest(main, main, "https://cdn.example/i.png", true)).toBe(false);
    expect(needsPermissionRequest(main, main, "https://cdn.example/i.png", false)).toBe(true);
    expect(needsPermissionRequest(main, main, "data:image/png;base64,AAA", false)).toBe(false);
  });

  test("a cross-origin frame needs the permission whatever the image url is", () => {
    const main = "https://page.example/";
    const frame = "https://embed.example/f.html";
    expect(needsPermissionRequest(main, frame, "data:image/png;base64,AAA", false)).toBe(true);
    expect(needsPermissionRequest(main, frame, "blob:https://embed.example/uuid", false)).toBe(true);
    expect(needsPermissionRequest(main, frame, "https://page.example/i.png", false)).toBe(true);
    expect(needsPermissionRequest(main, frame, "https://embed.example/i.png", true)).toBe(false);
  });

  test("a frame without an http(s) origin does not trigger the prompt", () => {
    expect(needsPermissionRequest("https://page.example/", "about:blank", "data:image/png;base64,AAA", false)).toBe(false);
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
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
