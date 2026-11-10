import { describe, expect, test } from "vitest";
import { badgeAction } from "../src/content/badge";
import type { CheckUpdate } from "../src/shared/types";

type Verdict = "ai_signal" | "no_signal" | "incomplete";

type DoneUpdate = Extract<CheckUpdate, { status: "done" }>;

const done = (verdict: Verdict): DoneUpdate =>
  ({
    type: "checkUpdate",
    checkId: "c1",
    srcUrl: "https://example.test/i.png",
    status: "done",
    result: {
      imageHash: "h",
      mediaType: "image/png",
      verdict,
      localC2pa: { manifest: "absent", aiAction: false },
      localXmp: { state: "not_detected" },
      openai: { state: "not_checked" },
    },
    openai: { available: false, reason: "no_key" },
  }) as unknown as DoneUpdate;

describe("badgeAction", () => {
  test("ai_signal adds the badge", () => {
    expect(badgeAction(done("ai_signal"))).toBe("add");
  });

  test("no_signal removes an existing badge (a recheck must not keep a stale TÄ)", () => {
    expect(badgeAction(done("no_signal"))).toBe("remove");
  });

  test("incomplete removes an existing badge", () => {
    expect(badgeAction(done("incomplete"))).toBe("remove");
  });
});
