import { describe, expect, test } from "vitest";
import { matchesSrcUrl } from "../src/content/findImages";
import { installOnce } from "../src/content/installOnce";
import { isBadgeVisible, shouldBadge } from "../src/content/badge";
import { isStaleUpdate, verdictPresentation } from "../src/content/presentation";
import { readFileSync } from "node:fs";
import type { CheckUpdate } from "../src/shared/types";
import type { ContentShell } from "../src/content/index";

// Hand-rolled fakes in the style of test/i18n.test.ts: matchesSrcUrl reads
// only src, currentSrc and baseURI, so a plain object is enough.
interface FakeImage {
  src: string;
  currentSrc: string;
  baseURI?: string;
}

const base = "https://example.com/page.html";

function fakeImage({ src, currentSrc, baseURI = base }: FakeImage): unknown {
  return { src, currentSrc, baseURI };
}

describe("matchesSrcUrl", () => {
  test("matches by currentSrc", () => {
    const img = fakeImage({ src: "loading.gif", currentSrc: "https://cdn.example.com/photo.jpg" });
    expect(matchesSrcUrl(img, "https://cdn.example.com/photo.jpg")).toBe(true);
  });

  test("matches by src when currentSrc is empty", () => {
    const img = fakeImage({ src: "https://example.com/pic.png", currentSrc: "" });
    expect(matchesSrcUrl(img, "https://example.com/pic.png")).toBe(true);
  });

  test("resolves a relative src against the element's baseURI", () => {
    const img = fakeImage({ src: "/img/cat.webp", currentSrc: "", baseURI: "https://example.com/page.html" });
    expect(matchesSrcUrl(img, "https://example.com/img/cat.webp")).toBe(true);
  });

  test("resolves a relative src against a <base> element's origin", () => {
    const img = fakeImage({ src: "images/dog.png", currentSrc: "", baseURI: "https://other.example.org/app/page.html" });
    expect(matchesSrcUrl(img, "https://other.example.org/app/images/dog.png")).toBe(true);
  });

  test("does not match a different url", () => {
    const img = fakeImage({ src: "https://example.com/a.png", currentSrc: "https://script.example.com/a.png" });
    expect(matchesSrcUrl(img, "https://example.com/b.png")).toBe(false);
  });

  test("does not match a lazy-load placeholder src that is not the srcUrl", () => {
    const img = fakeImage({ src: "data:image/gif;base64,loading", currentSrc: "https://example.com/x.png" });
    expect(matchesSrcUrl(img, "https://example.com/y.png")).toBe(false);
  });

  test("matches data: and blob: urls exactly", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const blobUrl = "blob:https://example.com/uuid-1";
    expect(matchesSrcUrl(fakeImage({ src: dataUrl, currentSrc: dataUrl }), dataUrl)).toBe(true);
    expect(matchesSrcUrl(fakeImage({ src: blobUrl, currentSrc: blobUrl }), blobUrl)).toBe(true);
  });
});

describe("installOnce", () => {
  test("runs the factory on the first call and stores the instance", () => {
    const window = globalThis as Record<string, unknown>;
    const instance = shellWithMarker(1);
    let runs = 0;
    const installed = installOnce("install-once-key-a", () => {
      runs += 1;
      return instance;
    });
    expect(installed).toBe(instance);
    expect(runs).toBe(1);
    expect(window["install-once-key-a"]).toBe(instance);
  });

  test("returns the existing instance on a second call without re-running the factory", () => {
    const window = globalThis as Record<string, unknown>;
    const first = shellWithMarker("first");
    let runs = 0;
    installOnce("install-once-key-b", () => {
      runs += 1;
      return first;
    });
    const installedAgain = installOnce("install-once-key-b", () => shellWithMarker("second"));
    expect(installedAgain).toBe(first);
    expect(runs).toBe(1);
    expect(window["install-once-key-b"]).toBe(first);
  });
});

function shellWithMarker(marker: unknown): ContentShell {
  return { handleCheckUpdate: () => {} , marker } as unknown as ContentShell;
}

describe("isBadgeVisible", () => {
  const viewport = { width: 1000, height: 800 };
  const rect = (top: number, left: number, width: number, height: number) => ({
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
  });

  test("visible when the image is inside the viewport", () => {
    expect(isBadgeVisible(rect(100, 100, 200, 150), viewport, true)).toBe(true);
  });

  test("visible when the image is partly scrolled out", () => {
    expect(isBadgeVisible(rect(-100, 100, 200, 150), viewport, true)).toBe(true);
  });

  test("hidden when the image is fully above the viewport", () => {
    expect(isBadgeVisible(rect(-300, 100, 200, 150), viewport, true)).toBe(false);
  });

  test("hidden when the image is fully below the viewport", () => {
    expect(isBadgeVisible(rect(900, 100, 200, 150), viewport, true)).toBe(false);
  });

  test("hidden when the image is fully left or right of the viewport", () => {
    expect(isBadgeVisible(rect(100, -500, 200, 150), viewport, true)).toBe(false);
    expect(isBadgeVisible(rect(100, 1200, 200, 150), viewport, true)).toBe(false);
  });

  test("hidden when the image has no size (display: none)", () => {
    expect(isBadgeVisible(rect(100, 100, 0, 0), viewport, true)).toBe(false);
  });

  test("hidden when the image is disconnected from the document", () => {
    expect(isBadgeVisible(rect(100, 100, 200, 150), viewport, false)).toBe(false);
  });
});

describe("shouldBadge", () => {
  const result = (verdict: "ai_signal" | "no_signal" | "incomplete") =>
    ({
      type: "checkUpdate",
      checkId: "c",
      srcUrl: "https://example.com/a.png",
      status: "done",
      openai: { available: false, reason: "no_key" },
      result: { verdict },
    }) as unknown as CheckUpdate;

  test("badges only a finished check with an AI signal", () => {
    expect(shouldBadge(result("ai_signal"))).toBe(true);
  });

  test("does not badge no_signal or incomplete results", () => {
    expect(shouldBadge(result("no_signal"))).toBe(false);
    expect(shouldBadge(result("incomplete"))).toBe(false);
  });

  test("does not badge a check in progress or a failed check", () => {
    const base = { type: "checkUpdate", checkId: "c", srcUrl: "https://example.com/a.png" };
    expect(shouldBadge({ ...base, status: "checking" } as CheckUpdate)).toBe(false);
    expect(shouldBadge({ ...base, status: "failed", error: { code: "timeout" } } as CheckUpdate)).toBe(false);
  });
});

describe("no-signal caveat strings", () => {
  const caveat = (locale: string): string =>
    JSON.parse(readFileSync(`_locales/${locale}/messages.json`, "utf8")).popup_caveat_no_signal.message;

  test("name the missing signal instead of relying on a preceding headline", () => {
    expect(caveat("en")).toBe("No signal does not mean the image is human-made.");
    expect(caveat("fi")).toMatch(/^Tekoälyn merkin puuttuminen/);
  });
});

describe("isStaleUpdate", () => {
  const update = (status: "checking" | "done" | "failed", checkId: string) =>
    ({ type: "checkUpdate", checkId, srcUrl: "u", status }) as unknown as CheckUpdate;

  test("a checking update is never stale", () => {
    expect(isStaleUpdate("a", update("checking", "b"))).toBe(false);
  });

  test("a done or failed update for another check is stale", () => {
    expect(isStaleUpdate("b", update("done", "a"))).toBe(true);
    expect(isStaleUpdate("b", update("failed", "a"))).toBe(true);
  });

  test("a terminal update for the active check is not stale", () => {
    expect(isStaleUpdate("a", update("done", "a"))).toBe(false);
  });

  test("with no active check a terminal update is accepted (failure before any checking)", () => {
    expect(isStaleUpdate(undefined, update("failed", "a"))).toBe(false);
  });
});

describe("verdictPresentation", () => {
  test("ai_signal has the AI headline and no extra detail", () => {
    expect(verdictPresentation("ai_signal")).toEqual({ headlineKey: "popup_headline_ai_signal" });
  });

  test("no_signal has the no-signal headline", () => {
    expect(verdictPresentation("no_signal")).toEqual({ headlineKey: "popup_headline_no_signal" });
  });

  test("incomplete is never presented as no signal", () => {
    expect(verdictPresentation("incomplete")).toEqual({
      headlineKey: "popup_headline_incomplete",
      detailKey: "popup_detail_incomplete",
    });
  });
});
