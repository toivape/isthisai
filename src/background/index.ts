// Service worker entry: context-menu registration, on-demand injection.
// Nothing runs before a menu click (hard rule 1). The worker can be stopped
// at any time, so listeners are registered synchronously and no state is
// kept in module variables.

import type { CheckError, CheckUpdate, DismissPopup, ReadBlobReply } from "../shared/types";
import { resultWindowPath } from "../shared/errors";
import { runCheckSteps } from "./check";
import { readC2pa } from "./c2pa";
import { readBlobRequest } from "./fetchImage";
import { needsPermissionRequest } from "./permissions";

const MENU_ID = "check-ai-signals";

// Storage must be restricted to trusted contexts on every worker start,
// so content scripts can never read the stored API key.
void chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(console.error);

// The worker restarts constantly (any event, ~30 s idle), so registration
// must be idempotent: a bare create() logs "duplicate id" on every restart.
void chrome.contextMenus.removeAll(() => {
  void chrome.contextMenus.create({
    id: MENU_ID,
    title: chrome.i18n.getMessage("menu_check_ai_signals"),
    contexts: ["image"],
  });
});

// Restricted frames (chrome://, the Web Store, other extensions' pages)
// cannot be injected; the result window shows the result there instead.
const RESULT_WINDOW_KEY = "resultWindowId";

async function openResultWindow(error?: CheckError): Promise<void> {
  const stored = await chrome.storage.session.get(RESULT_WINDOW_KEY);
  const existingId: unknown = stored[RESULT_WINDOW_KEY];
  const url = resultWindowPath(error);
  if (typeof existingId === "number") {
    try {
      // Re-point the open window at this request so it never shows a stale error.
      const existing = await chrome.windows.get(existingId, { populate: true });
      const existingTabId = existing.tabs?.[0]?.id;
      if (existingTabId !== undefined) await chrome.tabs.update(existingTabId, { url: chrome.runtime.getURL(url) });
      await chrome.windows.update(existingId, { focused: true });
      return;
    } catch {
      // window was closed; open a new one
    }
  }
  const created = await chrome.windows.create({ type: "popup", url, width: 420, height: 320 });
  if (created?.id !== undefined) await chrome.storage.session.set({ [RESULT_WINDOW_KEY]: created.id });
}

// Reads a blob: URL in the frame that owns it (only the page can); the reply
// is base64 (messages are JSON-only). A missing reader (frame not injected)
// behaves like a revoked blob: fetch_failed.
async function readBlobInFrame(tabId: number, frameId: number, checkId: string, url: string): Promise<ReadBlobReply> {
  try {
    const reply: unknown = await chrome.tabs.sendMessage(tabId, readBlobRequest(checkId, url), { frameId });
    if (reply && typeof reply === "object" && "ok" in reply) return reply as ReadBlobReply;
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function notifyFailed(
  tabId: number,
  frameId: number,
  checkId: string,
  srcUrl: string,
  error: CheckError,
): Promise<void> {
  const update = { type: "checkUpdate", checkId, srcUrl, status: "failed", error } satisfies CheckUpdate;
  try {
    await chrome.tabs.sendMessage(tabId, update, { frameId });
  } catch {
    // No content script in the frame (e.g. permission denied before injection).
    await openResultWindow(error).catch(console.error);
  }
}

// The API key is read only here (hard rule 3) and only to decide whether the
// OpenAI check is offered; the key itself never leaves the worker.
async function hasApiKey(): Promise<boolean> {
  const stored: unknown = await chrome.storage.local.get("apiKey");
  return typeof (stored as { apiKey?: unknown })?.apiKey === "string" && (stored as { apiKey: string }).apiKey !== "";
}

async function runCheck(input: {
  tabId: number;
  frameId: number;
  srcUrl: string;
  mainFrameUrl: string;
  frameUrl: string;
  permissionGranted: boolean;
}): Promise<void> {
  const { tabId, frameId, srcUrl, permissionGranted } = input;
  const checkId = crypto.randomUUID();

  if (!permissionGranted) {
    // Establish the check in the frame first: a failed update with an
    // unknown checkId is dropped by the stale-update guard, and a live
    // content script would swallow the denial message otherwise.
    const checking: CheckUpdate = { type: "checkUpdate", checkId, srcUrl, status: "checking" };
    await chrome.tabs.sendMessage(tabId, checking, { frameId }).catch(() => undefined);
    await notifyFailed(tabId, frameId, checkId, srcUrl, { code: "permission_denied" });
    return;
  }

  const dismiss = { type: "dismissPopup" } satisfies DismissPopup;

  try {
    await chrome.tabs.sendMessage(tabId, dismiss).catch(() => undefined); // no frame has the script yet
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content/index.js"] });
  } catch (error) {
    console.error("injection failed", error);
    await openResultWindow().catch(console.error);
    return;
  }

  await runCheckSteps(
    {
      sendUpdate: (update) => chrome.tabs.sendMessage(tabId, update, { frameId }).catch(() => undefined),
      readBlob: (url) => readBlobInFrame(tabId, frameId, checkId, url),
      readC2pa,
      wasmSource: chrome.runtime.getURL("c2pa.wasm"),
      hasApiKey,
    },
    { checkId, srcUrl },
  );
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || !info.srcUrl || info.frameId === undefined) return;
  const tabId = tab.id;
  const frameId = info.frameId;
  const srcUrl = info.srcUrl;
  // The main-frame origin decides whether the image origin is cross-origin;
  // tab.url is the main frame's URL.
  const mainFrameUrl = tab.url ?? "";
  const frameUrl = info.frameUrl ?? mainFrameUrl;

  // permissions.request must run synchronously here, while the menu click's
  // user gesture is live: any await before it drops the gesture ("This
  // function must be called during a user gesture"; measured by the owner in
  // Brave, PLAN §4 step 1). An already-granted permission resolves request()
  // true without prompting, so the URL analysis alone decides.
  let permissionGranted = true;
  if (needsPermissionRequest(mainFrameUrl, frameUrl, srcUrl)) {
    permissionGranted = false; // awaited below, but the call itself is synchronous
    void chrome.permissions
      .request({ origins: ["<all_urls>"] })
      .then((granted) => {
        void runCheck({ tabId, frameId, srcUrl, mainFrameUrl, frameUrl, permissionGranted: granted }).catch((error: unknown) => {
          console.error("check failed", error);
        });
      })
      .catch((error: unknown) => {
        console.error("permission request failed", error);
        void runCheck({ tabId, frameId, srcUrl, mainFrameUrl, frameUrl, permissionGranted: false }).catch((error: unknown) => {
          console.error("check failed", error);
        });
      });
    return;
  }

  void runCheck({ tabId, frameId, srcUrl, mainFrameUrl, frameUrl, permissionGranted }).catch((error: unknown) => {
    console.error("check failed", error);
  });
});
