import { readFileSync } from "node:fs";
import init, { WasmReader } from "@contentauth/c2pa-wasm";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { readC2pa, mapC2paError, mapC2paStore } from "../src/background/c2pa";
import type { LocalC2pa } from "../src/shared/types";
import { minimalGif, minimalWebp, pngWithXmpProvenance, tamperJpegScan, tamperPngDataHash, tamperText } from "./helpers/images";

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

type StatusEntry = { code: string };
type RawStore = { validation_results?: { activeManifest?: { success?: StatusEntry[]; failure?: StatusEntry[] } } };

async function activeCodes(format: string, bytes: Uint8Array): Promise<{ success: string[]; failure: string[] }> {
  await init({ module_or_path: WASM_BYTES });
  const reader = await WasmReader.fromBytes(format, bytes, '{"verify":{"remote_manifest_fetch":false,"ocsp_fetch":false}}');
  try {
    const active = (JSON.parse(reader.json()) as RawStore).validation_results?.activeManifest;
    return { success: (active?.success ?? []).map((s) => s.code), failure: (active?.failure ?? []).map((s) => s.code) };
  } finally {
    reader.free();
  }
}

// Multiset difference: each code in `from` cancels one occurrence in `minus`.
function codesMinus(from: string[], minus: string[]): string[] {
  const rest = [...minus];
  return from.filter((code) => {
    const at = rest.indexOf(code);
    if (at === -1) return true;
    rest.splice(at, 1);
    return false;
  });
}

// Which success codes a tamper removed and which failure codes it added.
async function statusChange(format: string, original: Uint8Array, tampered: Uint8Array): Promise<{ lost: string[]; gained: string[] }> {
  const before = await activeCodes(format, original);
  const after = await activeCodes(format, tampered);
  return { lost: codesMinus(before.success, after.success), gained: codesMinus(after.failure, before.failure) };
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
    validation_results: intactResults,
    validation_state: "Valid",
  };
}

// The same store with a chosen validation_results and validation_state, so the
// integrity axis can be exercised without repeating the whole store shape.
function storeWith(
  activeLabel: string,
  manifests: Record<string, Record<string, unknown>>,
  validationResults: unknown,
  validationState: string,
): Record<string, unknown> {
  return { ...store(activeLabel, manifests), validation_results: validationResults, validation_state: validationState };
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

// What a real validator emits for an intact manifest: the claim signature
// validated, the signer was inside its validity window, and the image bytes
// matched the hard binding.
const intactResults = {
  activeManifest: {
    success: [
      { code: "claimSignature.validated" },
      { code: "claimSignature.insideValidity" },
      { code: "assertion.dataHash.match" },
    ],
    informational: [],
    failure: [{ code: "signingCredential.untrusted" }],
  },
};

// The explanation c2pa-rs 0.91.7 logs when the signer's EKU is not one the C2PA
// profile allows (certificate_profile.rs).
const EKU_REJECTION = { code: "signingCredential.invalid", explanation: "certificate missing required EKU" };

// Every EKU message that file can emit. All of them mean the certificate is for
// some other purpose, which says nothing about whether the content matches the
// claim; the binding is checked separately.
const EKU_EXPLANATIONS = [
  "certificate missing required EKU",
  "certificate missing digitalSignature EKU",
  "certificate missing mandatory EKU",
  "certificate 'any' EKU not allowed",
  "certificate invalid set of EKUs",
  "the certificate contains an invalid extended key usage (EKU) value",
];

// The Microsoft shape: c2pa-rs reports claim.malformed not for a malformed claim
// but for a vendor soft-binding assertion it cannot decode, scoped by its URL.
const SOFT_BINDING_MALFORMED = {
  code: "claim.malformed",
  url: "self#jumbf=/c2pa/urn:c2pa:x/c2pa.assertions/c2pa.soft-binding",
  explanation: "soft binding assertion could not be decoded",
};

// A genuinely malformed claim, which must never be tolerated.
const CLAIM_MALFORMED = {
  code: "claim.malformed",
  url: "self#jumbf=/c2pa/urn:c2pa:x/c2pa.claim",
  explanation: "claim cbor invalid",
};

// The Microsoft shape: the binding is intact, but the signer certificate does
// not meet the C2PA profile, which makes the manifest invalid without any
// tampering.
const rejectedSignerResults = {
  activeManifest: {
    success: intactResults.activeManifest.success,
    informational: [],
    failure: [{ code: "signingCredential.untrusted" }, EKU_REJECTION, SOFT_BINDING_MALFORMED],
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
      integrity: "verified",
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
      integrity: "verified",
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

// ValidationState::Invalid conflates a broken binding with a signer certificate
// that the C2PA profile rejects, so integrity is derived separately from the
// status codes the validator reports (C2PA standard status codes).
describe("mapC2paStore: the integrity axis", () => {
  let active: Record<string, unknown>;

  beforeEach(() => {
    active = manifest({ label: "m", actions: [{ action: "c2pa.created", digitalSourceType: TRAINED }] });
  });

  test("verified when the signature validated, was inside validity, and the data hash matched", () => {
    expect(mapC2paStore(store("m", { m: active })).integrity).toBe("verified");
  });

  test("verified for each hard-binding assertion form", () => {
    // A BMFF container (AVIF/HEIC) binds through bmffHash, not dataHash.
    for (const code of [
      "assertion.dataHash.match",
      "assertion.bmffHash.match",
      "assertion.boxesHash.match",
      "assertion.collectionHash.match",
    ]) {
      const results = {
        activeManifest: {
          success: [
            { code: "claimSignature.validated" },
            { code: "claimSignature.insideValidity" },
            { code },
          ],
          informational: [],
          failure: [],
        },
      };
      expect(mapC2paStore(storeWith("m", { m: active }, results, "Valid")).integrity, code).toBe("verified");
    }
  });

  test("unverified when the claim signature did not validate", () => {
    const results = {
      activeManifest: {
        success: [{ code: "claimSignature.insideValidity" }, { code: "assertion.dataHash.match" }],
        informational: [],
        failure: [{ code: "claimSignature.mismatch" }],
      },
    };
    expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity).toBe("unverified");
  });

  test("unverified when the signing certificate was outside its validity window", () => {
    const results = {
      activeManifest: {
        success: [{ code: "claimSignature.validated" }, { code: "assertion.dataHash.match" }],
        informational: [],
        failure: [{ code: "signingCredential.expired" }],
      },
    };
    expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity).toBe("unverified");
  });

  test("unverified when no hard binding matched", () => {
    // Tampering withholds the match code; it does not add a success one.
    const results = {
      activeManifest: {
        success: [{ code: "claimSignature.validated" }, { code: "claimSignature.insideValidity" }],
        informational: [],
        failure: [{ code: "signingCredential.untrusted" }, { code: "assertion.dataHash.mismatch" }],
      },
    };
    expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity).toBe("unverified");
  });

  test("unverified when there are no validation results at all", () => {
    expect(mapC2paStore(storeWith("m", { m: active }, undefined, "Invalid")).integrity).toBe("unverified");
  });

  test("unverified for every component mismatch code", () => {
    // Each of these means a manifest component no longer matches what the signed
    // claim records for it, which no match success code can be trusted over.
    for (const code of [
      "assertion.hashedURI.mismatch",
      "ingredient.hashedURI.mismatch",
      "assertion.dataHash.mismatch",
      "assertion.bmffHash.mismatch",
      "assertion.boxesHash.mismatch",
      "assertion.collectionHash.mismatch",
    ]) {
      const results = {
        activeManifest: {
          success: intactResults.activeManifest.success,
          informational: [],
          failure: [{ code: "signingCredential.untrusted" }, { code }],
        },
      };
      expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity, code).toBe("unverified");
    }
  });

  test("unverified for any failure outside the tolerated signer codes", () => {
    // Fail closed: a code this list does not name, including one a future
    // c2pa-wasm adds, must not count as an intact binding.
    for (const code of ["assertion.missing", "assertion.action.malformed", "timeStamp.mismatch", "future.unknownCode"]) {
      const results = {
        activeManifest: {
          success: intactResults.activeManifest.success,
          informational: [],
          failure: [EKU_REJECTION, { code }],
        },
      };
      expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity, code).toBe("unverified");
    }
  });

  test("verified for every certificate-profile explanation about the EKU", () => {
    for (const explanation of EKU_EXPLANATIONS) {
      const results = {
        activeManifest: {
          success: intactResults.activeManifest.success,
          informational: [],
          failure: [{ code: "signingCredential.invalid", explanation }],
        },
      };
      expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity, explanation).toBe("verified");
    }
  });

  test("unverified for a certificate-profile failure that is not about the EKU", () => {
    // A certificate rejected for being self-signed, expired or weak is not a
    // reason to trust the claim, so it must fail closed.
    for (const failure of [
      { code: "signingCredential.invalid", explanation: "certificate key length too short" },
      { code: "signingCredential.invalid", explanation: "certificate issuer and subject cannot be the same (self-signed disallowed)" },
      { code: "signingCredential.invalid", explanation: "certificate expired" },
      { code: "signingCredential.invalid" },
    ]) {
      const results = {
        activeManifest: { success: intactResults.activeManifest.success, informational: [], failure: [failure] },
      };
      expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity, failure.explanation).toBe("unverified");
    }
  });

  test("an undecodable assertion is tolerated, a malformed claim is not", () => {
    // claim.malformed carries a broader meaning than the cause observed here, so
    // only the assertion-scoped form may be tolerated.
    const assertionScoped = {
      activeManifest: { success: intactResults.activeManifest.success, informational: [], failure: [SOFT_BINDING_MALFORMED] },
    };
    expect(mapC2paStore(storeWith("m", { m: active }, assertionScoped, "Invalid")).integrity).toBe("verified");
    const claimScoped = {
      activeManifest: { success: intactResults.activeManifest.success, informational: [], failure: [CLAIM_MALFORMED] },
    };
    expect(mapC2paStore(storeWith("m", { m: active }, claimScoped, "Invalid")).integrity).toBe("unverified");
  });

  test("unverified when an ingredient delta has a non-tolerated failure", () => {
    // c2pa-rs makes the whole store invalid for a non-tolerated failure in any
    // ingredient delta, so the allowlist has to cover that axis too.
    const results = {
      activeManifest: { success: intactResults.activeManifest.success, informational: [], failure: [EKU_REJECTION] },
      ingredientDeltas: [
        {
          ingredientAssertionURI: "self#jumbf=/c2pa/urn:x/c2pa.assertions/c2pa.ingredient.v3",
          validationDeltas: { success: [], informational: [], failure: [{ code: "ingredient.hashedURI.mismatch" }] },
        },
      ],
    };
    expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity).toBe("unverified");
  });

  test("verified when every ingredient delta failure is tolerated too", () => {
    // The Gemini shape: an ingredient whose signer is simply untrusted.
    const results = {
      activeManifest: { success: intactResults.activeManifest.success, informational: [], failure: [] },
      ingredientDeltas: [
        {
          ingredientAssertionURI: "self#jumbf=/c2pa/urn:x/c2pa.assertions/c2pa.ingredient.v3",
          validationDeltas: { success: [], informational: [], failure: [{ code: "signingCredential.untrusted" }] },
        },
      ],
    };
    expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity).toBe("verified");
  });

  test("unverified without any one of the three positive requirements, even with no failures", () => {
    // Each requirement is isolated with an empty failure list, so a weakened
    // AND-chain (or `some` instead of `every`) cannot hide behind a failure code.
    const requirements = [
      ["claimSignature.insideValidity", "assertion.dataHash.match"], // no claimSignature.validated
      ["claimSignature.validated", "assertion.dataHash.match"], // no claimSignature.insideValidity
      ["claimSignature.validated", "claimSignature.insideValidity"], // no binding match
    ];
    for (const codes of requirements) {
      const results = {
        activeManifest: { success: codes.map((code) => ({ code })), informational: [], failure: [] },
      };
      expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity, codes.join(",")).toBe("unverified");
    }
  });

  test("unverified when a failure entry carries no usable code", () => {
    // Fail closed: an entry the allowlist cannot interpret is not tolerated.
    for (const entry of [{}, { explanation: "x" }, "signingCredential.untrusted", null]) {
      const results = {
        activeManifest: { success: intactResults.activeManifest.success, informational: [], failure: [entry] },
      };
      expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity, JSON.stringify(entry)).toBe("unverified");
    }
  });

  test("malformed failure and delta lists contribute nothing", () => {
    // Lists of the wrong shape carry no failures to count, which is not itself a
    // reason to distrust an otherwise intact manifest.
    const results = {
      activeManifest: { success: intactResults.activeManifest.success, informational: [], failure: "x" },
      ingredientDeltas: [{ validationDeltas: "x" }, null, { validationDeltas: { failure: "x" } }],
    };
    expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity).toBe("verified");
  });

  test("a non-array ingredientDeltas contributes nothing", () => {
    const results = {
      activeManifest: { success: intactResults.activeManifest.success, informational: [], failure: [] },
      ingredientDeltas: "x",
    };
    expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity).toBe("verified");
  });

  test("verified with a tolerated CAWG identity failure", () => {
    const results = {
      activeManifest: {
        success: intactResults.activeManifest.success,
        informational: [],
        failure: [EKU_REJECTION, { code: "cawg.identity.malformed" }],
      },
    };
    expect(mapC2paStore(storeWith("m", { m: active }, results, "Invalid")).integrity).toBe("verified");
  });

  test("a rejected signer certificate leaves the binding verified while the manifest is invalid", () => {
    const result = mapC2paStore(storeWith("m", { m: active }, rejectedSignerResults, "Invalid"));
    expect(result.manifest).toBe("invalid");
    expect(result.aiAction).toBe(true);
    expect(result.integrity).toBe("verified");
  });

  test("a manifest that was never found reports no integrity at all", () => {
    // There is no binding to assess, so the field is absent rather than a
    // misleading "unverified".
    expect(mapC2paStore({ active_manifest: "m", manifests: {}, validation_state: "Valid" })).not.toHaveProperty("integrity");
    expect(mapC2paError("C2pa(JumbfNotFound)")).not.toHaveProperty("integrity");
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
      integrity: "verified",
      claimedIssuer: "OpenAI OpCo, LLC",
      claimedModel: "ChatGPT / gpt-image",
      generatedAt: "2026-10-31T12:38:51.498118131Z",
    } satisfies LocalC2pa);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("gemini fixture: present with a verified binding, issued by Google", async () => {
    const result = await readC2pa("image/jpeg", fixture("ai-gemini-bunny.jpg"), WASM_BYTES);
    expect(result).toEqual({
      manifest: "present",
      aiAction: true,
      integrity: "verified",
      claimedIssuer: "Google LLC",
    } satisfies LocalC2pa);
  });

  test("microsoft fixture: invalid, but the binding is verified and the issuer is named", async () => {
    // The signer certificate does not meet the C2PA profile (an EKU outside it),
    // which makes c2pa-wasm's state Invalid even though the signature and the
    // data hash both verify. Nothing was edited.
    const result = await readC2pa("image/jpeg", fixture("ai-microsoft-bunny.jpg"), WASM_BYTES);
    expect(result.manifest).toBe("invalid");
    expect(result.aiAction).toBe(true);
    expect(result.integrity).toBe("verified");
    expect(result.claimedIssuer).toBe("Microsoft Corporation");
    expect(result.claimedModel).toBe("Bing Image Creator");
  });

  // Each tamper test also pins the status-code change, so a helper that hits the
  // wrong bytes cannot pass on an unrelated failure.
  const IMAGE_TAMPERED = { lost: ["assertion.dataHash.match"], gained: ["assertion.dataHash.mismatch"] };
  const ASSERTION_TAMPERED = { lost: ["assertion.hashedURI.match"], gained: ["assertion.hashedURI.mismatch"] };

  test("a tampered halloween: AI action intact, binding broken", async () => {
    const original = fixture("ai-test-halloween.png");
    const tampered = tamperPngDataHash(original);
    const result = await readC2pa("image/png", tampered, WASM_BYTES);
    expect(result.manifest).toBe("invalid");
    expect(result.aiAction).toBe(true);
    expect(result.integrity).toBe("unverified");
    expect(await statusChange("image/png", original, tampered)).toEqual(IMAGE_TAMPERED);
  });

  test("an altered assertion: AI action intact, assertion hash broken", async () => {
    // The image and the claim are untouched, so the claim signature and the data
    // hash both verify; only the assertion's hashed URI shows the edit.
    const original = fixture("ai-test-halloween.png");
    const tampered = tamperText(original, "ChatGPT");
    const result = await readC2pa("image/png", tampered, WASM_BYTES);
    expect(result.manifest).toBe("invalid");
    expect(result.aiAction).toBe(true);
    expect(result.integrity).toBe("unverified");
    expect(result.claimedModel).toBe("ChatGPU / gpt-image");
    expect(await statusChange("image/png", original, tampered)).toEqual(ASSERTION_TAMPERED);
  });

  test("a tampered microsoft image: the EKU tolerance does not cover a broken binding", async () => {
    const original = fixture("ai-microsoft-bunny.jpg");
    const tampered = tamperJpegScan(original);
    const result = await readC2pa("image/jpeg", tampered, WASM_BYTES);
    expect(result.manifest).toBe("invalid");
    expect(result.aiAction).toBe(true);
    expect(result.integrity).toBe("unverified");
    expect(await statusChange("image/jpeg", original, tampered)).toEqual(IMAGE_TAMPERED);
  });

  test("an altered microsoft assertion: the EKU tolerance does not cover it", async () => {
    const original = fixture("ai-microsoft-bunny.jpg");
    const tampered = tamperText(original, "Bing Image Creator");
    const result = await readC2pa("image/jpeg", tampered, WASM_BYTES);
    expect(result.manifest).toBe("invalid");
    expect(result.aiAction).toBe(true);
    expect(result.integrity).toBe("unverified");
    expect(result.claimedModel).toBe("Bing Image Creatos");
    expect(await statusChange("image/jpeg", original, tampered)).toEqual(ASSERTION_TAMPERED);
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
