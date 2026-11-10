// Service worker entry: context-menu registration, on-demand injection.
// Nothing runs before a menu click (hard rule 1). The worker can be stopped
// at any time, so listeners are registered synchronously and no state is
// kept in module variables.

import type { CheckError, CheckUpdate, DismissPopup, ReadBlobReply } from "../shared/types";
import { collectImage, readBlobRequest } from "./fetchImage";
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

async function openResultWindow(): Promise<void> {
  const stored = await chrome.storage.session.get(RESULT_WINDOW_KEY);
  const existingId: unknown = stored[RESULT_WINDOW_KEY];
  if (typeof existingId === "number") {
    try {
      await chrome.windows.update(existingId, { focused: true });
      return;
    } catch {
      // window was closed; open a new one
    }
  }
  const created = await chrome.windows.create({
    type: "popup",
    url: "src/confirm/confirm.html?view=result",
    width: 420,
    height: 320,
  });
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
  await chrome.tabs
    .sendMessage(tabId, { type: "checkUpdate", checkId, srcUrl, status: "failed", error }, { frameId })
    .catch(() => undefined);
}

async function runCheck(input: { tabId: number; frameId: number; srcUrl: string; mainFrameUrl: string }): Promise<void> {
  const { tabId, frameId, srcUrl, mainFrameUrl } = input;
  const checkId = crypto.randomUUID();

  // Host permission first, with no await before it: the user gesture from the
  // menu click must still be live for permissions.request (spike #3). The
  // permission check itself is awaited, but the request call is the first
  // async chrome API call in this handler.
  let containsAllUrls = false;
  try {
    containsAllUrls = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    containsAllUrls = false;
  }
  if (needsPermissionRequest(mainFrameUrl, srcUrl, containsAllUrls)) {
    const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
    if (!granted) {
      await notifyFailed(tabId, frameId, checkId, srcUrl, { code: "permission_denied" });
      return;
    }
  }

  const checking = {
    type: "checkUpdate",
    checkId,
    srcUrl,
    status: "checking",
  } satisfies CheckUpdate;
  const dismiss = { type: "dismissPopup" } satisfies DismissPopup;

  try {
    await chrome.tabs.sendMessage(tabId, dismiss).catch(() => undefined); // no frame has the script yet
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content/index.js"] });
    await chrome.tabs.sendMessage(tabId, checking, { frameId });
  } catch (error) {
    console.error("injection failed", error);
    await openResultWindow().catch(console.error);
    return;
  }

  const collected = await collectImage(srcUrl, {
    readBlob: (url) => readBlobInFrame(tabId, frameId, checkId, url),
  });

  if (collected.kind === "error") {
    await notifyFailed(tabId, frameId, checkId, srcUrl, collected.error);
    return;
  }

  // #17 wires C2PA, verdict and the done update; for now record what the
  // fetch produced so M2 wiring has the values it needs.
  console.log("image collected", {
    mediaType: collected.mediaType,
    size: collected.size,
    imageHash: collected.imageHash,
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || !info.srcUrl || info.frameId === undefined) return;
  const tabId = tab.id;
  const frameId = info.frameId;
  const srcUrl = info.srcUrl;
  // The main-frame origin decides whether the image origin is cross-origin;
  // tab.url is the main frame's URL.
  const mainFrameUrl = tab.url ?? "";
  void runCheck({ tabId, frameId, srcUrl, mainFrameUrl }).catch((error: unknown) => {
    console.error("check failed", error);
  });
});
