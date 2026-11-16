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

export type OpenAiFlowOutcome =
  | { kind: "ignored" }
  | { kind: "error"; error: OpenAiError }
  | { kind: "done"; result: CheckResult };

export type SerializeUploads = (imageHash: string, run: () => Promise<OpenAiFlowOutcome>) => Promise<OpenAiFlowOutcome>;

/**
 * The worker's memory of OpenAI uploads, keyed by image hash. It does two things:
 * it runs one upload per image at a time (a caller that arrives while one is in
 * flight awaits its outcome rather than sending the image again), and it
 * remembers an upload that succeeded, so a result write that failed does not make
 * the next check send that image again. In memory only: a worker restart leaves
 * the session cache as the sole memory (PLAN §4 Cache).
 */
export interface UploadRegistry {
  /** The result of an upload this worker already completed for the image. */
  get(imageHash: string): CheckResult | undefined;
  run(imageHash: string, start: () => Promise<OpenAiFlowOutcome>): Promise<OpenAiFlowOutcome>;
}

export function uploadRegistry(): UploadRegistry {
  const inFlight = new Map<string, Promise<OpenAiFlowOutcome>>();
  const completed = new Map<string, CheckResult>();
  const registry: UploadRegistry = {
    get: (imageHash) => completed.get(imageHash),
    run: (imageHash, start) => {
      const existing = inFlight.get(imageHash);
      // Only a success is shared. An error belongs to the first caller's source
      // (a blob: that is gone, say), so a follower tries its own.
      if (existing !== undefined) {
        return existing.then((shared) => (shared.kind === "done" ? shared : registry.run(imageHash, start)));
      }
      // Only a success is remembered: an OpenAI error must be retryable.
      const outcome = start()
        .then((result) => {
          if (result.kind === "done") completed.set(imageHash, result.result);
          return result;
        })
        .finally(() => {
          inFlight.delete(imageHash);
        });
      inFlight.set(imageHash, outcome);
      return outcome;
    },
  };
  return registry;
}

export interface OpenAiFlowDeps extends SendProvenanceDeps {
  store: CacheStore;
  readKey: () => Promise<string | undefined>;
  /** Opens the confirmation window and resolves with the user's answer. */
  requestConsent: (request: ConsentRequest) => Promise<boolean>;
  /** Re-obtains the stored image's bytes (network, or the page for blob:/data:). */
  readImage: (record: CheckRecord) => Promise<CollectedImage>;
  sendUpdate: (update: CheckUpdate) => void | Promise<void>;
  /** One upload per image at a time, and the memory of those uploads. */
  uploads: UploadRegistry;
}

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
  if (origin !== undefined) {
    params.set("origin", origin);
    // The converted re-fetch is a second download the hash check cannot cover,
    // so the user is told the uploaded copy may differ from the stored one.
    if (!isOpenAiType(record.mediaType)) params.set("converted", "1");
  }
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

// The stored result is authoritative; the worker's own memory covers a result
// that was never written (session quota) within the same worker lifetime.
function alreadyUploaded(
  cached: CheckResult | undefined,
  uploads: UploadRegistry,
  imageHash: string,
): CheckResult | undefined {
  if (cached !== undefined && cached.openai.state === "done") return cached;
  return uploads.get(imageHash);
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
  const known = alreadyUploaded(cached, deps.uploads, record.imageHash);
  if (known !== undefined) {
    await sendDone(deps, record, known);
    return { kind: "done", result: known };
  }
  if (cached === undefined) return { kind: "error", error: { code: "check_expired" } };

  const confirmed = await deps.requestConsent({ checkId: record.checkId, path: consentWindowPath(record) });
  if (!confirmed) return { kind: "error", error: { code: "cancelled" } };

  const outcome = await deps.uploads.run(record.imageHash, () => uploadOnce(deps, record, cached, key));
  // The update is sent per caller, not per upload: a coalesced second check
  // still gets its own done update in its own frame.
  if (outcome.kind === "done") await sendDone(deps, record, outcome.result);
  return outcome;
}

// Runs inside the per-hash guard. The cache and the worker's memory are re-read
// here, so a check of the same image that completed while this window was open is
// reused rather than uploaded again.
async function uploadOnce(
  deps: OpenAiFlowDeps,
  record: CheckRecord,
  cached: CheckResult,
  key: string,
): Promise<OpenAiFlowOutcome> {
  const latest = await loadResult(deps.store, record.imageHash);
  const known = alreadyUploaded(latest, deps.uploads, record.imageHash);
  if (known !== undefined) return { kind: "done", result: known };

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

  // Re-read immediately before the merge: a local re-check of the same image may
  // have written the result while this upload was in flight, and the merge must
  // not resurrect the local parts from before it (or clobber its newer ones).
  const base = (await loadResult(deps.store, record.imageHash)) ?? latest ?? cached;
  const merged = mergeOpenAi(base, {
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
  return { kind: "done", result: merged };
}
