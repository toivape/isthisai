// M0 spike #3 (issue #3): menu items + measurements. THROWAWAY CODE,
// removed before merge; only the PLAN.md answers survive. Also keeps the
// real hard rule: storage restricted to trusted contexts on every start.

import {
  headerBlock,
  msgLine,
  pageRow,
  permCheckLine,
  permRequestLine,
  verdictLine,
  type SurvivalPhase,
} from "./spike";

const MENU_ID = "isthisai-spike";
const SPIKE_ORIGIN = "http://127.0.0.1:8123";
const MSG_BYTES = 60 * 1024 * 1024;

// ---- storage access level (hard rule, not spike code) ------------------------

void chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .then(() => log("setAccessLevel(TRUSTED_CONTEXTS) ok"))
  .catch((e: unknown) => log("setAccessLevel FAILED", e));

// ---- helpers -----------------------------------------------------------------

function log(...args: unknown[]): void {
  console.log("[isthisai-spike]", ...args);
}

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "<no url>";
  } catch {
    return "<not a url>";
  }
}

// Same algorithm as the content script's copy (the content build is a
// separate IIFE that cannot import from src/background).
function checksum(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i += 4099) sum = (sum + s.charCodeAt(i)) * 31 + 1;
  return `${sum}:${s.length}`;
}

async function tryInject(tabId: number, frameId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["content/index.js"],
    });
    return true;
  } catch (e) {
    log(`  injection into frameId=${frameId} failed:`, e);
    return false;
  }
}

// ---- Q1: does a 60 MiB base64 string arrive as a tabs.sendMessage reply? ----

// tabs.sendMessage targeted at one frame: without frameId it broadcasts to
// every injected frame and the first sendResponse wins, which would let the
// wrong frame answer the probe.
async function askFrame<T>(tabId: number, frameId: number, message: unknown): Promise<T | undefined> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message, { frameId })) as T;
  } catch (e) {
    log("  tabs.sendMessage threw:", e);
    return undefined;
  }
}

async function measureMessageSize(tabId: number, frameId: number): Promise<void> {
  const t0 = performance.now();
  let ok = false;
  let replyMatches = false;
  const reply = await askFrame<{ ok: boolean; base64?: string; checksum?: string }>(
    tabId,
    frameId,
    { type: "spikeEcho", bytes: MSG_BYTES },
  );
  ok = reply?.ok === true;
  if (ok && reply && typeof reply.base64 === "string") {
    replyMatches =
      reply.base64.length === MSG_BYTES &&
      reply.base64.startsWith("AAAA") &&
      reply.checksum === checksum(reply.base64);
  }
  log(
    msgLine({
      bytes: MSG_BYTES,
      ms: performance.now() - t0,
      ok,
      replyMatches,
    }),
  );
}

// ---- Q2: permissions ----------------------------------------------------------

// Two separate clicks so the answers stay honest: any await before
// permissions.request risks dropping the user-gesture context and would
// turn a "request cannot run here" answer into a false negative.

async function permCheck(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab): Promise<void> {
  const tabOrigin = originOf(tab.url);
  const frameOrigin = originOf(info.frameUrl ?? tab.url);
  const containsAllUrls = await chrome.permissions.contains({
    origins: ["<all_urls>"],
  });
  const containsTabOrigin = await chrome.permissions.contains({ origins: [tabOrigin] });
  log(
    permCheckLine({
      tabOrigin,
      frameOrigin,
      containsAllUrls,
      containsTabOrigin,
    }),
  );
}

async function permRequest(): Promise<void> {
  let requestOk = false;
  let granted = false;
  let containsAfter = false;
  try {
    granted = (await chrome.permissions.request({ origins: ["<all_urls>"] })) === true;
    requestOk = true;
  } catch (e) {
    log("  permissions.request threw:", e);
  }
  if (granted) {
    containsAfter = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  }
  log(permRequestLine({ requestOk, granted, containsAfter }));
  log(
    "  If granted: revoke it afterwards in brave://extensions > Details, so other\n" +
      "  tests (iframe injection, srcUrl) still measure the activeTab-only case.",
  );
}

// ---- Q3: executeScript into a cross-origin iframe frameId, activeTab only ----

async function measureIframe(tabId: number, frameId: number, frameUrl: string | undefined): Promise<void> {
  const injected = await tryInject(tabId, frameId);
  log(`[spike:iframe] frameId=${frameId} frameUrl=${frameUrl ?? "<top>"} injected=${injected}`);
  if (!injected) return;
  const reply = await askFrame<{ ok: boolean; where: string; url: string }>(tabId, frameId, {
    type: "spikePing",
  });
  if (reply) log(`  content script replied: ${JSON.stringify(reply)}`);
}

// ---- Q4: worker survival past 30 s --------------------------------------------
//
// Three phases (server scripts/spike-server.mjs, ~1 MB/s so each takes ~42 s):
//   download-headers: server sleeps 35 s BEFORE headers, then sends fast.
//     Tests the documented kill condition "fetch() response takes >30 s to
//     arrive". If the worker dies, no [spike:30s] line appears at all.
//   download-body: headers immediate, body trickled over ~42 s.
//   upload: POST a 40 MiB body that takes ~42 s to send; headers of the
//     response only arrive when the server has read it all.

async function measureSurvival(phase: SurvivalPhase): Promise<void> {
  const url =
    SPIKE_ORIGIN +
    (phase === "upload" ? "/slow-upload" : phase === "download-body" ? "/slow-body.png" : "/slow-headers.png");
  const t0 = performance.now();
  let headersAt: number | undefined;
  let bytes = 0;
  let completed = false;
  try {
    if (phase === "upload") {
      const res = await fetch(url, {
        method: "POST",
        body: new Uint8Array(40 * 1024 * 1024),
        credentials: "omit",
      });
      headersAt = performance.now();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = Number(/bytes=(\d+)/.exec(await res.text())?.[1] ?? 0);
      completed = true;
    } else {
      const res = await fetch(url, { credentials: "omit" });
      headersAt = performance.now();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
        }
      } else {
        bytes = (await res.arrayBuffer()).byteLength;
      }
      completed = true;
    }
    log(
      headerBlock(phase, {
        ms: performance.now() - t0,
        bytes,
        headersMs: headersAt === undefined ? undefined : headersAt - t0,
        completed,
      }),
    );
  } catch (e) {
    log(
      headerBlock(phase, {
        ms: performance.now() - t0,
        bytes,
        headersMs: headersAt === undefined ? undefined : headersAt - t0,
        completed,
      }),
    );
    log("  error:", e);
  }
  log(
    "  NOTE: if no [spike:30s] line printed, the worker was killed mid-fetch\n" +
      "(brave://extensions shows the service worker as stopped; the console line\n" +
      "never appears). That itself is the answer: worker does not survive.",
  );
}

// ---- Q5: setAccessLevel + content-script storage.local read ------------------

async function measureStorageAccess(tabId: number, frameId: number): Promise<void> {
  const accessOk = await chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .then(() => true)
    .catch(() => false);
  await chrome.storage.local.set({ spikeCanary: "worker-written" });
  const reply = await askFrame<{ ok: boolean; localGet?: string }>(tabId, frameId, {
    type: "spikeStorageProbe",
  });
  const contentRead = reply?.localGet;
  log(verdictLine({ accessOk, contentRead: contentRead !== undefined }));
  log(`  content-script storage.local.get(spikeCanary) -> ${JSON.stringify(contentRead)}`);
}

// ---- Q6: what srcUrl really is -------------------------------------------------

async function measureSrcUrl(
  info: chrome.contextMenus.OnClickData,
  tabId: number,
  frameId: number,
): Promise<void> {
  const srcUrl = info.srcUrl ?? "<none>";
  const t0 = performance.now();
  let fetchStatus = 0;
  let fetchOk = false;
  let fetchSize = 0;
  if (/^https?:/.test(srcUrl)) {
    try {
      const res = await fetch(srcUrl, { credentials: "omit" });
      fetchStatus = res.status;
      fetchOk = res.ok;
      if (res.ok) fetchSize = (await res.arrayBuffer()).byteLength;
    } catch (e) {
      fetchStatus = -1;
      log("  srcUrl fetch threw:", e);
    }
  } else {
    log(`  not fetchable from the worker: ${srcUrl.slice(0, 60)}`);
  }
  let currentSrc = "";
  let width = 0;
  let height = 0;
  if (await tryInject(tabId, frameId)) {
    const probe = await askFrame<{ currentSrc?: string; width?: number; height?: number }>(tabId, frameId, {
      type: "spikeElementInfo",
      srcUrl,
    });
    currentSrc = probe?.currentSrc ?? "";
    width = probe?.width ?? 0;
    height = probe?.height ?? 0;
  }
  log(
    pageRow({
      srcUrl,
      frameUrl: info.frameUrl ?? "<top frame>",
      frameId,
      currentSrc,
      width,
      height,
      fetchStatus,
      fetchOk,
      fetchSize,
      ms: performance.now() - t0,
    }),
  );
}

// ---- menu ---------------------------------------------------------------------

type SpikeAction =
  | "srcurl"
  | "msg60"
  | "permCheck"
  | "permRequest"
  | "iframe"
  | "slowHeaders"
  | "slowBody"
  | "slowUpload"
  | "storage";

type MenuContexts = ["page" | "image", ...("page" | "image")[]];

const MENU_ITEMS: readonly [SpikeAction, string, MenuContexts][] = [
  // srcurl is image-only to match the real extension's menu (PLAN §5), so
  // the recorded srcUrl values are exactly what the real design will see.
  ["srcurl", "spike_menu_srcurl", ["image"]],
  ["msg60", "spike_menu_msg60", ["page", "image"]],
  ["permCheck", "spike_menu_perm_check", ["page", "image"]],
  ["permRequest", "spike_menu_perm_request", ["page", "image"]],
  ["iframe", "spike_menu_iframe", ["page", "image"]],
  ["slowHeaders", "spike_menu_slow_headers", ["page", "image"]],
  ["slowBody", "spike_menu_slow_body", ["page", "image"]],
  ["slowUpload", "spike_menu_slow_upload", ["page", "image"]],
  ["storage", "spike_menu_storage", ["page", "image"]],
];

function registerMenu(): void {
  chrome.contextMenus.removeAll(() => {
    for (const [action, key, contexts] of MENU_ITEMS) {
      chrome.contextMenus.create({
        id: `${MENU_ID}-${action}`,
        title: chrome.i18n.getMessage(key),
        contexts,
      });
    }
  });
}

// Register on every worker start: it restarts constantly, and a menu
// registered only in onInstalled would vanish after the first stop.
registerMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !info.menuItemId) return;
  const id = String(info.menuItemId);
  if (!id.startsWith(`${MENU_ID}-`)) return;
  const action = id.slice(MENU_ID.length + 1) as SpikeAction;
  void runAction(action, info, tab).catch((e: unknown) => log("action threw:", e));
});

async function runAction(
  action: SpikeAction,
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab,
): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const frameId = info.frameId ?? 0;
  switch (action) {
    case "srcurl":
      await measureSrcUrl(info, tabId, frameId);
      break;
    case "msg60":
      if (await tryInject(tabId, frameId)) await measureMessageSize(tabId, frameId);
      break;
    case "permCheck":
      await permCheck(info, tab);
      break;
    case "permRequest":
      await permRequest();
      break;
    case "iframe":
      await measureIframe(tabId, frameId, info.frameUrl);
      break;
    case "slowHeaders":
      await measureSurvival("download-headers");
      break;
    case "slowBody":
      await measureSurvival("download-body");
      break;
    case "slowUpload":
      await measureSurvival("upload");
      break;
    case "storage":
      if (await tryInject(tabId, frameId)) await measureStorageAccess(tabId, frameId);
      break;
  }
}
