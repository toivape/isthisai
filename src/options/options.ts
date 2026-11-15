import { applyI18n, message } from "../shared/i18n";
import { openAiErrorMessage } from "../shared/openaiErrors";
import { isKeyStatusReply, isTestKeyReply, type KeyStatus, type TestKey } from "../shared/types";

applyI18n(document);

// The options page writes or clears the key and never reads it back (hard rule
// 3): it learns only whether one is stored, from the worker's keyStatus reply.
// The key field is cleared after saving so the value does not linger on screen.

const keyInput = document.getElementById("key") as HTMLInputElement | null;
const status = document.getElementById("status");
const testResult = document.getElementById("test-result");
const testButton = document.getElementById("test") as HTMLButtonElement | null;

function setText(element: HTMLElement | null, text: string | undefined): void {
  if (element === null) return;
  if (text === undefined) element.setAttribute("hidden", "");
  else {
    element.removeAttribute("hidden");
    element.textContent = text;
  }
}

// A reply that never arrives or does not parse means the worker did not answer
// (reloaded mid-request, for example); saying so beats an empty line.
async function request<T extends KeyStatus | TestKey>(request: T): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(request);
  } catch (error) {
    console.error("options: no reply from the worker", error);
    return undefined;
  }
}

async function refreshStatus(): Promise<void> {
  const reply = await request({ type: "keyStatus" } satisfies KeyStatus);
  const hasKey = isKeyStatusReply(reply) && reply.hasKey;
  setText(status, message(hasKey ? "options_key_saved" : "options_key_absent"));
  if (testButton !== null) testButton.disabled = !hasKey;
}

document.getElementById("save")?.addEventListener("click", () => {
  const value = keyInput?.value ?? "";
  if (value.trim() === "") return;
  void chrome.storage.local.set({ apiKey: value }).then(async () => {
    if (keyInput !== null) keyInput.value = "";
    await refreshStatus();
  }, console.error);
});

document.getElementById("clear")?.addEventListener("click", () => {
  void chrome.storage.local.remove("apiKey").then(async () => {
    if (keyInput !== null) keyInput.value = "";
    await refreshStatus();
  }, console.error);
});

testButton?.addEventListener("click", () => {
  setText(testResult, message("options_test_sending"));
  void request({ type: "testKey" } satisfies TestKey).then((reply: unknown) => {
    if (!isTestKeyReply(reply)) {
      setText(testResult, message("error_openai_unusable_reply"));
      return;
    }
    const { key, substitutions } = reply.ok
      ? { key: "options_test_ok", substitutions: undefined }
      : openAiErrorMessage(reply.error);
    setText(testResult, message(key, substitutions));
  }, console.error);
});

void refreshStatus();
