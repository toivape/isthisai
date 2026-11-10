// The TÄ rule (PLAN §4 "TÄ rule"). Pure functions only: the result is
// passed around as data, so the verdict can be recomputed at any time.

import type { CheckResult, OpenAiResultPart } from "../shared/types";

function openAiC2paIsSignal(openai: OpenAiResultPart): boolean {
  if (openai.state !== "done") return false;
  return openai.c2pa.outcome === "detected" && (openai.c2pa.validation === "trusted" || openai.c2pa.validation === "valid");
}

function openAiSynthidIsSignal(openai: OpenAiResultPart): boolean {
  return openai.state === "done" && openai.synthid.outcome === "detected";
}

export function computeVerdict(result: CheckResult): CheckResult["verdict"] {
  if (result.localC2pa.manifest === "present" && result.localC2pa.aiAction) return "ai_signal";
  if (result.localXmp.state === "detected") return "ai_signal";
  if (openAiC2paIsSignal(result.openai)) return "ai_signal";
  if (openAiSynthidIsSignal(result.openai)) return "ai_signal";
  if (result.localC2pa.manifest === "error" || result.localC2pa.manifest === "remote_unfetched") return "incomplete";
  if (result.localXmp.state === "error") return "incomplete";
  return "no_signal";
}

// Merges an OpenAI check into a stored local result: local parts are never
// touched, the openai part is replaced and the verdict recomputed.
export function mergeOpenAi(result: CheckResult, openai: OpenAiResultPart): CheckResult {
  return { ...result, openai, verdict: computeVerdict({ ...result, openai }) };
}
