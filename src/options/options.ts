import { applyI18n, message } from "../shared/i18n";
import { openAiErrorMessage } from "../shared/openaiErrors";
import { isKeyStatusReply, isTestKeyReply, type KeyStatus, type TestKey } from "../shared/types";
import { isStaleTestReply, optionsStatusKey, testEnabled, type OptionsState } from "./state";

applyI18n(document);

// The options page writes or clears the key and never reads it back (hard rule
// 3): it learns only whether one is stored, from the worker's keyStatus reply.
// The key field is cleared after saving so the value does not linger on screen.
// The decisions live in state.ts; this file only touches the DOM.

const keyInput = document.getElementById("key") as HTMLInputElement | null;
const status = document.getElementById("status");
const testResult = document.getElementById("test-result");
const testButton = document.getElementById("test") as HTMLButtonElement | null;

const state: OptionsState = { hasKey: undefined, revision: 0, testInFlight: false };

function setText(element: HTMLElement | null, text: string | undefined): void {
  if (element === null) return;
  if (text === undefined) element.setAttribute("hidden", "");
  else {
    element.removeAttribute("hidden");
    element.textContent = text;
  }
}

// A reply that never arrives or does not parse means the worker did not answer
// (reloaded mid-request, for example); saying so beats an empty line, and it is
// not the same as "no key saved".
async function request<T extends KeyStatus | TestKey>(request: T): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(request);
  } catch (error) {
    console.error("options: no reply from the worker", error);
    return undefined;
  }
}

function render(): void {
  setText(status, message(optionsStatusKey(state)));
  if (testButton !== null) testButton.disabled = !testEnabled(state);
}

async function refreshStatus(): Promise<void> {
  const reply = await request({ type: "keyStatus" } satisfies KeyStatus);
  state.hasKey = isKeyStatusReply(reply) ? reply.hasKey : undefined;
  render();
}

// A save or a clear makes any verdict on screen, and any test still running,
// describe a key the user no longer has.
function keyChanged(): void {
  state.revision += 1;
  setText(testResult, undefined);
  render();
}

document.getElementById("save")?.addEventListener("click", () => {
  const value = keyInput?.value ?? "";
  if (value.trim() === "") return;
  keyChanged();
  void chrome.storage.local.set({ apiKey: value }).then(async () => {
    if (keyInput !== null) keyInput.value = "";
    await refreshStatus();
  }, console.error);
});

document.getElementById("clear")?.addEventListener("click", () => {
  keyChanged();
  void chrome.storage.local.remove("apiKey").then(async () => {
    if (keyInput !== null) keyInput.value = "";
    await refreshStatus();
  }, console.error);
});

testButton?.addEventListener("click", () => {
  if (!testEnabled(state)) return;
  const startedAt = state.revision;
  state.testInFlight = true;
  render();
  setText(testResult, message("options_test_sending"));
  void (async () => {
    const reply = await request({ type: "testKey" } satisfies TestKey);
    state.testInFlight = false;
    // The key changed while the upload was running: the answer is about a key
    // that is no longer saved, so drop it rather than restore a stale verdict.
    if (!isStaleTestReply(state, startedAt)) {
      if (!isTestKeyReply(reply)) {
        setText(testResult, message("error_openai_unusable_reply"));
      } else {
        const { key, substitutions } = reply.ok
          ? { key: "options_test_ok", substitutions: undefined }
          : openAiErrorMessage(reply.error);
        setText(testResult, message(key, substitutions));
      }
    }
    await refreshStatus();
  })();
});

void refreshStatus();
