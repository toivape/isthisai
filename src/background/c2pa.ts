// Local C2PA check via @contentauth/c2pa-wasm (the only file that imports it;
// enforced by the c2pa-wasm-gated rule). Hard rule 7: remote fetches are always
// disabled — a crafted image could otherwise make the wasm fetch an
// attacker-controlled URL. Hard rule 2: the original bytes are passed as-is.

import init, { WasmReader } from "@contentauth/c2pa-wasm";
import type { LocalC2pa } from "../shared/types";

// The verify gate: no remote manifest fetch, no OCSP fetch. The rules test
// fails the build if a fromBytes call omits this.
const VERIFY_CONTEXT = '{"verify":{"remote_manifest_fetch":false,"ocsp_fetch":false}}';

// Lazy wasm init per the spike recipe (PLAN §2): cache the promise, drop it on
// rejection so the next attempt retries. Not module state that must survive a
// worker restart — the cache only avoids re-paying init within one lifetime.
let wasmReady: Promise<unknown> | undefined;

function ensureWasm(wasmSource: BufferSource | string): Promise<unknown> {
  wasmReady ??= init({ module_or_path: wasmSource }).catch((error: unknown) => {
    wasmReady = undefined;
    throw error;
  });
  return wasmReady;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- mapping from the manifest store to LocalC2pa ----

const TRAINED_SUFFIXES = ["trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia"];

function isAiSourceType(value: unknown): boolean {
  return typeof value === "string" && TRAINED_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

interface ActionLike {
  action?: unknown;
  when?: unknown;
  softwareAgent?: unknown;
  digitalSourceType?: unknown;
}

function actionsOf(manifest: Record<string, unknown>): ActionLike[] {
  const assertions = manifest.assertions;
  if (!Array.isArray(assertions)) return [];
  return assertions.flatMap((assertion) => {
    if (!isObject(assertion) || !isObject(assertion.data)) return [];
    const data = assertion.data;
    // c2pa.actions and c2pa.actions.v2 both carry { actions: [...] }
    if (!Array.isArray(data.actions)) return [];
    return data.actions.filter(isObject) as ActionLike[];
  });
}

// Mirrors ValidationResults::validation_state in c2pa-rs 0.91.7 for the
// no-trust-list case: validated + insideValidity, and every failure either
// absent or tolerated (signingCredential.untrusted / CAWG codes).
const TOLERATED_FAILURE_PREFIXES = ["cawg.x509.", "cawg.identity."];

function ingredientValidationPassed(validationResults: unknown): boolean {
  if (!isObject(validationResults)) return false;
  const active = validationResults.activeManifest;
  if (!isObject(active)) return false;
  const codes = (kind: "success" | "failure"): unknown[] =>
    Array.isArray(active[kind]) ? (active[kind] as unknown[]) : [];
  const codeOf = (entry: unknown): string => (isObject(entry) && typeof entry.code === "string" ? entry.code : "");
  const success = codes("success").map(codeOf);
  const failures = codes("failure").map(codeOf);
  const tolerated = (code: string): boolean =>
    code === "signingCredential.untrusted" || TOLERATED_FAILURE_PREFIXES.some((prefix) => code.startsWith(prefix));
  return (
    success.includes("claimSignature.validated") &&
    success.includes("claimSignature.insideValidity") &&
    failures.every(tolerated)
  );
}

function hasAiAction(manifests: Record<string, Record<string, unknown>>, label: string, visited: Set<string>): boolean {
  const current = manifests[label];
  if (!current || visited.has(label)) return false; // cyclic guard
  visited.add(label);
  if (actionsOf(current).some((action) => isAiSourceType(action.digitalSourceType))) return true;
  const ingredients = current.ingredients;
  if (!Array.isArray(ingredients)) return false;
  return ingredients.some((ingredient) => {
    if (!isObject(ingredient)) return false;
    // v3 ingredients carry their own manifest label plus its validation
    // results; unvalidated ingredients contribute nothing (hard rule 9).
    const active = typeof ingredient.active_manifest === "string" ? ingredient.active_manifest : undefined;
    if (!active) return false;
    if (!ingredientValidationPassed(ingredient.validation_results)) return false;
    return hasAiAction(manifests, active, visited);
  });
}

// claimedModel: softwareAgent "name / version"; a string agent is used as is.
function claimedModelOf(action: ActionLike): string | undefined {
  const agent = action.softwareAgent;
  if (typeof agent === "string") return agent;
  if (isObject(agent) && typeof agent.name === "string") {
    return typeof agent.version === "string" ? `${agent.name} / ${agent.version}` : agent.name;
  }
  return undefined;
}

function creatingActionOf(manifest: Record<string, unknown>): ActionLike | undefined {
  return actionsOf(manifest).find((action) => action.action === "c2pa.created");
}

export function mapC2paStore(store: unknown): LocalC2pa {
  if (!isObject(store)) return { manifest: "error", aiAction: false };
  const activeLabel = store.active_manifest;
  if (typeof activeLabel !== "string") return { manifest: "error", aiAction: false };
  const manifestsValue = store.manifests;
  if (!isObject(manifestsValue)) return { manifest: "error", aiAction: false };
  const manifests = manifestsValue as Record<string, Record<string, unknown>>;
  const active = manifests[activeLabel];
  if (!isObject(active)) return { manifest: "error", aiAction: false };

  const validationState = store.validation_state;
  const manifest: LocalC2pa["manifest"] =
    validationState === "Valid" || validationState === "Trusted" ? "present" : "invalid";

  const creating = creatingActionOf(active);
  const signatureInfo = isObject(active.signature_info) ? active.signature_info : {};
  const result: LocalC2pa = {
    manifest,
    aiAction: hasAiAction(manifests, activeLabel, new Set()),
  };
  if (typeof signatureInfo.issuer === "string") result.claimedIssuer = signatureInfo.issuer;
  if (creating) {
    const model = claimedModelOf(creating);
    if (model !== undefined) result.claimedModel = model;
    if (typeof creating.when === "string") result.generatedAt = creating.when;
  }
  return result;
}

export function mapC2paError(thrown: unknown): LocalC2pa {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (message.includes("JumbfNotFound")) return { manifest: "absent", aiAction: false };
  if (message.includes("RemoteManifestUrl")) return { manifest: "remote_unfetched", aiAction: false };
  return { manifest: "error", aiAction: false };
}

// Reads the C2PA manifest store from raw image bytes. Never re-encodes, never
// fetches remotely; a wasm source must be supplied (the worker passes
// chrome.runtime.getURL("c2pa.wasm") as a URL the glue fetches from the
// extension bundle; tests pass the raw bytes so no fetch happens at all).
export async function readC2pa(format: string, bytes: Uint8Array, wasmSource: BufferSource | string): Promise<LocalC2pa> {
  await ensureWasm(wasmSource);
  let reader: WasmReader | undefined;
  try {
    reader = await WasmReader.fromBytes(format, bytes, VERIFY_CONTEXT);
    return mapC2paStore(JSON.parse(reader.json()));
  } catch (thrown: unknown) {
    return mapC2paError(thrown);
  } finally {
    reader?.free();
  }
}
