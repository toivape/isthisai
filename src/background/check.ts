// The check pipeline (PLAN §4 steps 3–7), as a pure function over injected
// dependencies so it runs in tests without chrome and #20 can add steps
// (cache, XMP) without rewriting the sequence. XMP arrives in #8/#20; until
// then localXmp is a plain not_detected. Caching also arrives in #20, so a
// fresh result is computed on every call for now.

import { readC2pa } from "./c2pa";
import { collectImage, type CollectedImage } from "./fetchImage";
import { computeVerdict } from "./verdict";
import type { CheckError, CheckUpdate, OpenAiAvailability, ReadBlobReply } from "../shared/types";

export interface CheckInput {
  checkId: string;
  srcUrl: string;
}

export interface CheckDeps {
  sendUpdate: (update: CheckUpdate) => void | Promise<void>;
  readBlob: (url: string) => Promise<ReadBlobReply>;
  fetchImpl?: typeof fetch;
  readC2pa: typeof readC2pa;
  wasmSource: BufferSource | string;
  hasApiKey: () => Promise<boolean>;
}

export type CheckOutcome = { kind: "done"; openai: OpenAiAvailability } | { kind: "failed"; error: CheckError };

export async function runCheckSteps(deps: CheckDeps, input: CheckInput): Promise<CheckOutcome> {
  const { checkId, srcUrl } = input;
  await deps.sendUpdate({ type: "checkUpdate", checkId, srcUrl, status: "checking" });

  const collected: CollectedImage = await collectImage(srcUrl, {
    fetchImpl: deps.fetchImpl,
    readBlob: deps.readBlob,
  });
  if (collected.kind === "error") {
    await deps.sendUpdate({ type: "checkUpdate", checkId, srcUrl, status: "failed", error: collected.error });
    return { kind: "failed", error: collected.error };
  }

  // Local checks never leave the machine (hard rule 5); only the confirmed
  // OpenAI upload ever does, and that is not part of this path yet.
  const localC2pa = await deps.readC2pa(collected.mediaType, collected.bytes, deps.wasmSource);
  const result = {
    imageHash: collected.imageHash,
    mediaType: collected.mediaType,
    verdict: "no_signal" as const,
    localC2pa,
    localXmp: { state: "not_detected" as const },
    openai: { state: "not_checked" as const },
  };
  const verdict = computeVerdict(result);
  const hasKey = await deps.hasApiKey();
  const openai: OpenAiAvailability = hasKey ? { available: true } : { available: false, reason: "no_key" };
  const done: CheckUpdate = {
    type: "checkUpdate",
    checkId,
    srcUrl,
    status: "done",
    result: { ...result, verdict },
    openai,
  };
  await deps.sendUpdate(done);
  return { kind: "done", openai };
}
