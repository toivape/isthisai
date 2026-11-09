// Service worker entry: context-menu registration, on-demand injection.
// Nothing runs before a menu click (hard rule 1). The worker can be stopped
// at any time, so listeners are registered synchronously and no state is
// kept in module variables.

import type { CheckUpdate, DismissPopup } from "../shared/types";

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
function openResultWindow(): void {
  void chrome.windows.create({
    type: "popup",
    url: "src/confirm/confirm.html?view=result",
    width: 420,
    height: 320,
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || !info.srcUrl || info.frameId === undefined) return;
  const tabId = tab.id;
  const frameId = info.frameId;
  const srcUrl = info.srcUrl;
  const update = {
    type: "checkUpdate",
    checkId: crypto.randomUUID(),
    srcUrl,
    status: "checking",
  } satisfies CheckUpdate;
  const dismiss = { type: "dismissPopup" } satisfies DismissPopup;
  void chrome.tabs
    .sendMessage(tabId, dismiss)
    .catch(() => undefined) // no frame has the script yet
    .then(() => chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content/index.js"] }))
    .then(() => chrome.tabs.sendMessage(tabId, update, { frameId }))
    .catch((error: unknown) => {
      console.error("injection failed", error);
      openResultWindow();
    });
});
