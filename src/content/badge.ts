import type { CheckUpdate } from "../shared/types";

interface Box {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export function isBadgeVisible(rect: Box, viewport: { width: number; height: number }, connected: boolean): boolean {
  if (!connected || rect.width === 0 || rect.height === 0) return false;
  return rect.bottom > 0 && rect.top < viewport.height && rect.right > 0 && rect.left < viewport.width;
}

export function shouldBadge(update: CheckUpdate): boolean {
  return update.status === "done" && update.result.verdict === "ai_signal";
}

// A recheck recomputes the verdict on every click (no cache until #20), so a
// no_signal result drops a badge left by an earlier check (stale TÄ would
// reopen the old result). An incomplete check established nothing, so it
// leaves an earlier badge alone.
export type BadgeAction = "add" | "remove" | "keep";

export function badgeAction(update: Extract<CheckUpdate, { status: "done" }>): BadgeAction {
  switch (update.result.verdict) {
    case "ai_signal":
      return "add";
    case "no_signal":
      return "remove";
    case "incomplete":
      return "keep";
  }
}
