// The OpenAI check flow (PLAN §4 step 8): validate the request, take the user's
// confirmation, re-fetch and hash-check the bytes, ask the CDN for a format
// OpenAI accepts when needed, upload, merge the signals into the stored result
// and cache it. The decisions are pure functions over the record, the sender
// and the fetched bytes; index.ts only wires chrome to them.

import { getCheck, getResult, putResult, type CacheStore } from "./cache";
import { fetchConvertedImage, type CollectedImage } from "./fetchImage";
import { buildRequest, isSendableKey, sendProvenanceUpload, type SendProvenanceDeps } from "./openai";
import { httpOrigin } from "./permissions";
import { isOpenAiType, sniffMediaType } from "./sniff";
import { mergeOpenAi } from "./verdict";
import type {
  CheckErrorCode,
  CheckRecord,
  CheckResult,
  CheckUpdate,
  OpenAiError,
  OpenAiErrorCode,
} from "../shared/types";

export const CONFIRM_WINDOW_PATH = "src/confirm/confirm.html";

// Only tab.id and frameId are read from the message sender.
export interface FlowSender {
  tabId: number | undefined;
  frameId: number | undefined;
}

export interface ConsentRequest {
  checkId: string;
  path: string;
}

export interface OpenAiFlowDeps extends SendProvenanceDeps {
  store: CacheStore;
  readKey: () => Promise<string | undefined>;
  /** Opens the confirmation window and resolves with the user's answer. */
  requestConsent: (request: ConsentRequest) => Promise<boolean>;
  /** Re-obtains the stored image's bytes (network, or the page for blob:/data:). */
  readImage: (record: CheckRecord) => Promise<CollectedImage>;
  sendUpdate: (update: CheckUpdate) => void | Promise<void>;
}

export type OpenAiFlowOutcome =
  | { kind: "ignored" }
  | { kind: "error"; error: OpenAiError }
  | { kind: "done"; result: CheckResult };

/** The request must come from the frame that opened the check (PLAN §4 step 8.1). */
export function senderMatches(record: CheckRecord, sender: FlowSender): boolean {
  return sender.tabId === record.tabId && sender.frameId === record.frameId;
}

/** The confirmation window's URL. It carries discrete image details, never the
 * srcUrl, so a data: URL's payload cannot travel in a window URL (view.ts). */
export function consentWindowPath(record: CheckRecord): string {
  const params = new URLSearchParams({
    view: "confirm",
    checkId: record.checkId,
    mediaType: record.mediaType,
    sizeBytes: String(record.size),
  });
  const origin = httpOrigin(record.srcUrl);
  if (origin !== undefined) params.set("origin", origin);
  return `${CONFIRM_WINDOW_PATH}?${params.toString()}`;
}

/** The reload carries the local fetch codes; map them onto the OpenAI error set
 * the user sees. There is no OpenAI code for a local size or permission failure
 * — the image simply could not be re-obtained, which is what fetch_failed says. */
export function mapReloadError(code: CheckErrorCode): OpenAiErrorCode {
  if (code === "timeout") return "timeout";
  if (code === "unsupported_type") return "unsupported_type";
  return "fetch_failed";
}

type ConvertedImage = { kind: "ok"; bytes: Uint8Array; mediaType: string } | { kind: "error"; error: OpenAiError };

// PLAN §4 step 8.4: only an http(s) source has a server that can return a
// converted copy; a data: or blob: AVIF has nothing to ask.
async function convertForUpload(deps: OpenAiFlowDeps, record: CheckRecord): Promise<ConvertedImage> {
  if (httpOrigin(record.srcUrl) === undefined) return { kind: "error", error: { code: "unsupported_type" } };
  const fetched = await fetchConvertedImage(record.srcUrl, { fetchImpl: deps.fetchImpl, deadlineMs: deps.deadlineMs });
  if (fetched.kind === "error") return { kind: "error", error: { code: mapReloadError(fetched.error.code) } };
  const mediaType = sniffMediaType(fetched.bytes);
  if (!isOpenAiType(mediaType)) return { kind: "error", error: { code: "unsupported_type" } };
  return { kind: "ok", bytes: fetched.bytes, mediaType };
}

// Cache access is best-effort: losing it must never cost the user their result.
async function loadRecord(store: CacheStore, checkId: string): Promise<CheckRecord | undefined> {
  try {
    return await getCheck(store, checkId);
  } catch (error) {
    console.error("cache read failed", error);
    return undefined;
  }
}

async function loadResult(store: CacheStore, imageHash: string): Promise<CheckResult | undefined> {
  try {
    return await getResult(store, imageHash);
  } catch (error) {
    console.error("cache read failed", error);
    return undefined;
  }
}

async function sendDone(deps: OpenAiFlowDeps, record: CheckRecord, result: CheckResult): Promise<void> {
  await deps.sendUpdate({
    type: "checkUpdate",
    checkId: record.checkId,
    srcUrl: record.srcUrl,
    status: "done",
    result,
    openai: { available: true },
  });
}

export async function runOpenAiFlow(
  deps: OpenAiFlowDeps,
  input: { checkId: string; sender: FlowSender },
): Promise<OpenAiFlowOutcome> {
  const record = await loadRecord(deps.store, input.checkId);
  if (record === undefined) return { kind: "error", error: { code: "check_expired" } };
  if (!senderMatches(record, input.sender)) return { kind: "ignored" };

  const key = await deps.readKey();
  if (key === undefined || key === "") return { kind: "error", error: { code: "no_key" } };
  if (!isSendableKey(key)) return { kind: "error", error: { code: "invalid_key" } };

  // The local check wrote both entries; without the result there is nothing to
  // merge the OpenAI signals into.
  const cached = await loadResult(deps.store, record.imageHash);
  if (cached === undefined) return { kind: "error", error: { code: "check_expired" } };

  // The same image is never uploaded twice in a session (PLAN §4 Cache).
  if (cached.openai.state === "done") {
    await sendDone(deps, record, cached);
    return { kind: "done", result: cached };
  }

  const confirmed = await deps.requestConsent({ checkId: record.checkId, path: consentWindowPath(record) });
  if (!confirmed) return { kind: "error", error: { code: "cancelled" } };

  const reloaded = await deps.readImage(record);
  if (reloaded.kind === "error") return { kind: "error", error: { code: mapReloadError(reloaded.error.code) } };
  if (reloaded.imageHash !== record.imageHash) return { kind: "error", error: { code: "hash_mismatch" } };

  let bytes = reloaded.bytes;
  let mediaType = reloaded.mediaType;
  let serverConverted = false;
  if (!isOpenAiType(mediaType)) {
    const converted = await convertForUpload(deps, record);
    if (converted.kind === "error") return converted;
    // The hash check above does not apply here: the server re-encoded the image.
    bytes = converted.bytes;
    mediaType = converted.mediaType;
    serverConverted = true;
  }

  const built = buildRequest(key, bytes, mediaType);
  if (!built.ok) return { kind: "error", error: built.error };

  const parsed = await sendProvenanceUpload(built.request, { fetchImpl: deps.fetchImpl, deadlineMs: deps.deadlineMs });
  if (!parsed.ok) return { kind: "error", error: parsed.error };

  const merged = mergeOpenAi(cached, {
    state: "done",
    serverConverted,
    c2pa: parsed.result.c2pa,
    synthid: parsed.result.synthid,
  });
  try {
    await putResult(deps.store, merged);
  } catch (error) {
    console.error("cache write failed", error);
  }
  await sendDone(deps, record, merged);
  return { kind: "done", result: merged };
}
