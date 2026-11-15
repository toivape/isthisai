import { describe, expect, test } from "vitest";
import { isStaleTestReply, optionsStatusKey, testEnabled, type OptionsState } from "../src/options/state";

function state(overrides: Partial<OptionsState> = {}): OptionsState {
  return { hasKey: false, revision: 0, testInFlight: false, ...overrides };
}

describe("optionsStatusKey", () => {
  test("reports a saved key, an absent key, and a worker that did not answer", () => {
    expect(optionsStatusKey(state({ hasKey: true }))).toBe("options_key_saved");
    expect(optionsStatusKey(state({ hasKey: false }))).toBe("options_key_absent");
    // undefined means no usable reply, which must not be reported as "no key":
    // storage may well hold one (the old behaviour did exactly that).
    expect(optionsStatusKey(state({ hasKey: undefined }))).toBe("error_openai_unusable_reply");
  });
});

describe("testEnabled", () => {
  test("needs a known key and no test already running", () => {
    expect(testEnabled(state({ hasKey: true }))).toBe(true);
    expect(testEnabled(state({ hasKey: true, testInFlight: true }))).toBe(false);
    expect(testEnabled(state({ hasKey: false }))).toBe(false);
    expect(testEnabled(state({ hasKey: undefined }))).toBe(false);
  });
});

describe("isStaleTestReply", () => {
  test("a reply is stale once the saved key has changed", () => {
    // Testing key A and then saving key B must not leave A's verdict on screen.
    expect(isStaleTestReply(state({ revision: 3 }), 3)).toBe(false);
    expect(isStaleTestReply(state({ revision: 4 }), 3)).toBe(true);
  });
});
