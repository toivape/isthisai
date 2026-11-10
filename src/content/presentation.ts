import type { CheckResult, CheckUpdate } from "../shared/types";

// A done/failed update for a check other than the active one must not replace
// the newer check's popup. "checking" always starts a new active check.
export function isStaleUpdate(activeCheckId: string | undefined, update: CheckUpdate): boolean {
  if (update.status === "checking") return false;
  return activeCheckId !== undefined && activeCheckId !== update.checkId;
}

// "incomplete" must never read as "No AI signal found" (hard rule 8: the
// wording has to match what was actually established).
export function verdictPresentation(verdict: CheckResult["verdict"]): { headlineKey: string; detailKey?: string } {
  switch (verdict) {
    case "ai_signal":
      return { headlineKey: "popup_headline_ai_signal" };
    case "no_signal":
      return { headlineKey: "popup_headline_no_signal" };
    case "incomplete":
      return { headlineKey: "popup_headline_incomplete", detailKey: "popup_detail_incomplete" };
  }
}
