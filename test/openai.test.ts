import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { FETCH_DEADLINE_MS } from "../src/shared/limits";
import {
  PROVENANCE_URL,
  buildRequest,
  deadlineFor,
  mapHttpError,
  parseResponse,
  readProvenanceResponse,
  retryAfterSeconds,
  sendProvenanceUpload,
} from "../src/background/openai";

// Deliberately not key-shaped: no real or plausible key value appears in tests.
const KEY = "placeholder-not-a-key";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function fixtureBody(name: string): string {
  return readFileSync(`test/fixtures/${name}`, "utf8");
}

function body(results: unknown[]): string {
  return JSON.stringify({ object: "content_provenance_check", created_at: 1793451395, results });
}

// The unhelpful values the API really sends when it has nothing to report.
function c2pa(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "c2pa", outcome: "detected", validation_state: "trusted", issuer: null, model: null, generated_at: null, ...overrides };
}

function synthid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "synthid", outcome: "not_detected", model: null, generated_at: null, ...overrides };
}

describe("buildProvenanceUpload", () => {
  test("posts to the documented endpoint", () => {
    expect(PROVENANCE_URL).toBe("https://api.openai.com/v1/content_provenance_checks");
  });

  test("builds the multipart body with the File part typed by the sniffed media type", async () => {
    const upload = buildRequest(KEY, JPEG_BYTES, "image/jpeg");
    const part = upload.body.get("file");
    expect(part).toBeInstanceOf(Blob);
    expect((part as Blob).type).toBe("image/jpeg");
    expect((part as File).name).toBe("image.jpg");
    expect(new Uint8Array(await (part as Blob).arrayBuffer())).toEqual(JPEG_BYTES);
  });

  test("sets no Content-Type header, so FormData supplies the multipart boundary", () => {
    const upload = buildRequest(KEY, JPEG_BYTES, "image/png");
    const names = Object.keys(upload.headers).map((name) => name.toLowerCase());
    expect(names).not.toContain("content-type");
  });

  test("sends the key in the Authorization header and never in the URL", () => {
    const upload = buildRequest(KEY, JPEG_BYTES, "image/jpeg");
    expect(upload.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(upload.url).toBe(PROVENANCE_URL);
    expect(upload.url).not.toContain(KEY);
  });

  test("sends one file per request", () => {
    const upload = buildRequest(KEY, JPEG_BYTES, "image/jpeg");
    expect([...upload.body.keys()]).toEqual(["file"]);
  });

  test("names the file part after the sniffed media type", () => {
    const names: Array<[string, string]> = [
      ["image/png", "image.png"],
      ["image/jpeg", "image.jpg"],
      ["image/webp", "image.webp"],
      ["image/gif", "image.gif"],
    ];
    for (const [mediaType, filename] of names) {
      const part = buildRequest(KEY, JPEG_BYTES, mediaType).body.get("file") as File;
      expect(part.name, mediaType).toBe(filename);
      // The part type is what the API reads; the name must not contradict it.
      expect(part.type, mediaType).toBe(mediaType);
    }
  });

  test("an unknown media type gets a bare filename rather than an invented extension", () => {
    const part = buildRequest(KEY, JPEG_BYTES, "image/avif").body.get("file") as File;
    expect(part.name).toBe("image");
  });
});

describe("parseProvenanceBody: the real responses", () => {
  test("parses the halloween fixture: c2pa detected trusted with OpenAI issuer, synthid detected", () => {
    expect(parseResponse(fixtureBody("openai-halloween.json"), false)).toStrictEqual({
      ok: true,
      result: {
        state: "done",
        serverConverted: false,
        c2pa: {
          outcome: "detected",
          validation: "trusted",
          issuer: "OpenAI OpCo, LLC",
          model: "ChatGPT / gpt-image",
          generatedAt: "2026-10-31T12:38:51.498118Z",
        },
        synthid: { outcome: "detected" },
      },
    });
  });

  test("parses the iceland fixture: both not_detected, c2pa not_present", () => {
    expect(parseResponse(fixtureBody("openai-iceland.json"), false)).toStrictEqual({
      ok: true,
      result: {
        state: "done",
        serverConverted: false,
        c2pa: { outcome: "not_detected", validation: "not_present" },
        synthid: { outcome: "not_detected" },
      },
    });
  });

  test("parses the re-saved fixture: c2pa not_detected and synthid detected", () => {
    expect(parseResponse(fixtureBody("openai-halloween-resaved.json"), false)).toStrictEqual({
      ok: true,
      result: {
        state: "done",
        serverConverted: false,
        c2pa: { outcome: "not_detected", validation: "not_present" },
        synthid: { outcome: "detected" },
      },
    });
  });

  test("carries serverConverted into the parsed result", () => {
    const parsed = parseResponse(body([c2pa(), synthid()]), true);
    expect(parsed.ok && parsed.result.serverConverted).toBe(true);
  });
});

describe("parseProvenanceBody: nulls, order and unknown entries", () => {
  test("maps a null issuer, model and generated_at to absent, not the string null", () => {
    // toStrictEqual, not toEqual: a key assigned undefined slips past a loose
    // comparison and is still a phantom field in the stored result.
    expect(parseResponse(body([c2pa(), synthid()]), false)).toStrictEqual({
      ok: true,
      result: {
        state: "done",
        serverConverted: false,
        c2pa: { outcome: "detected", validation: "trusted" },
        synthid: { outcome: "not_detected" },
      },
    });
  });

  test("a synthid entry that reports a model and time keeps them", () => {
    // "model and generated_at provide the generating model and generation time
    // when available" — the real responses have nulls, so this shape is the one
    // an untested branch would drop.
    const entry = synthid({ outcome: "detected", model: "SynthID", generated_at: "2026-05-20T00:00:00Z" });
    const parsed = parseResponse(body([c2pa(), entry]), false);
    expect(parsed.ok && parsed.result.synthid).toStrictEqual({
      outcome: "detected",
      model: "SynthID",
      generatedAt: "2026-05-20T00:00:00Z",
    });
  });

  test("finds the entries by type, not by array position", () => {
    const forward = parseResponse(body([c2pa(), synthid()]), false);
    const reversed = parseResponse(body([synthid(), c2pa()]), false);
    expect(reversed).toStrictEqual(forward);
  });

  test("ignores an unknown result type", () => {
    const parsed = parseResponse(body([c2pa(), synthid(), { type: "future_signal", outcome: "detected" }]), false);
    expect(parsed.ok).toBe(true);
  });

  test("an unknown outcome is bad_response", () => {
    expect(parseResponse(body([c2pa({ outcome: "partial" }), synthid()]), false)).toEqual({
      ok: false,
      error: { code: "bad_response" },
    });
  });

  test("an unknown validation_state is bad_response", () => {
    expect(parseResponse(body([c2pa({ validation_state: "unclear" }), synthid()]), false)).toEqual({
      ok: false,
      error: { code: "bad_response" },
    });
  });
});

describe("parseProvenanceBody: validation_state", () => {
  // The verdict rule keys on trusted and valid (trusted/valid can be an AI
  // signal; invalid cannot), so every documented value must survive parsing.
  test("parses each documented validation_state", () => {
    for (const state of ["trusted", "valid", "invalid", "not_present"] as const) {
      const parsed = parseResponse(body([c2pa({ validation_state: state }), synthid()]), false);
      expect(parsed.ok && parsed.result.c2pa.validation, state).toBe(state);
    }
  });

  test("an absent validation_state leaves validation absent", () => {
    const entry = c2pa();
    delete entry.validation_state;
    expect(parseResponse(body([entry, synthid()]), false)).toStrictEqual({
      ok: true,
      result: {
        state: "done",
        serverConverted: false,
        c2pa: { outcome: "detected" },
        synthid: { outcome: "not_detected" },
      },
    });
  });

  test("a null validation_state leaves validation absent", () => {
    const parsed = parseResponse(body([c2pa({ validation_state: null }), synthid()]), false);
    expect(parsed).toStrictEqual({
      ok: true,
      result: {
        state: "done",
        serverConverted: false,
        c2pa: { outcome: "detected" },
        synthid: { outcome: "not_detected" },
      },
    });
  });

  test("the issuer of a third-party manifest is still read when not detected", () => {
    // The docs: a non-OpenAI manifest gives not_detected but issuer and
    // validation_state still describe it.
    const entry = c2pa({ outcome: "not_detected", validation_state: "valid", issuer: "Adobe Inc." });
    const parsed = parseResponse(body([entry, synthid()]), false);
    expect(parsed.ok && parsed.result.c2pa).toStrictEqual({
      outcome: "not_detected",
      validation: "valid",
      issuer: "Adobe Inc.",
    });
  });
});

describe("parseProvenanceBody: contract violations", () => {
  test("an image response without a synthid entry is bad_response", () => {
    expect(parseResponse(body([c2pa()]), false)).toEqual({ ok: false, error: { code: "bad_response" } });
  });

  test("an image response without a c2pa entry is bad_response", () => {
    expect(parseResponse(body([synthid()]), false)).toEqual({ ok: false, error: { code: "bad_response" } });
  });

  test("a body with no results array is bad_response", () => {
    expect(parseResponse(JSON.stringify({ object: "content_provenance_check" }), false)).toEqual({
      ok: false,
      error: { code: "bad_response" },
    });
  });

  test("a non-JSON body is bad_response", () => {
    expect(parseResponse("<html>gateway</html>", false)).toEqual({ ok: false, error: { code: "bad_response" } });
  });

  test("a JSON body that is not an object is bad_response", () => {
    for (const json of ["null", "[]", "\"a string\"", "7"]) {
      expect(parseResponse(json, false), json).toEqual({ ok: false, error: { code: "bad_response" } });
    }
  });
});

describe("retryAfterSeconds", () => {
  test("reads delta-seconds", () => {
    expect(retryAfterSeconds("30")).toBe(30);
    expect(retryAfterSeconds(" 7 ")).toBe(7);
    // 1*DIGIT, so zero is legal and means "retry now".
    expect(retryAfterSeconds("0")).toBe(0);
  });

  test("an HTTP-date is not a number of seconds", () => {
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
  });

  test("an absent or empty header is undefined", () => {
    expect(retryAfterSeconds(null)).toBeUndefined();
    expect(retryAfterSeconds("")).toBeUndefined();
    expect(retryAfterSeconds("   ")).toBeUndefined();
  });

  test("a negative or fractional value is not accepted", () => {
    expect(retryAfterSeconds("-1")).toBeUndefined();
    expect(retryAfterSeconds("1.5")).toBeUndefined();
  });
});

describe("mapProvenanceError", () => {
  test("400 maps to http_400", () => {
    expect(mapHttpError(400, null)).toEqual({ code: "http_400" });
  });

  test("401 maps to http_401", () => {
    expect(mapHttpError(401, null)).toEqual({ code: "http_401" });
  });

  test("404 maps to http_404", () => {
    expect(mapHttpError(404, null)).toEqual({ code: "http_404" });
  });

  test("429 with Retry-After: 30 maps to rate_limited with retryAfterSec 30", () => {
    expect(mapHttpError(429, "30")).toEqual({ code: "rate_limited", retryAfterSec: 30 });
  });

  test("429 without Retry-After maps to rate_limited with no retryAfterSec", () => {
    expect(mapHttpError(429, null)).toStrictEqual({ code: "rate_limited" });
  });

  test("429 with an HTTP-date Retry-After maps to rate_limited without a number", () => {
    expect(mapHttpError(429, "Wed, 21 Oct 2026 07:28:00 GMT")).toStrictEqual({ code: "rate_limited" });
  });

  test("other 4xx maps to http_4xx", () => {
    expect(mapHttpError(403, null)).toEqual({ code: "http_4xx" });
    expect(mapHttpError(422, null)).toEqual({ code: "http_4xx" });
  });

  test("5xx maps to http_5xx", () => {
    expect(mapHttpError(500, null)).toEqual({ code: "http_5xx" });
    expect(mapHttpError(503, null)).toEqual({ code: "http_5xx" });
  });

  test("a success status is never mapped, so a caller that misuses it gets bad_response", () => {
    expect(mapHttpError(200, null)).toEqual({ code: "bad_response" });
  });
});

describe("sendProvenanceUpload", () => {
  const request = (): ReturnType<typeof buildRequest> => buildRequest(KEY, JPEG_BYTES, "image/jpeg");

  const failingFetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;

  // Respects the abort signal the client sets, so the deadline path is real.
  const hangingFetch = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as unknown as typeof fetch;

  const okFetch = (() =>
    Promise.resolve(new Response(fixtureBody("openai-iceland.json"), { status: 200 }))) as unknown as typeof fetch;

  test("a successful response is parsed", async () => {
    const parsed = await sendProvenanceUpload(request(), false, { fetchImpl: okFetch });
    expect(parsed.ok).toBe(true);
  });

  test("the caller's deadline wins, and the shared default applies otherwise", () => {
    expect(deadlineFor(5)).toBe(5);
    expect(deadlineFor()).toBe(FETCH_DEADLINE_MS);
  });

  test("a DOMException that is not an abort is still a network error", async () => {
    const odd = (() => Promise.reject(new DOMException("boom", "NetworkError"))) as unknown as typeof fetch;
    expect(await sendProvenanceUpload(request(), false, { fetchImpl: odd })).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  test("no timer is left pending once the response settles", async () => {
    // An uncleared timeout keeps the MV3 worker alive after the upload is done.
    vi.useFakeTimers();
    try {
      await sendProvenanceUpload(request(), false, { fetchImpl: okFetch });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a thrown fetch is a network error, never a result", async () => {
    expect(await sendProvenanceUpload(request(), false, { fetchImpl: failingFetch })).toEqual({
      ok: false,
      error: { code: "network" },
    });
  });

  test("an expired deadline is a timeout", async () => {
    const parsed = await sendProvenanceUpload(request(), false, { fetchImpl: hangingFetch, deadlineMs: 5 });
    expect(parsed).toEqual({ ok: false, error: { code: "timeout" } });
  });

  test("a non-2xx response maps to its error code", async () => {
    const rateLimited = (() => Promise.resolve(new Response("slow down", { status: 429, headers: { "retry-after": "9" } }))) as unknown as typeof fetch;
    expect(await sendProvenanceUpload(request(), false, { fetchImpl: rateLimited })).toEqual({
      ok: false,
      error: { code: "rate_limited", retryAfterSec: 9 },
    });
  });

  test("posts to the request's URL with the request's headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const spyFetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(fixtureBody("openai-iceland.json"), { status: 200 }));
    }) as unknown as typeof fetch;
    await sendProvenanceUpload(request(), false, { fetchImpl: spyFetch });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PROVENANCE_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });
});

describe("readProvenanceResponse", () => {
  test("a 200 parses the body", async () => {
    const response = new Response(fixtureBody("openai-iceland.json"), { status: 200 });
    const parsed = await readProvenanceResponse(response, false);
    expect(parsed.ok).toBe(true);
  });

  test("a 429 takes Retry-After from the header", async () => {
    const response = new Response("slow down", { status: 429, headers: { "retry-after": "12" } });
    expect(await readProvenanceResponse(response, false)).toEqual({
      ok: false,
      error: { code: "rate_limited", retryAfterSec: 12 },
    });
  });

  test("a 401 does not read the body as a result", async () => {
    const response = new Response(fixtureBody("openai-halloween.json"), { status: 401 });
    expect(await readProvenanceResponse(response, false)).toEqual({ ok: false, error: { code: "http_401" } });
  });

  test("a 200 with a malformed body is bad_response", async () => {
    const response = new Response("not json", { status: 200 });
    expect(await readProvenanceResponse(response, false)).toEqual({ ok: false, error: { code: "bad_response" } });
  });

  test("only 2xx counts as success, so a 3xx is not read as a body", async () => {
    const response = new Response(fixtureBody("openai-iceland.json"), { status: 300 });
    expect(await readProvenanceResponse(response, false)).toEqual({ ok: false, error: { code: "bad_response" } });
  });

  test("a body that fails mid-read is a network error", async () => {
    const broken = {
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(new Error("connection lost")),
    } as unknown as Response;
    expect(await readProvenanceResponse(broken, false)).toEqual({ ok: false, error: { code: "network" } });
  });
});
