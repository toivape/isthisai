import type { CheckResult, CheckUpdate } from "../shared/types";

// A check dismissed tab-wide (a newer check started in another frame) is
// invalidated: its terminal updates must not reopen a popup next to the
// newer check's. Only a new "checking" update reopens this frame.
export const DISMISS_ID = "__dismissed__";

// A done/failed update for a check other than the one this frame follows must
// not replace the newer check's popup. "checking" always starts a new followed
// check. A check whose result the user opened from a badge (requestedCheckId) is
// accepted too, without displacing the running one: an OpenAI upload is slow
// enough for another image to be checked in between.
export function isStaleUpdate(
  followedCheckId: string | undefined,
  update: CheckUpdate,
  requestedCheckId?: string,
): boolean {
  if (update.status === "checking") return false;
  if (requestedCheckId === update.checkId) return false;
  if (followedCheckId === DISMISS_ID) return true;
  return followedCheckId !== undefined && followedCheckId !== update.checkId;
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
