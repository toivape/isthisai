// M0 spike for issue #2: proves @contentauth/c2pa-wasm loads and parses
// inside the MV3 service worker. Throwaway code — only the recipe recorded
// in PLAN.md survives the merge.
import init, { WasmReader } from "@contentauth/c2pa-wasm";

// Hard rule 7 (CLAUDE.md): remote fetches must stay disabled, or a crafted
// image could make the reader fetch an attacker-controlled URL.
export const VERIFY_CONTEXT = '{"verify":{"remote_manifest_fetch":false,"ocsp_fetch":false}}';

let wasmReady: Promise<void> | null = null;

// init() wires the module for every WasmReader method, so one call per worker
// lifetime is enough. Called lazily from the click handler because a module
// service worker must not await at the top level.
export function ensureWasm(): Promise<void> {
  wasmReady ??= init({ module_or_path: chrome.runtime.getURL("c2pa.wasm") }).then(
    () => undefined,
    (error: unknown) => {
      // Drop the cached rejection so the next click retries the load.
      wasmReady = null;
      throw error;
    },
  );
  return wasmReady;
}

interface SpikeAction {
  action?: string;
  softwareAgent?: { name?: string; version?: string };
  digitalSourceType?: string;
}

interface SpikeManifest {
  assertions?: { data?: { actions?: SpikeAction[] } }[];
  signature_info?: { issuer?: string };
}

interface SpikeManifestStore {
  active_manifest?: string;
  validation_state?: string;
  manifests?: Record<string, SpikeManifest | undefined>;
}

export interface SpikeSummary {
  activeLabel: string | undefined;
  validationState: string | undefined;
  issuer: string | undefined;
  softwareAgent: string | undefined;
  digitalSourceType: string | undefined;
  watermarked: boolean;
  actionCount: number;
}

export async function parseSpikePng(bytes: Uint8Array): Promise<SpikeSummary> {
  const reader = await WasmReader.fromBytes("image/png", bytes, VERIFY_CONTEXT);
  try {
    const store = JSON.parse(reader.json()) as SpikeManifestStore;
    const manifest = store.manifests?.[store.active_manifest ?? ""];
    const actions = manifest?.assertions?.flatMap((a) => a.data?.actions ?? []) ?? [];
    const created = actions.find((a) => a.action === "c2pa.created");
    const agent = created?.softwareAgent;
    return {
      activeLabel: store.active_manifest,
      validationState: store.validation_state,
      issuer: manifest?.signature_info?.issuer,
      softwareAgent: agent?.name ? (agent.version ? `${agent.name} / ${agent.version}` : agent.name) : undefined,
      digitalSourceType: created?.digitalSourceType,
      watermarked: actions.some((a) => a.action === "c2pa.watermarked" || a.action === "c2pa.watermarked.unbound"),
      actionCount: actions.length,
    };
  } finally {
    reader.free();
  }
}
