import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { runCheckSteps } from "../src/background/check";
import type { CheckUpdate, OpenAiAvailability, ReadBlobReply } from "../src/shared/types";
import { minimalPng } from "./helpers/images";

const WASM_BYTES = readFileSync("node_modules/@contentauth/c2pa-wasm/pkg/c2pa_bg.wasm");

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
  hasApiKey?: () => Promise<boolean>;
}) {
  const updates = fakeUpdates();
  const calls = {
    collect: 0,
    c2pa: 0,
    verdict: 0,
  };
  const deps = {
    sendUpdate: updates.sendUpdate,
    readBlob: vi.fn(async (): Promise<ReadBlobReply> => ({ ok: false })),
    fetchImpl: overrides.fetchImpl,
    readC2pa:
      overrides.readC2pa ??
      (vi.fn(async () => ({ manifest: "absent", aiAction: false })) as unknown as typeof import("../src/background/c2pa").readC2pa),
    hasApiKey: overrides.hasApiKey ?? (async () => false),
    wasmSource: WASM_BYTES,
    now: () => new Date(),
  };
  return { deps, updates, calls };
}

function pngResponse(): Response {
  return new Response(new Uint8Array(minimalPng()), { status: 200 });
}

describe("runCheckSteps", () => {
  test("success path: fetch, C2PA, verdict once; checking then done", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const readC2pa = vi.fn(async () => ({ manifest: "absent", aiAction: false })) as unknown as typeof import("../src/background/c2pa").readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa });
    await runCheckSteps(deps, { srcUrl: "https://page.example/i.png", checkId: "c1" });
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
    await runCheckSteps(deps, { srcUrl: "https://page.example/i.png", checkId: "c1" });
    expect(updates.sent.map((u) => u.status)).toEqual(["checking", "failed"]);
    const failed = updates.sent[1];
    if (failed.status !== "failed") throw new Error("expected failed");
    expect(failed.error.code).toBe("fetch_failed");
    expect(readC2pa).not.toHaveBeenCalled();
  });

  test("no key gives openai.available false with reason no_key", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const { deps, updates } = fakeDeps({ fetchImpl, hasApiKey: async () => false });
    await runCheckSteps(deps, { srcUrl: "https://page.example/i.png", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.openai).toEqual({ available: false, reason: "no_key" });
  });

  test("a stored key gives openai.available true", async () => {
    const fetchImpl = vi.fn(async () => pngResponse());
    const { deps, updates } = fakeDeps({ fetchImpl, hasApiKey: async () => true });
    await runCheckSteps(deps, { srcUrl: "https://page.example/i.png", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.openai).toEqual({ available: true } satisfies OpenAiAvailability);
  });

  test("halloween fixture through the real c2pa and verdict (fake fetch): verdict ai_signal", async () => {
    const fixture = new Uint8Array(readFileSync("test/fixtures/ai-test-halloween.png"));
    const fetchImpl = vi.fn(async () => new Response(fixture, { status: 200 }));
    const realReadC2pa = (await import("../src/background/c2pa")).readC2pa;
    const { deps, updates } = fakeDeps({ fetchImpl, readC2pa: realReadC2pa });
    await runCheckSteps(deps, { srcUrl: "https://page.example/halloween.png", checkId: "c1" });
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
    await runCheckSteps(deps, { srcUrl: "https://page.example/iceland.jpg", checkId: "c1" });
    const done = updates.sent[1];
    if (done.status !== "done") throw new Error("expected done");
    expect(done.result.verdict).toBe("no_signal");
  });
});
