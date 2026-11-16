import { describe, expect, test } from "vitest";
import {
  MAX_REMEMBERED_DATA_CHARS,
  MAX_REMEMBERED_DATA_URLS,
  dataUrlToRead,
  findImages,
  findSourceByPrefix,
  matchedSrcPrefix,
  matchesSrcUrl,
  rememberDataUrl,
  srcUrlToMatch,
} from "../src/content/findImages";
import { installOnce } from "../src/content/installOnce";
import { isBadgeVisible, shouldBadge } from "../src/content/badge";
import { isStaleUpdate, verdictPresentation, DISMISS_ID } from "../src/content/presentation";
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

  test("rejects a non-image value and a missing src or currentSrc", () => {
    // The shell passes whatever `querySelectorAll("img")` yielded, but the
    // guard must hold for anything: null, a non-string src, a non-string
    // currentSrc.
    expect(matchesSrcUrl(null, "https://example.com/a.png")).toBe(false);
    expect(matchesSrcUrl(undefined, "https://example.com/a.png")).toBe(false);
    expect(matchesSrcUrl(42, "https://example.com/a.png")).toBe(false);
    expect(matchesSrcUrl({}, "https://example.com/a.png")).toBe(false);
    expect(matchesSrcUrl({ src: "https://example.com/a.png" }, "https://example.com/a.png")).toBe(false);
    expect(matchesSrcUrl({ currentSrc: "https://example.com/a.png" }, "https://example.com/a.png")).toBe(false);
    expect(matchesSrcUrl({ src: 5, currentSrc: "x" }, "x")).toBe(false);
  });

  test("an empty src never matches, even against an empty srcUrl", () => {
    expect(matchesSrcUrl(fakeImage({ src: "", currentSrc: "" }), "")).toBe(true); // currentSrc === srcUrl first
    expect(matchesSrcUrl(fakeImage({ src: "", currentSrc: "https://example.com/a.png" }), "")).toBe(false);
  });

  test("an empty src is not resolved against the baseURI into a match", () => {
    // <img src=""> resolves to the page URL. The guard must reject it before
    // resolvedSrc turns it into the document URL, which could equal the srcUrl.
    const img = fakeImage({ src: "", currentSrc: "placeholder", baseURI: "https://example.com/page.html" });
    expect(matchesSrcUrl(img, "https://example.com/page.html")).toBe(false);
  });

  test("resolves an absolute src without a baseURI", () => {
    expect(matchesSrcUrl({ src: "https://example.com/a.png", currentSrc: "other" }, "https://example.com/a.png")).toBe(true);
  });

  test("falls back to the raw src when it cannot be resolved", () => {
    // A relative src with no baseURI cannot be made absolute: the raw value is
    // compared as-is.
    expect(matchesSrcUrl({ src: "a.png", currentSrc: "other" }, "a.png")).toBe(true);
    expect(matchesSrcUrl({ src: "a.png", currentSrc: "other" }, "https://example.com/a.png")).toBe(false);
  });
});

describe("findImages", () => {
  // A minimal ParentNode: only querySelectorAll is used.
  function fakeRoot(imgs: unknown[]): ParentNode {
    return { querySelectorAll: (selector: string) => (selector === "img" ? imgs : []) } as unknown as ParentNode;
  }

  test("returns only the images whose src matches, in document order", () => {
    const target = "https://cdn.example.com/photo.jpg";
    const other = "https://cdn.example.com/other.jpg";
    const match1 = fakeImage({ src: target, currentSrc: target });
    const miss = fakeImage({ src: other, currentSrc: other });
    const match2 = fakeImage({ src: "placeholder", currentSrc: target });
    const found = findImages(target, fakeRoot([match1, miss, match2]));
    expect(found).toEqual([match1, match2]);
  });

  test("returns an empty array when nothing matches", () => {
    const root = fakeRoot([fakeImage({ src: "https://example.com/a.png", currentSrc: "https://example.com/a.png" })]);
    expect(findImages("https://example.com/b.png", root)).toEqual([]);
  });

  test("queries for img elements specifically", () => {
    const calls: string[] = [];
    const root = {
      querySelectorAll: (selector: string) => {
        calls.push(selector);
        return [];
      },
    } as unknown as ParentNode;
    findImages("https://example.com/a.png", root);
    expect(calls).toEqual(["img"]);
  });
});

describe("the data: source to read", () => {
  // The cache stores a data: srcUrl without its payload (PLAN §3), so the upload
  // flow asks the page for the image by that prefix. The page must hand back the
  // URL that matched, not another candidate: a srcset currentSrc is a different
  // URL, and fetching it is an unintended request (hard rule 7).

  test("returns the matched source, not a srcset candidate", () => {
    const img = fakeImage({ src: "data:image/png;base64,AAAA", currentSrc: "https://cdn.example/photo.jpg" });
    expect(matchedSrcPrefix(img, "data:image/png;base64,")).toBe("data:image/png;base64,AAAA");
  });

  test("returns currentSrc when that is the match", () => {
    const img = fakeImage({ src: "placeholder.gif", currentSrc: "data:image/png;base64,AAAA" });
    expect(matchedSrcPrefix(img, "data:image/png;base64,")).toBe("data:image/png;base64,AAAA");
  });

  test("returns undefined when nothing matches", () => {
    const jpeg = fakeImage({ src: "data:image/jpeg;base64,AAAA", currentSrc: "data:image/jpeg;base64,AAAA" });
    expect(matchedSrcPrefix(jpeg, "data:image/png;base64,")).toBeUndefined();
    expect(matchedSrcPrefix(null, "data:")).toBeUndefined();
  });

  test("findSourceByPrefix skips the images that do not match", () => {
    const other = fakeImage({ src: "data:image/jpeg;base64,CCCC", currentSrc: "data:image/jpeg;base64,CCCC" });
    const png = fakeImage({ src: "data:image/png;base64,PPPP", currentSrc: "data:image/png;base64,PPPP" });
    const root = { querySelectorAll: (selector: string) => (selector === "img" ? [other, png] : []) } as unknown as ParentNode;
    expect(findSourceByPrefix("data:image/png;base64,", root)).toBe("data:image/png;base64,PPPP");
  });

  test("an empty prefix never matches: it would match everything", () => {
    const img = fakeImage({ src: "data:image/png;base64,AAAA", currentSrc: "data:image/png;base64,AAAA" });
    expect(matchedSrcPrefix(img, "")).toBeUndefined();
    expect(findSourceByPrefix("", { querySelectorAll: () => [img] } as unknown as ParentNode)).toBeUndefined();
  });

  test("rejects a non-image value and a missing src or currentSrc", () => {
    expect(matchedSrcPrefix({}, "data:")).toBeUndefined();
    expect(matchedSrcPrefix({ src: "data:x" }, "data:")).toBeUndefined();
    expect(matchedSrcPrefix({ currentSrc: "data:x" }, "data:")).toBeUndefined();
  });

  test("an empty src is not resolved against the baseURI into a match", () => {
    // <img src=""> resolves to the page URL. The guard must reject it before
    // resolvedSrc turns it into a document URL that could match the prefix.
    const img = fakeImage({ src: "", currentSrc: "placeholder", baseURI: "https://example.com/page.html" });
    expect(matchedSrcPrefix(img, "https://example.com/page")).toBeUndefined();
  });

  test("dataUrlToRead prefers the exact URL the check saw, then the first match", () => {
    // Two PNG data: images share the stripped prefix; only the remembered URL
    // says which one was checked.
    const first = fakeImage({ src: "data:image/png;base64,AAAA", currentSrc: "data:image/png;base64,AAAA" });
    const second = fakeImage({ src: "data:image/png;base64,BBBB", currentSrc: "data:image/png;base64,BBBB" });
    const root = { querySelectorAll: (selector: string) => (selector === "img" ? [first, second] : []) } as unknown as ParentNode;

    expect(dataUrlToRead("data:image/png;base64,", "data:image/png;base64,BBBB", root)).toBe("data:image/png;base64,BBBB");
    expect(dataUrlToRead("data:image/png;base64,", undefined, root)).toBe("data:image/png;base64,AAAA");
    // A remembered URL that no longer matches the stored prefix is not used.
    expect(dataUrlToRead("data:image/png;base64,", "https://cdn.example/other.png", root)).toBe("data:image/png;base64,AAAA");
    // The payload-free form is what the worker's own done update remembers; it is
    // not the image, so the page's real one is read instead of an empty payload.
    expect(dataUrlToRead("data:image/png;base64,", "data:image/png;base64,", root)).toBe("data:image/png;base64,AAAA");
    // Nothing on the page matches at all.
    expect(dataUrlToRead("data:image/png;base64,", undefined, { querySelectorAll: () => [] } as unknown as ParentNode)).toBeUndefined();
  });
});

describe("the URL to match images against", () => {
  // The worker's OpenAI done update repeats a data: srcUrl without its payload
  // (PLAN §3), and no <img> carries that form, so the badge would never find the
  // image on that update. The full URL the check saw is matched instead.
  test("replaces a payload-free data: URL with the full one the check saw", () => {
    expect(srcUrlToMatch("data:image/png;base64,", "data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  test("keeps the update's own URL when nothing better is remembered", () => {
    expect(srcUrlToMatch("data:image/png;base64,", undefined)).toBe("data:image/png;base64,");
    expect(srcUrlToMatch("https://cdn.example/a.png", undefined)).toBe("https://cdn.example/a.png");
    // An equal-length remembered URL is the payload-free repeat, not the image.
    expect(srcUrlToMatch("data:image/png;base64,", "data:image/png;base64,")).toBe("data:image/png;base64,");
    // A remembered URL that does not extend the stored one is a different image.
    expect(srcUrlToMatch("data:image/png;base64,", "data:image/jpeg;base64,AAAA")).toBe("data:image/png;base64,");
  });
});

describe("rememberDataUrl", () => {
  const dataUrl = (chars: number): string => `data:image/png;base64,${"A".repeat(chars - "data:image/png;base64,".length)}`;

  test("keeps the full URL and ignores the payload-free repeat", () => {
    const map = new Map<string, string>();
    rememberDataUrl(map, "c1", "data:image/png;base64,AAAA");
    rememberDataUrl(map, "c1", "data:image/png;base64,");
    expect(map.get("c1")).toBe("data:image/png;base64,AAAA");
  });

  test("a longer URL replaces a shorter one, an equal-length one does not, and a refresh moves the check to newest", () => {
    const map = new Map<string, string>();
    rememberDataUrl(map, "a", "data:image/png;base64,");
    rememberDataUrl(map, "b", "data:image/png;base64,BBBB");
    rememberDataUrl(map, "a", "data:image/png;base64,AAAA");
    expect(map.get("a")).toBe("data:image/png;base64,AAAA");
    expect([...map.keys()]).toEqual(["b", "a"]);
    rememberDataUrl(map, "a", "data:image/png;base64,CCCC");
    expect(map.get("a")).toBe("data:image/png;base64,AAAA");
  });

  test("exactly the cap is kept, in one URL or across several", () => {
    const one = new Map<string, string>();
    rememberDataUrl(one, "a", dataUrl(MAX_REMEMBERED_DATA_CHARS));
    expect(one.has("a")).toBe(true);

    const two = new Map<string, string>();
    rememberDataUrl(two, "a", dataUrl(MAX_REMEMBERED_DATA_CHARS / 2));
    rememberDataUrl(two, "b", dataUrl(MAX_REMEMBERED_DATA_CHARS / 2));
    expect([...two.keys()]).toEqual(["a", "b"]);
  });

  test("a non-data: URL forgets the check", () => {
    const map = new Map([["c1", "data:image/png;base64,AAAA"]]);
    rememberDataUrl(map, "c1", "https://cdn.example/a.png");
    expect(map.has("c1")).toBe(false);
  });

  test("evicts the oldest by count", () => {
    const map = new Map<string, string>();
    for (let i = 0; i <= MAX_REMEMBERED_DATA_URLS; i += 1) rememberDataUrl(map, `c${i}`, `data:image/png;base64,${i}`);
    expect(map.size).toBe(MAX_REMEMBERED_DATA_URLS);
    expect(map.has("c0")).toBe(false);
    expect(map.has(`c${MAX_REMEMBERED_DATA_URLS}`)).toBe(true);
  });

  test("evicts the oldest by total size, not just count", () => {
    const map = new Map<string, string>();
    const third = Math.floor(MAX_REMEMBERED_DATA_CHARS / 3) + 1;
    rememberDataUrl(map, "a", dataUrl(third));
    rememberDataUrl(map, "b", dataUrl(third));
    rememberDataUrl(map, "c", dataUrl(third));
    expect([...map.keys()]).toEqual(["b", "c"]);
  });

  test("a URL over the cap is not kept, and drops the stale entry for that check", () => {
    const map = new Map([["a", "data:image/png;base64,AAAA"]]);
    rememberDataUrl(map, "big", dataUrl(MAX_REMEMBERED_DATA_CHARS + 1));
    expect(map.has("big")).toBe(false);
    expect(map.get("a")).toBe("data:image/png;base64,AAAA");
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

describe("dismissed frame rejects until a new check arrives", () => {
  const update = (status: "checking" | "done" | "failed", checkId: string) =>
    ({ type: "checkUpdate", checkId, srcUrl: "u", status }) as unknown as CheckUpdate;

  // After the tab-wide dismiss (check B started elsewhere), frame A must not
  // accept its own in-flight check's terminal update: two popups must never
  // coexist. Only a new "checking" reopens this frame.
  test("a dismissed frame drops the old check's terminal updates", () => {
    expect(isStaleUpdate(DISMISS_ID, update("done", "a"))).toBe(true);
    expect(isStaleUpdate(DISMISS_ID, update("failed", "a"))).toBe(true);
  });

  test("a dismissed frame accepts a new checking update", () => {
    expect(isStaleUpdate(DISMISS_ID, update("checking", "b"))).toBe(false);
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
