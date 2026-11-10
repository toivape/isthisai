import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { readC2pa, mapC2paError, mapC2paStore } from "../src/background/c2pa";
import type { LocalC2pa } from "../src/shared/types";
import { minimalGif, minimalWebp, pngWithXmpProvenance } from "./helpers/images";

const CTX_GATE = '{"verify":{"remote_manifest_fetch":false,"ocsp_fetch":false}}';
const WASM_BYTES = readFileSync("node_modules/@contentauth/c2pa-wasm/pkg/c2pa_bg.wasm");

// Tests init the wasm from raw bytes, so the glue never calls fetch: any fetch
// at all — including the wasm URL — means the remote-fetch gate failed.
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    throw new Error(`test forbids fetch: ${String(input)}`);
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`test/fixtures/${name}`));
}

const TRAINED = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const COMPOSITE = "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia";
const ALGORITHMIC = "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia";
const COMPOSITE_SYNTHETIC = "http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic";

// ---- store builders for the mapping tests (shapes verified against real
// reader output; see PLAN §2 and the c2pa-rs 0.91.7 serde structs) ----

interface Action {
  action?: string;
  when?: string;
  softwareAgent?: unknown;
  digitalSourceType?: string;
}

function manifest(opts: {
  label: string;
  actions?: Action[];
  ingredients?: unknown[];
  signatureInfo?: Record<string, unknown>;
}): Record<string, unknown> {
  const assertions = [];
  if (opts.actions) {
    assertions.push({ label: "c2pa.actions.v2", data: { actions: opts.actions } });
  }
  const m: Record<string, unknown> = {
    label: opts.label,
    title: opts.label,
    claim_version: 2,
    claim_generator_info: [{ name: "test" }],
    assertions,
  };
  if (opts.signatureInfo) m.signature_info = opts.signatureInfo;
  if (opts.ingredients) m.ingredients = opts.ingredients;
  return m;
}

function store(activeLabel: string, manifests: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    active_manifest: activeLabel,
    manifests,
    validation_status: [],
    validation_results: { activeManifest: { success: [], informational: [], failure: [] } },
    validation_state: "Valid",
  };
}

// v3 ingredient: active_manifest + validation_results, as the reader emits
// for an ingredient whose own manifest is in the store (see CACA.jpg).
function v3Ingredient(ingManifestLabel: string, ingredientValidation: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "ing",
    format: "image/jpeg",
    relationship: "parentOf",
    active_manifest: ingManifestLabel,
    validation_results: ingredientValidation,
  };
}

const validatedResults = {
  activeManifest: {
    success: [
      { code: "claimSignature.validated" },
      { code: "claimSignature.insideValidity" },
    ],
    informational: [],
    failure: [],
  },
};

const failedResults = {
  activeManifest: {
    success: [{ code: "claimSignature.validated" }],
    informational: [],
    failure: [{ code: "claimSignature.mismatch" }],
  },
};

const untrustedButValidResults = {
  activeManifest: {
    success: [
      { code: "claimSignature.validated" },
      { code: "claimSignature.insideValidity" },
    ],
    informational: [],
    failure: [{ code: "signingCredential.untrusted" }],
  },
};

// ---- pure mapping ----

describe("mapC2paStore", () => {
  test("present + AI action in the active manifest", () => {
    const s = store("m", {
      m: manifest({
        label: "m",
        actions: [{ action: "c2pa.created", when: "2026-01-01T00:00:00Z", softwareAgent: { name: "ChatGPT", version: "gpt-image" }, digitalSourceType: TRAINED }],
        signatureInfo: { issuer: "OpenAI OpCo, LLC" },
      }),
    });
    expect(mapC2paStore(s)).toEqual({
      manifest: "present",
      aiAction: true,
      claimedIssuer: "OpenAI OpCo, LLC",
      claimedModel: "ChatGPT / gpt-image",
      generatedAt: "2026-01-01T00:00:00Z",
    } satisfies LocalC2pa);
  });

  test("string softwareAgent is used as is for claimedModel", () => {
    const s = store("m", {
      m: manifest({
        label: "m",
        actions: [{ action: "c2pa.created", softwareAgent: "Acme Imager 2.1" }],
      }),
    });
    expect(mapC2paStore(s).claimedModel).toBe("Acme Imager 2.1");
  });

  test("actions in a non-C2PA assertion are ignored", () => {
    const m = manifest({ label: "m", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] });
    (m.assertions as { label: string }[])[0].label = "com.example.custom";
    expect(mapC2paStore(store("m", { m }))).toMatchObject({ manifest: "present", aiAction: false });
    expect(mapC2paStore(store("m", { m })).claimedModel).toBeUndefined();
  });

  test("camera manifest without AI actions", () => {
    const s = store("m", {
      m: manifest({
        label: "m",
        actions: [{ action: "c2pa.created", when: "2026-01-01T00:00:00Z" }],
        signatureInfo: { issuer: "Canon Inc." },
      }),
    });
    expect(mapC2paStore(s)).toEqual({
      manifest: "present",
      aiAction: false,
      claimedIssuer: "Canon Inc.",
      generatedAt: "2026-01-01T00:00:00Z",
    } satisfies LocalC2pa);
  });

  test("AI action in a referenced, validated ingredient", () => {
    const s = store("parent", {
      parent: manifest({
        label: "parent",
        ingredients: [v3Ingredient("child", validatedResults)],
      }),
      child: manifest({
        label: "child",
        actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }],
      }),
    });
    expect(mapC2paStore(s)).toMatchObject({ manifest: "present", aiAction: true });
  });

  test("AI action only in an ingredient whose validation failed", () => {
    const s = store("parent", {
      parent: manifest({
        label: "parent",
        ingredients: [v3Ingredient("child", failedResults)],
      }),
      child: manifest({
        label: "child",
        actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }],
      }),
    });
    expect(mapC2paStore(s)).toMatchObject({ manifest: "present", aiAction: false });
  });

  test("ingredient with a failure in ingredientDeltas contributes nothing", () => {
    const withDelta = {
      activeManifest: validatedResults.activeManifest,
      ingredientDeltas: [{ ingredientAssertionURI: "x", validationDeltas: { failure: [{ code: "assertion.dataHash.mismatch" }] } }],
    };
    const s = store("parent", {
      parent: manifest({ label: "parent", ingredients: [v3Ingredient("child", withDelta)] }),
      child: manifest({ label: "child", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }),
    });
    expect(mapC2paStore(s)).toMatchObject({ manifest: "present", aiAction: false });
  });

  test("untrusted-but-valid ingredient counts as validated (no trust list shipped)", () => {
    const s = store("parent", {
      parent: manifest({
        label: "parent",
        ingredients: [v3Ingredient("child", untrustedButValidResults)],
      }),
      child: manifest({
        label: "child",
        actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }],
      }),
    });
    expect(mapC2paStore(s)).toMatchObject({ manifest: "present", aiAction: true });
  });

  test("digitalSourceType suffixes: composite true, algorithmic and compositeSynthetic false", () => {
    const mk = (dst: string) =>
      store("m", { m: manifest({ label: "m", actions: [{ action: "c2pa.created", digitalSourceType: dst }] }) });
    expect(mapC2paStore(mk(COMPOSITE))).toMatchObject({ manifest: "present", aiAction: true });
    expect(mapC2paStore(mk(ALGORITHMIC))).toMatchObject({ manifest: "present", aiAction: false });
    expect(mapC2paStore(mk(COMPOSITE_SYNTHETIC)).aiAction).toBe(false);
  });

  test("Invalid validation_state maps to invalid", () => {
    const s = {
      ...store("m", { m: manifest({ label: "m", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }) }),
      validation_state: "Invalid",
    };
    expect(mapC2paStore(s)).toMatchObject({ manifest: "invalid", aiAction: true });
  });
});

describe("mapC2paError", () => {
  test("JumbfNotFound → absent", () => {
    expect(mapC2paError("C2pa(JumbfNotFound)")).toEqual<LocalC2pa>({ manifest: "absent", aiAction: false });
  });

  test("RemoteManifestUrl → remote_unfetched", () => {
    expect(mapC2paError('C2pa(RemoteManifestUrl("https://attacker.example/m.c2pa"))')).toEqual<LocalC2pa>({
      manifest: "remote_unfetched",
      aiAction: false,
    });
  });

  test("marker words inside a RemoteManifestUrl payload do not change the mapping", () => {
    expect(mapC2paError('C2pa(RemoteManifestUrl("https://example.test/JumbfNotFound"))')).toEqual<LocalC2pa>({
      manifest: "remote_unfetched",
      aiAction: false,
    });
  });

  test("other errors → error", () => {
    expect(mapC2paError('C2pa(InvalidAsset("PNG out of range"))')).toEqual<LocalC2pa>({ manifest: "error", aiAction: false });
    expect(mapC2paError("C2pa(IoError(...))")).toEqual<LocalC2pa>({ manifest: "error", aiAction: false });
    expect(mapC2paError(new Error("boom"))).toEqual<LocalC2pa>({ manifest: "error", aiAction: false });
  });
});

// ---- readC2pa: real wasm against fixtures and built containers ----

describe("readC2pa", () => {
  test("wasm init failure → error result, and a later call retries", async () => {
    vi.resetModules();
    const fresh = await import("../src/background/c2pa");
    expect(await fresh.readC2pa("image/png", fixture("ai-test-halloween.png"), new Uint8Array(4))).toEqual<LocalC2pa>({
      manifest: "error",
      aiAction: false,
    });
    expect(await fresh.readC2pa("image/jpeg", fixture("ai-tes-iceland.jpg"), WASM_BYTES)).toEqual<LocalC2pa>({
      manifest: "absent",
      aiAction: false,
    });
  });

  test("halloween fixture: present, AI action, claimed issuer and model", async () => {
    const result = await readC2pa("image/png", fixture("ai-test-halloween.png"), WASM_BYTES);
    expect(result).toEqual({
      manifest: "present",
      aiAction: true,
      claimedIssuer: "OpenAI OpCo, LLC",
      claimedModel: "ChatGPT / gpt-image",
      generatedAt: "2026-10-31T12:38:51.498118131Z",
    } satisfies LocalC2pa);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("iceland fixture: absent", async () => {
    const result = await readC2pa("image/jpeg", fixture("ai-tes-iceland.jpg"), WASM_BYTES);
    expect(result).toEqual<LocalC2pa>({ manifest: "absent", aiAction: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("resaved JPEG: absent", async () => {
    const result = await readC2pa("image/jpeg", fixture("ai-test-halloween-resaved.jpg"), WASM_BYTES);
    expect(result).toEqual<LocalC2pa>({ manifest: "absent", aiAction: false });
  });

  test("PNG with a remote-manifest XMP reference: remote_unfetched, no fetch", async () => {
    const result = await readC2pa("image/png", pngWithXmpProvenance("https://attacker.example/manifest.c2pa"), WASM_BYTES);
    expect(result).toEqual<LocalC2pa>({ manifest: "remote_unfetched", aiAction: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("truncated PNG: error", async () => {
    const result = await readC2pa("image/png", new Uint8Array(20), WASM_BYTES);
    expect(result).toEqual<LocalC2pa>({ manifest: "error", aiAction: false });
  });

  test("WebP and GIF without a manifest: absent", async () => {
    expect(await readC2pa("image/webp", minimalWebp(), WASM_BYTES)).toEqual<LocalC2pa>({ manifest: "absent", aiAction: false });
    expect(await readC2pa("image/gif", minimalGif(), WASM_BYTES)).toEqual<LocalC2pa>({ manifest: "absent", aiAction: false });
  });
});
