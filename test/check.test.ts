import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { runCheckSteps } from "../src/background/check";
import { getCheck, getResult, type CacheStore } from "../src/background/cache";
import { sha256Hex } from "../src/background/fetchImage";
import { scanXmp } from "../src/background/xmp";
import type { CheckResult, CheckUpdate, OpenAiAvailability, ReadBlobReply } from "../src/shared/types";
import { jpegWithXmpPacket, minimalPng } from "./helpers/images";

const WASM_BYTES = readFileSync("node_modules/@contentauth/c2pa-wasm/pkg/c2pa_bg.wasm");

// The context-menu click supplies all of these in the worker.
const POSITION = { frameUrl: "https://page.example/", tabId: 7, frameId: 0 };

// In-memory stand-in for chrome.storage.session (the real store is bound in index.ts).
function memoryStore() {
  const data = new Map<string, unknown>();
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

// Records every update the pipeline sends, in order.
function fakeUpdates() {
  const sent: CheckUpdate[] = [];
  return {
    sent,
    sendUpdate: (update: CheckUpdate) => {
      sent.push(update);
    },
  };
}

function fakeDeps(overrides: {
  fetchImpl?: typeof fetch;
  readC2pa?: typeof import("../src/background/c2pa").readC2pa;
  scanXmp?: typeof import("../src/background/xmp").scanXmp;
  store?: CacheStore;
  hasApiKey?: () => Promise<boolean>;
}) {
  const updates = fakeUpdates();
  const deps = {
    sendUpdate: updates.sendUpdate,
    readBlob: vi.fn(async (): Promise<ReadBlobReply> => ({ ok: false })),
    fetchImpl: overrides.fetchImpl,
    readC2pa:
      overrides.readC2pa ??
      (vi.fn(async () => ({ manifest: "absent", aiAction: false })) as unknown as typeof import("../src/background/c2pa").readC2pa),
    scanXmp: overrides.scanXmp ?? scanXmp,
    store: overrides.store ?? memoryStore().store,
    hasApiKey: overrides.hasApiKey ?? (async () => false),
    wasmSource: WASM_BYTES,
  };
  return { deps, updates };
}

function pngResponse(): Response {
  return new Response(new Uint8Array(minimalPng()), { status: 200 });
}

describe("runCheckSteps", () => {
  test("success path: fetch and C2PA once; checking then done", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const readC2pa = vi.fn(async () => ({ manifest: "absent", aiAction: false })) as unknown as typeof import("../src/background/c2pa").readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });
    expect(updates.sent.map((u) => u.status)).toEqual(["checking", "done"]);
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result.verdict).toBe("no_signal");
    expect(done.result.localC2pa).toEqual({ manifest: "absent", aiAction: false });
    expect(done.result.localXmp).toEqual({ state: "not_detected" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readC2pa).toHaveBeenCalledOnce();
  });

  test("fetch error sends failed", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const readC2pa = vi.fn() as unknown as typeof import("../src/background/c2pa").readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });
    expect(updates.sent.map((u) => u.status)).toEqual(["checking", "failed"]);
    const failed = updates.sent[1];
    if (failed.status !== "failed") throw new Error("expected failed");
    expect(failed.error.code).toBe("fetch_failed");
    expect(readC2pa).not.toHaveBeenCalled();
  });

  test("no key gives openai.available false with reason no_key", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const { deps, updates } = fakeDeps({ fetchImpl, hasApiKey: async () => false });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.openai).toEqual({ available: false, reason: "no_key" });
  });

  test("a stored key gives openai.available true", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const { deps, updates } = fakeDeps({ fetchImpl, hasApiKey: async () => true });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.openai).toEqual({ available: true } satisfies OpenAiAvailability);
  });

  test("halloween fixture through the real c2pa and verdict (fake fetch): verdict ai_signal", async () => {
    const fixture = new Uint8Array(readFileSync("test/fixtures/ai-test-halloween.png"));
    const fetchImpl = vi.fn(async () => new Response(fixture, { status: 200 }));
    const realReadC2pa = (await import("../src/background/c2pa")).readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa: realReadC2pa });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/halloween.png", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result.verdict).toBe("ai_signal");
    expect(done.result.localC2pa.claimedIssuer).toBe("OpenAI OpCo, LLC");
    expect(done.result.localC2pa.claimedModel).toBe("ChatGPT / gpt-image");
  });

  test("iceland fixture: verdict no_signal", async () => {
    const fixture = new Uint8Array(readFileSync("test/fixtures/ai-tes-iceland.jpg"));
    const fetchImpl = vi.fn(async () => new Response(fixture, { status: 200 }));
    const realReadC2pa = (await import("../src/background/c2pa")).readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa: realReadC2pa });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/iceland.jpg", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result.verdict).toBe("no_signal");
  });

  test("awaits an asynchronous sendUpdate so the terminal update lands before the pipeline resolves", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const { deps } = fakeDeps({ fetchImpl });
    const delivered: string[] = [];
    deps.sendUpdate = async (update: CheckUpdate) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      delivered.push(update.status);
    };
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });
    expect(delivered).toEqual(["checking", "done"]);
  });

  test("a C2PA read error gives verdict incomplete, not no_signal", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const readC2pa = vi.fn(async () => ({ manifest: "error", aiAction: false })) as unknown as typeof import("../src/background/c2pa").readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result.verdict).toBe("incomplete");
  });
});

describe("runCheckSteps: XMP (#20)", () => {
  const TRAINED = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

  test("an image with only an XMP DigitalSourceType gives verdict ai_signal", async () => {
    const packet = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description Iptc4xmpExt:DigitalSourceType="${TRAINED}"/></rdf:RDF></x:xmpmeta>`;
    const bytes = jpegWithXmpPacket(packet);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 }));
    const readC2pa = vi.fn(async () => ({ manifest: "absent", aiAction: false })) as unknown as typeof import("../src/background/c2pa").readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa, scanXmp });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/x.jpg", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result.verdict).toBe("ai_signal");
    expect(done.result.localXmp.state).toBe("detected");
  });

  test("XMP is scanned on the same bytes as C2PA, and a generator hint alone stays no_signal", async () => {
    const packet = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreatorTool="ChatGPT"/></rdf:RDF></x:xmpmeta>`;
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(jpegWithXmpPacket(packet)), { status: 200 }));
    const readC2pa = vi.fn(async () => ({ manifest: "absent", aiAction: false })) as unknown as typeof import("../src/background/c2pa").readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa, scanXmp });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/x.jpg", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result.localXmp.generatorHint).toBe("ChatGPT");
    expect(done.result.verdict).toBe("no_signal");
  });

  test("a local XMP error gives verdict incomplete", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const scanXmpError = vi.fn(() => ({ state: "error" as const }));
    const { deps, updates } = fakeDeps({ fetchImpl, scanXmp: scanXmpError });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result.verdict).toBe("incomplete");
  });
});

describe("runCheckSteps: cache (#20)", () => {
  test("success stores the result under result:<hash> and the check record under check:<id>", async () => {
    const { store, sets } = memoryStore();
    const fetchImpl = vi.fn(async () => pngResponse());
    const { deps } = fakeDeps({ fetchImpl, store });
    const hash = await sha256Hex(minimalPng());
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });

    const resultEntry = sets.find((s) => s.key === `result:${hash}`);
    const checkEntry = sets.find((s) => s.key === "check:c1");
    expect(resultEntry).toBeDefined();
    expect(checkEntry).toBeDefined();
    expect(resultEntry!.value).toMatchObject({ imageHash: hash, mediaType: "image/png" });
    expect(checkEntry!.value).toEqual({
      checkId: "c1",
      srcUrl: "https://page.example/i.png",
      frameUrl: POSITION.frameUrl,
      tabId: POSITION.tabId,
      frameId: POSITION.frameId,
      imageHash: hash,
      mediaType: "image/png",
      size: minimalPng().length,
    });
  });

  test("a cache hit skips both local checks and returns the cached result", async () => {
    const { store } = memoryStore();
    const hash = await sha256Hex(minimalPng());
    const cached: CheckResult = {
      imageHash: hash,
      mediaType: "image/png",
      verdict: "ai_signal",
      localC2pa: { manifest: "present", aiAction: true, claimedIssuer: "OpenAI OpCo, LLC" },
      localXmp: { state: "not_detected" },
      openai: { state: "not_checked" },
    };
    await store.set(`result:${hash}`, cached);

    const fetchImpl = vi.fn(async () => pngResponse());
    const readC2pa = vi.fn() as unknown as typeof import("../src/background/c2pa").readC2pa;
    const scanXmpSpy = vi.fn();
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa, scanXmp: scanXmpSpy, store });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });

    expect(readC2pa).not.toHaveBeenCalled();
    expect(scanXmpSpy).not.toHaveBeenCalled();
    // The bytes are still needed to compute the hash that identifies the image.
    expect(fetchImpl).toHaveBeenCalledOnce();
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result).toEqual(cached);
  });

  test("a fetch error stores nothing", async () => {
    const { store, sets } = memoryStore();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const { deps, updates } = fakeDeps({ fetchImpl, store });
    await runCheckSteps(deps, { ...POSITION, srcUrl: "https://page.example/i.png", checkId: "c1" });
    expect(updates.sent.map((u) => u.status)).toEqual(["checking", "failed"]);
    expect(sets).toEqual([]);
  });

  test("the check record is stored before the done update, on the payload-free data: URL", async () => {
    const { store, sets } = memoryStore();
    const png = minimalPng();
    // A real data: image so collectImage takes the data: path (not fetch).
    const dataUrl = "data:image/png;base64," + Buffer.from(png).toString("base64");
    const fetchImpl = vi.fn(async () => pngResponse());
    const { deps } = fakeDeps({ fetchImpl, store });
    await runCheckSteps(deps, { ...POSITION, srcUrl: dataUrl, checkId: "c1" });
    const checkEntry = sets.find((s) => s.key === "check:c1")!;
    expect((checkEntry.value as { srcUrl: string }).srcUrl).toBe("data:image/png;base64,");
    expect(JSON.stringify(checkEntry.value)).not.toContain(Buffer.from(png).toString("base64").slice(0, 40));
    expect(await getCheck(store, "c1")).toEqual(checkEntry.value);
    expect(await getResult(store, await sha256Hex(png))).toBeDefined();
  });
});
