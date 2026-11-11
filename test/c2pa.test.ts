import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, test, vi, type MockInstance } from "vitest";
import { readC2pa, mapC2paError, mapC2paStore } from "../src/background/c2pa";
import type { LocalC2pa } from "../src/shared/types";
import { minimalGif, minimalWebp, pngWithXmpProvenance } from "./helpers/images";

const WASM_BYTES = readFileSync("node_modules/@contentauth/c2pa-wasm/pkg/c2pa_bg.wasm");

// Tests init the wasm from raw bytes, so the glue never calls fetch: any fetch
// at all — including the wasm URL — means the remote-fetch gate failed.
let fetchSpy: MockInstance<typeof globalThis.fetch>;

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const target = input instanceof Request ? input.url : String(input);
    throw new Error(`test forbids fetch: ${target}`);
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
  assertionLabel?: string;
  assertionData?: unknown;
}): Record<string, unknown> {
  const assertions = [];
  if (opts.actions) {
    assertions.push({ label: opts.assertionLabel ?? "c2pa.actions.v2", data: { actions: opts.actions } });
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

  test("an ingredient referencing its own manifest is not followed forever (cyclic guard)", () => {
    // "parent" lists itself as an ingredient whose own manifest is "parent";
    // the visited set must stop the recursion instead of looping.
    const parent = manifest({
      label: "parent",
      actions: [{ action: "c2pa.created" }],
      ingredients: [v3Ingredient("parent", validatedResults)],
    });
    expect(mapC2paStore(store("parent", { parent })).aiAction).toBe(false);
  });

  test("an ingredient referencing an unknown manifest label contributes nothing", () => {
    const s = store("parent", {
      parent: manifest({ label: "parent", ingredients: [v3Ingredient("missing", validatedResults)] }),
    });
    expect(mapC2paStore(s).aiAction).toBe(false);
  });

  test("ingredient validation with a non-object activeManifest does not count as passed", () => {
    const s = store("parent", {
      parent: manifest({ label: "parent", ingredients: [v3Ingredient("child", { activeManifest: "x" })] }),
      child: manifest({ label: "child", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }),
    });
    expect(mapC2paStore(s).aiAction).toBe(false);
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

  test("Trusted validation_state also maps to present", () => {
    const s = {
      ...store("m", { m: manifest({ label: "m", actions: [{ action: "c2pa.created" }] }) }),
      validation_state: "Trusted",
    };
    expect(mapC2paStore(s).manifest).toBe("present");
  });

  test("a missing or non-string active_manifest is an error", () => {
    expect(mapC2paStore({ manifests: {}, validation_state: "Valid" })).toEqual({ manifest: "error", aiAction: false });
    expect(mapC2paStore({ active_manifest: 5, manifests: {}, validation_state: "Valid" })).toEqual({
      manifest: "error",
      aiAction: false,
    });
  });

  test("a non-object manifests value or active manifest is an error", () => {
    expect(mapC2paStore({ active_manifest: "m", manifests: "x", validation_state: "Valid" })).toEqual({
      manifest: "error",
      aiAction: false,
    });
    expect(mapC2paStore({ active_manifest: "m", manifests: { m: "x" }, validation_state: "Valid" })).toEqual({
      manifest: "error",
      aiAction: false,
    });
    // JSON.parse can yield null; the isObject guard must catch it before the
    // label lookup would throw on null.
    expect(mapC2paStore({ active_manifest: "m", manifests: null, validation_state: "Valid" })).toEqual({
      manifest: "error",
      aiAction: false,
    });
  });

  test("non-object store / non-object JSON is an error", () => {
    expect(mapC2paStore(null)).toEqual({ manifest: "error", aiAction: false });
    expect(mapC2paStore("nope")).toEqual({ manifest: "error", aiAction: false });
    expect(mapC2paStore([])).toEqual({ manifest: "error", aiAction: false });
  });

  test("an unknown validation_state is invalid, not present", () => {
    const s = { ...store("m", { m: manifest({ label: "m" }) }), validation_state: "SomethingElse" };
    expect(mapC2paStore(s).manifest).toBe("invalid");
  });

  test("the action label accepts c2pa.actions, c2pa.actions.v2 and a numeric suffix", () => {
    for (const label of ["c2pa.actions", "c2pa.actions.v2", "c2pa.actions__1", "c2pa.actions.v2__42"]) {
      const m = manifest({ label: "m", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }], assertionLabel: label });
      expect(mapC2paStore(store("m", { m })), label).toMatchObject({ manifest: "present", aiAction: true });
    }
  });

  test("a similar but wrong action label is ignored", () => {
    for (const label of ["c2pa.actionsX", "xc2pa.actions", "c2pa.actions.v2.extra", "c2pa.actions__x"]) {
      const m = manifest({ label: "m", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }], assertionLabel: label });
      expect(mapC2paStore(store("m", { m })).aiAction, label).toBe(false);
    }
  });

  test("an assertion with non-object data or without an actions array is ignored", () => {
    const m = manifest({ label: "m" });
    (m.assertions as unknown[]).push({ label: "c2pa.actions", data: "x" });
    (m.assertions as unknown[]).push({ label: "c2pa.actions", data: { actions: "x" } });
    (m.assertions as unknown[]).push({ label: "c2pa.actions", data: { actions: [{ notAnAction: true }] } });
    (m.assertions as unknown[]).push({ label: "c2pa.actions" });
    (m.assertions as unknown[]).push(42);
    expect(mapC2paStore(store("m", { m }))).toMatchObject({ manifest: "present", aiAction: false });
  });

  test("non-object entries in an actions array are dropped", () => {
    // data.actions.filter(isObject): a null entry must not make actionsOf
    // throw when it later reads action.digitalSourceType.
    const m = manifest({ label: "m" });
    (m.assertions as unknown[]).push({
      label: "c2pa.actions",
      data: { actions: [null, "x", 7, { action: "c2pa.created", digitalSourceType: TRAINED }] },
    });
    expect(mapC2paStore(store("m", { m })).aiAction).toBe(true);
  });

  test("a manifest with no assertions array has no AI action", () => {
    const m = manifest({ label: "m" });
    delete (m as { assertions?: unknown }).assertions;
    expect(mapC2paStore(store("m", { m })).aiAction).toBe(false);
  });

  test("ingredientDeltas that are not an array, or deltas without validationDeltas, contribute nothing", () => {
    const variants: Record<string, unknown>[] = [
      { ...validatedResults, ingredientDeltas: "x" },
      { ...validatedResults, ingredientDeltas: [null] },
      { ...validatedResults, ingredientDeltas: [{ validationDeltas: "x" }] },
      { ...validatedResults, ingredientDeltas: [{ validationDeltas: { failure: "x" } }] },
    ];
    for (const [i, results] of variants.entries()) {
      const s = store("parent", {
        parent: manifest({ label: "parent", ingredients: [v3Ingredient("child", results)] }),
        child: manifest({ label: "child", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }),
      });
      expect(mapC2paStore(s).aiAction, `variant ${i}`).toBe(true);
    }
  });

  test("ingredientDeltas with no failure entries contribute nothing", () => {
    // The deltas array is present and valid but carries no failure: it must
    // not add anything to the failures the validation gate checks.
    const results = { ...validatedResults, ingredientDeltas: [{ validationDeltas: { failure: [] } }] };
    const s = store("parent", {
      parent: manifest({ label: "parent", ingredients: [v3Ingredient("child", results)] }),
      child: manifest({ label: "child", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }),
    });
    expect(mapC2paStore(s).aiAction).toBe(true);
  });

  test("a tolerated CAWG failure prefix still counts as validated", () => {
    const results = {
      activeManifest: {
        success: [{ code: "claimSignature.validated" }, { code: "claimSignature.insideValidity" }],
        informational: [],
        failure: [{ code: "cawg.x509.certificateUntrusted" }],
      },
    };
    const s = store("parent", {
      parent: manifest({ label: "parent", ingredients: [v3Ingredient("child", results)] }),
      child: manifest({ label: "child", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }),
    });
    expect(mapC2paStore(s).aiAction).toBe(true);
  });

  test("an ingredient whose validation lacks claimSignature.validated contributes nothing", () => {
    const results = {
      activeManifest: { success: [{ code: "claimSignature.insideValidity" }], informational: [], failure: [] },
    };
    const s = store("parent", {
      parent: manifest({ label: "parent", ingredients: [v3Ingredient("child", results)] }),
      child: manifest({ label: "child", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }),
    });
    expect(mapC2paStore(s).aiAction).toBe(false);
  });

  test("ingredients that are not objects, or without an active_manifest, are skipped", () => {
    const s = store("parent", {
      parent: manifest({
        label: "parent",
        ingredients: [42, { title: "no label" }, { active_manifest: 5 }],
      }),
    });
    expect(mapC2paStore(s).aiAction).toBe(false);
  });

  test("a null ingredient does not throw", () => {
    const s = store("parent", {
      parent: manifest({ label: "parent", ingredients: [null] }),
    });
    expect(mapC2paStore(s).aiAction).toBe(false);
  });

  test("an AI ingredient after a non-AI one is found (some, not every)", () => {
    // The first ingredient has no AI action, the second does: the scan must
    // find the later one rather than requiring every ingredient to match.
    const s = store("parent", {
      parent: manifest({
        label: "parent",
        ingredients: [v3Ingredient("plain", validatedResults), v3Ingredient("child", validatedResults)],
      }),
      plain: manifest({ label: "plain", actions: [{ action: "c2pa.created" }] }),
      child: manifest({ label: "child", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }),
    });
    expect(mapC2paStore(s).aiAction).toBe(true);
  });

  test("an AI ingredient followed by a non-AI one is still found", () => {
    const s = store("parent", {
      parent: manifest({
        label: "parent",
        ingredients: [v3Ingredient("child", validatedResults), v3Ingredient("plain", validatedResults)],
      }),
      plain: manifest({ label: "plain", actions: [{ action: "c2pa.created" }] }),
      child: manifest({ label: "child", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] }),
    });
    expect(mapC2paStore(s).aiAction).toBe(true);
  });

  test("a manifest with no ingredients array has no AI action from ingredients", () => {
    const m = manifest({ label: "m", actions: [{ action: "c2pa.created" }] });
    (m as { ingredients?: unknown }).ingredients = "x";
    expect(mapC2paStore(store("m", { m })).aiAction).toBe(false);
  });

  test("a non-created action that carries an AI source type is not the creating action", () => {
    const m = manifest({
      label: "m",
      actions: [
        { action: "c2pa.placed", digitalSourceType: TRAINED },
        { action: "c2pa.created", softwareAgent: { name: "X" } },
      ],
    });
    // aiAction is true (the placed action carries the AI type) but the creating
    // action is the c2pa.created one, so the model comes from it.
    const result = mapC2paStore(store("m", { m }));
    expect(result.aiAction).toBe(true);
    expect(result.claimedModel).toBe("X");
  });

  test("no creating action leaves claimedModel and generatedAt unset", () => {
    const m = manifest({ label: "m", actions: [{ action: "c2pa.placed" }], signatureInfo: { issuer: "Acme" } });
    const result = mapC2paStore(store("m", { m }));
    expect(result.claimedIssuer).toBe("Acme");
    expect(result.claimedModel).toBeUndefined();
    expect(result.generatedAt).toBeUndefined();
  });

  test("a softwareAgent object without a name leaves claimedModel unset", () => {
    const m = manifest({ label: "m", actions: [{ action: "c2pa.created", softwareAgent: { version: "1" } }] });
    expect(mapC2paStore(store("m", { m })).claimedModel).toBeUndefined();
  });

  test("a creating action with no softwareAgent still records generatedAt", () => {
    // claimedModelOf returns undefined here: the guard must skip setting
    // claimedModel while still recording the timestamp.
    const m = manifest({ label: "m", actions: [{ action: "c2pa.created", when: "2026-05-05T00:00:00Z" }] });
    const result = mapC2paStore(store("m", { m }));
    expect(result).not.toHaveProperty("claimedModel");
    expect(result.generatedAt).toBe("2026-05-05T00:00:00Z");
  });

  test("a creating action with a non-string when does not set generatedAt", () => {
    const m = manifest({ label: "m", actions: [{ action: "c2pa.created", when: 5 as unknown as string }] });
    expect(mapC2paStore(store("m", { m })).generatedAt).toBeUndefined();
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

  test("a non-Error value is stringified", () => {
    expect(mapC2paError("C2pa(JumbfNotFound) trailing")).toEqual<LocalC2pa>({ manifest: "absent", aiAction: false });
    expect(mapC2paError("plain string")).toEqual<LocalC2pa>({ manifest: "error", aiAction: false });
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
