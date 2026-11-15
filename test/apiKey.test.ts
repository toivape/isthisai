import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { isOptionsPageSender, keyStatus, testKey, type TestKeyDeps } from "../src/background/apiKey";
import { readC2pa } from "../src/background/c2pa";
import { sniffMediaType } from "../src/background/sniff";
import { scanXmp } from "../src/background/xmp";

// Not key-shaped on purpose: no real or plausible key value appears in tests.
const KEY = "placeholder-not-a-key";
const WASM_BYTES = readFileSync("node_modules/@contentauth/c2pa-wasm/pkg/c2pa_bg.wasm");
const SAMPLE = new Uint8Array(readFileSync("src/assets/sample.png"));

function deps(overrides: Partial<TestKeyDeps> = {}): TestKeyDeps {
  return {
    readKey: async () => KEY,
    loadSample: async () => SAMPLE,
    fetchImpl: async () => new Response(null, { status: 200 }),
    ...overrides,
  };
}

function okBody(): Response {
  return new Response(
    JSON.stringify({ object: "content_provenance_check", created_at: 1, results: [
      { type: "c2pa", outcome: "not_detected", validation_state: "not_present", issuer: null, model: null, generated_at: null },
      { type: "synthid", outcome: "not_detected", model: null, generated_at: null },
    ] }),
    { status: 200 },
  );
}

describe("keyStatus", () => {
  test("reports a stored key as present without returning it", async () => {
    const reply = await keyStatus({ readKey: async () => KEY });
    expect(reply).toEqual({ hasKey: true });
    // The reply shape has no field that could carry the key (hard rule 3).
    expect(JSON.stringify(reply)).not.toContain(KEY);
  });

  test("reports an absent or empty key as absent", async () => {
    expect(await keyStatus({ readKey: async () => undefined })).toEqual({ hasKey: false });
    expect(await keyStatus({ readKey: async () => "" })).toEqual({ hasKey: false });
  });
});

describe("testKey", () => {
  test("a stored key that produces a 200 gives ok", async () => {
    expect(await testKey(deps({ fetchImpl: async () => okBody() }))).toEqual({ ok: true });
  });

  test("no stored key gives no_key and uploads nothing", async () => {
    const fetchImpl = vi.fn();
    const reply = await testKey(deps({ readKey: async () => undefined, fetchImpl }));
    expect(reply).toEqual({ ok: false, error: { code: "no_key" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("an empty stored key is no_key, not an unusable one", async () => {
    // "" would otherwise reach buildRequest and come back as invalid_key, telling
    // the user to re-save a key they never had.
    const fetchImpl = vi.fn();
    expect(await testKey(deps({ readKey: async () => "", fetchImpl }))).toEqual({ ok: false, error: { code: "no_key" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a key that cannot be sent gives invalid_key and uploads nothing", async () => {
    const fetchImpl = vi.fn();
    const reply = await testKey(deps({ readKey: async () => "bad\nkey", fetchImpl }));
    expect(reply).toEqual({ ok: false, error: { code: "invalid_key" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a sample that is not an accepted image gives unsupported_type and uploads nothing", async () => {
    const fetchImpl = vi.fn();
    const garbage = await testKey(deps({ loadSample: async () => new Uint8Array([1, 2, 3]), fetchImpl }));
    expect(garbage).toEqual({ ok: false, error: { code: "unsupported_type" } });
    // AVIF sniffs fine but OpenAI will not take it, and this path has no server
    // conversion, so it must be refused here rather than sent to fail as a 400.
    const avif = new Uint8Array(32);
    avif.set(new TextEncoder().encode("ftypavif"), 4);
    expect(await testKey(deps({ loadSample: async () => avif, fetchImpl }))).toEqual({
      ok: false,
      error: { code: "unsupported_type" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("sends the sample, sniffed by magic bytes, as one multipart file", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return okBody();
    }) as unknown as typeof fetch;
    await testKey(deps({ fetchImpl }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/content_provenance_checks");
    expect(calls[0].init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    const body = calls[0].init.body as FormData;
    expect([...body.keys()]).toEqual(["file"]);
    expect((body.get("file") as File).type).toBe("image/png");
    expect((body.get("file") as File).name).toBe("image.png");
  });

  test("maps the HTTP statuses the options page shows", async () => {
    const status = (code: number, headers: Record<string, string> = {}) =>
      deps({ fetchImpl: (async () => new Response("nope", { status: code, headers })) as unknown as typeof fetch });
    expect(await testKey(status(401))).toEqual({ ok: false, error: { code: "http_401" } });
    expect(await testKey(status(404))).toEqual({ ok: false, error: { code: "http_404" } });
    expect(await testKey(status(400))).toEqual({ ok: false, error: { code: "http_400" } });
    expect(await testKey(status(500))).toEqual({ ok: false, error: { code: "http_5xx" } });
    expect(await testKey(status(429, { "retry-after": "30" }))).toEqual({
      ok: false,
      error: { code: "rate_limited", retryAfterSec: 30 },
    });
    expect(await testKey(status(429))).toStrictEqual({ ok: false, error: { code: "rate_limited" } });
  });

  test("maps a thrown fetch and a malformed body", async () => {
    const failing = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    expect(await testKey(deps({ fetchImpl: failing }))).toEqual({ ok: false, error: { code: "network" } });
    const malformed = (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;
    expect(await testKey(deps({ fetchImpl: malformed }))).toEqual({ ok: false, error: { code: "bad_response" } });
  });

  test("reads the key once and puts it only in the Authorization header", async () => {
    const readKey = vi.fn(async () => KEY);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return okBody();
    }) as unknown as typeof fetch;
    await testKey(deps({ readKey, fetchImpl }));
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(calls[0].url).not.toContain(KEY);
    const file = (calls[0].init.body as FormData).get("file") as File;
    expect(await file.text()).not.toContain(KEY);
  });
});

describe("the bundled sample", () => {
  test("is a PNG that carries no provenance at all", async () => {
    // The test-key button uploads this instead of the user's image, so it must
    // not carry a C2PA manifest or XMP metadata of its own.
    expect(sniffMediaType(SAMPLE)).toBe("image/png");
    expect(scanXmp(SAMPLE)).toEqual({ state: "not_detected" });
    expect(await readC2pa("image/png", SAMPLE, WASM_BYTES)).toEqual({ manifest: "absent", aiAction: false });
  });
});

describe("isOptionsPageSender", () => {
  const PREFIX = "chrome-extension://abc/src/options/";

  test("accepts the extension's own options page, in a tab or not", () => {
    // options_ui with open_in_tab: false is hosted inside the chrome://extensions
    // tab, so a tab-bearing sender is still the real options page: the URL
    // decides, not the tab (Chrome's MessageSender docs). Other sender fields are
    // simply ignored.
    const inTab = { url: `${PREFIX}options.html`, tab: { id: 1 } };
    expect(isOptionsPageSender({ url: `${PREFIX}options.html` }, PREFIX)).toBe(true);
    expect(isOptionsPageSender(inTab, PREFIX)).toBe(true);
  });

  test("refuses an injected content script, whose sender URL is the page's", () => {
    // This is what stops a script in a page from spending the stored key on an
    // upload nobody confirmed (PLAN §5, §6).
    const contentScript = { url: "https://page.example/", tab: { id: 1 } };
    expect(isOptionsPageSender(contentScript, PREFIX)).toBe(false);
  });

  test("refuses other extension pages, other extensions, and anything else", () => {
    expect(isOptionsPageSender({ url: "chrome-extension://abc/src/confirm/confirm.html" }, PREFIX)).toBe(false);
    expect(isOptionsPageSender({ url: "chrome-extension://other/src/options/options.html" }, PREFIX)).toBe(false);
    expect(isOptionsPageSender({}, PREFIX)).toBe(false);
  });
});
