import { describe, expect, test } from "vitest";
import { isConsentSender, PendingConsents } from "../src/background/consent";

// The confirmation boundary (PLAN §4 step 8.2, hard rule 5): only a check that
// is actually open may answer, and only from the extension's own confirmation
// page. index.ts opens the window and feeds the answers in here.

const CONFIRM_PREFIX = "chrome-extension://abc/src/confirm/";
const confirmSender = { url: `${CONFIRM_PREFIX}confirm.html?view=confirm&checkId=c1` };
const pageSender = { url: "https://page.example/" };

describe("isConsentSender", () => {
  test("accepts the extension's own confirmation page", () => {
    expect(isConsentSender(confirmSender, CONFIRM_PREFIX)).toBe(true);
  });

  test("refuses an injected content script, another extension page and anything else", () => {
    // A content script reports the page's URL, so a script in a page can never
    // look like the confirmation window. Without this, a page could forge the
    // consent hard rule 5 requires.
    expect(isConsentSender(pageSender, CONFIRM_PREFIX)).toBe(false);
    expect(isConsentSender({ url: "chrome-extension://abc/src/options/options.html" }, CONFIRM_PREFIX)).toBe(false);
    expect(isConsentSender({ url: "chrome-extension://other/src/confirm/confirm.html" }, CONFIRM_PREFIX)).toBe(false);
    expect(isConsentSender({}, CONFIRM_PREFIX)).toBe(false);
  });
});

describe("PendingConsents", () => {
  test("an answering confirmation page resolves the open check with its answer", async () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    const answer = pending.open("c1");
    expect(pending.answer("c1", confirmSender, true)).toBe("accepted");
    await expect(answer).resolves.toBe(true);
  });

  test("a declined answer resolves false", async () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    const answer = pending.open("c1");
    expect(pending.answer("c1", confirmSender, false)).toBe("accepted");
    await expect(answer).resolves.toBe(false);
  });

  test("an answer from a page is refused and leaves the check open", async () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    const answer = pending.open("c1");
    expect(pending.answer("c1", pageSender, true)).toBe("refused");
    // Still open: the real window can still answer.
    expect(pending.answer("c1", confirmSender, false)).toBe("accepted");
    await expect(answer).resolves.toBe(false);
  });

  test("an answer for a checkId with no open window is unknown", () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    expect(pending.answer("missing", confirmSender, true)).toBe("unknown");
  });

  test("an answer naming a different checkId does not resolve the open one", async () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    const answer = pending.open("c1");
    expect(pending.answer("c2", confirmSender, true)).toBe("unknown");
    // c1 is untouched and can still be answered.
    expect(pending.answer("c1", confirmSender, true)).toBe("accepted");
    await expect(answer).resolves.toBe(true);
  });

  test("only the first answer resolves a check; a second is unknown", async () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    const answer = pending.open("c1");
    expect(pending.answer("c1", confirmSender, true)).toBe("accepted");
    expect(pending.answer("c1", confirmSender, true)).toBe("unknown");
    await expect(answer).resolves.toBe(true);
  });

  test("a removed window declines its check", async () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    const answer = pending.open("c1");
    expect(pending.decline("c1")).toBe(true);
    await expect(answer).resolves.toBe(false);
  });

  test("a late answer after the window was removed is unknown, not a second decision", async () => {
    // The page's own close signal can arrive after windows.onRemoved already
    // declined the check; it must not resolve the same check twice.
    const pending = new PendingConsents(CONFIRM_PREFIX);
    const answer = pending.open("c1");
    pending.decline("c1");
    await expect(answer).resolves.toBe(false);
    expect(pending.answer("c1", confirmSender, true)).toBe("unknown");
  });

  test("declining a check with no open window is a no-op", () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    expect(pending.decline("missing")).toBe(false);
  });

  test("opening the same check twice declines the first wait instead of orphaning it", async () => {
    const pending = new PendingConsents(CONFIRM_PREFIX);
    const first = pending.open("c1");
    const second = pending.open("c1");
    await expect(first).resolves.toBe(false);
    expect(pending.answer("c1", confirmSender, true)).toBe("accepted");
    await expect(second).resolves.toBe(true);
  });
});
