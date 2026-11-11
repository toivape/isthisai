// The check pipeline (PLAN §4 steps 3–7), as a pure function over injected
// dependencies so it runs in tests without chrome. Sequence: fetch -> sniff ->
// hash -> cache lookup -> local checks (C2PA, XMP) -> verdict -> cache -> notify.

import { getResult, putCheck, putResult, type CacheStore } from "./cache";
import { readC2pa } from "./c2pa";
import { collectImage, type CollectedImage } from "./fetchImage";
import { scanXmp } from "./xmp";
import { computeVerdict } from "./verdict";
import type { CheckError, CheckResult, CheckUpdate, OpenAiAvailability, ReadBlobReply } from "../shared/types";

export interface CheckInput {
  checkId: string;
  srcUrl: string;
  frameUrl: string;
  tabId: number;
  frameId: number;
}

export interface CheckDeps {
  sendUpdate: (update: CheckUpdate) => void | Promise<void>;
  readBlob: (url: string) => Promise<ReadBlobReply>;
  fetchImpl?: typeof fetch;
  readC2pa: typeof readC2pa;
  scanXmp: typeof scanXmp;
  store: CacheStore;
  wasmSource: BufferSource | string;
  hasApiKey: () => Promise<boolean>;
}

export type CheckOutcome = { kind: "done"; openai: OpenAiAvailability } | { kind: "failed"; error: CheckError };

// Local checks are free and offline (hard rule 5); nothing here leaves the
// machine. The OpenAI upload is a separate, confirmed path.
async function runLocalChecks(
  deps: CheckDeps,
  collected: Extract<CollectedImage, { kind: "image" }>,
): Promise<CheckResult> {
  const localC2pa = await deps.readC2pa(collected.mediaType, collected.bytes, deps.wasmSource);
  const localXmp = deps.scanXmp(collected.bytes);
  const result: CheckResult = {
    imageHash: collected.imageHash,
    mediaType: collected.mediaType,
    verdict: "no_signal",
    localC2pa,
    localXmp,
    openai: { state: "not_checked" },
  };
  return { ...result, verdict: computeVerdict(result) };
}

// Cache access is best-effort: chrome.storage.session can reject (quota) or be
// unavailable, and losing the cache must never cost the user their result. On
// failure the check proceeds uncached rather than aborting before the update.
async function safeGetResult(deps: CheckDeps, imageHash: string): Promise<CheckResult | undefined> {
  try {
    return await getResult(deps.store, imageHash);
  } catch (error) {
    console.error("cache read failed", error);
    return undefined;
  }
}

async function safePut(deps: CheckDeps, write: (store: CacheStore) => Promise<void>): Promise<void> {
  try {
    await write(deps.store);
  } catch (error) {
    console.error("cache write failed", error);
  }
}

export async function runCheckSteps(deps: CheckDeps, input: CheckInput): Promise<CheckOutcome> {
  const { checkId, srcUrl, frameUrl, tabId, frameId } = input;
  // The update carries the page's srcUrl unchanged: the content script matches
  // it to find the image. Only the cached record drops a data: payload.
  await deps.sendUpdate({ type: "checkUpdate", checkId, srcUrl, status: "checking" });

  const collected: CollectedImage = await collectImage(srcUrl, {
    fetchImpl: deps.fetchImpl,
    readBlob: deps.readBlob,
  });
  if (collected.kind === "error") {
    await deps.sendUpdate({ type: "checkUpdate", checkId, srcUrl, status: "failed", error: collected.error });
    return { kind: "failed", error: collected.error };
  }

  // Step 5: a cached result is used as is; only the bytes (for the hash) were
  // downloaded, so both local checks are skipped.
  const cached = await safeGetResult(deps, collected.imageHash);
  const result = cached ?? (await runLocalChecks(deps, collected));

  // Step 7: write both entries before notifying. The opened check record is
  // what the M4 OpenAI flow looks up (#11). Neither a CheckError nor an OpenAI
  // error is ever cached.
  await safePut(deps, (store) => putResult(store, result));
  await safePut(deps, (store) =>
    putCheck(store, {
      checkId,
      srcUrl,
      frameUrl,
      tabId,
      frameId,
      imageHash: collected.imageHash,
      mediaType: collected.mediaType,
      size: collected.size,
    }),
  );

  const hasKey = await deps.hasApiKey();
  const openai: OpenAiAvailability = hasKey ? { available: true } : { available: false, reason: "no_key" };
  const done: CheckUpdate = { type: "checkUpdate", checkId, srcUrl, status: "done", result, openai };
  await deps.sendUpdate(done);
  return { kind: "done", openai };
}
