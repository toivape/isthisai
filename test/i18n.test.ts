import { afterEach, describe, expect, test } from "vitest";
import { applyI18n } from "../src/shared/i18n";

// Hand-rolled fakes: applyI18n only reads querySelectorAll and (for
// documents) documentElement.lang, and chrome.i18n. No DOM emulation needed.
function fakeChrome(messages: Record<string, string>, uiLanguage: string): void {
  (globalThis as { chrome?: unknown }).chrome = {
    i18n: {
      getMessage: (key: string) => messages[key] ?? "",
      getUILanguage: () => uiLanguage,
    },
  };
}

function element(dataset: Record<string, string>): { dataset: Record<string, string>; textContent: string } {
  return { dataset, textContent: "" };
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("applyI18n", () => {
  test("fills textContent from data-i18n keys", () => {
    fakeChrome({ greet: "Terve" }, "fi");
    const el = element({ i18n: "greet" });
    const root = { querySelectorAll: () => [el] };
    applyI18n(root as unknown as ShadowRoot);
    expect(el.textContent).toBe("Terve");
  });

  test("sets the document language from the UI locale for documents", () => {
    fakeChrome({}, "fi");
    const documentElement = { lang: "" };
    const root = { querySelectorAll: () => [], documentElement };
    applyI18n(root as unknown as Document);
    expect(documentElement.lang).toBe("fi");
  });

  test("never touches lang when localizing a shadow root", () => {
    fakeChrome({}, "fi");
    const root = { querySelectorAll: () => [] };
    applyI18n(root as unknown as ShadowRoot);
  });
});
