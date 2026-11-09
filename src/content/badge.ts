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
