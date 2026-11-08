// M0 spike #3: content-script side. Injected by the worker on demand, never
// declared in the manifest. THROWAWAY CODE, removed before merge.
//
// The content build is a separate self-contained IIFE (vite.content.config.ts)
// that cannot import from src/background, so shared helpers are duplicated.

export {}; // module (required for the Window augmentation below)

declare global {
  interface Window {
    __isthisaiSpikeLoaded?: boolean;
  }
}

// Idempotent: executeScript may run this file again on another click in the
// same frame. The first execution's listener keeps serving messages; a
// second listener would only duplicate work (60 MiB payloads built twice).
if (!window.__isthisaiSpikeLoaded) {
  window.__isthisaiSpikeLoaded = true;

  interface SpikeMessage {
    type?: unknown;
    bytes?: unknown;
    srcUrl?: unknown;
  }

  function checksum(s: string): string {
    let sum = 0;
    for (let i = 0; i < s.length; i += 4099) sum = (sum + s.charCodeAt(i)) * 31 + 1;
    return `${sum}:${s.length}`;
  }

  function buildPayload(bytes: number): string {
    const chunk = "A".repeat(64 * 1024);
    const parts: string[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      const take = Math.min(chunk.length, remaining);
      parts.push(chunk.slice(0, take));
      remaining -= take;
    }
    return parts.join("");
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const msg = message as SpikeMessage;
    switch (msg?.type) {
      case "spikePing":
        sendResponse({ ok: true, where: "content-script", url: location.href });
        return false;
      case "spikeEcho": {
        const bytes = typeof msg.bytes === "number" ? msg.bytes : 0;
        const t0 = performance.now();
        try {
          const base64 = buildPayload(bytes);
          sendResponse({
            ok: true,
            base64,
            checksum: checksum(base64),
            buildMs: Math.round(performance.now() - t0),
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return false;
      }
      case "spikeStorageProbe": {
        // Q5: can a content script still read storage.local after
        // setAccessLevel(TRUSTED_CONTEXTS)?
        chrome.storage.local
          .get("spikeCanary")
          .then((items) => sendResponse({ ok: true, localGet: (items as Record<string, unknown>).spikeCanary }))
          .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
        return true; // async response
      }
      case "spikeElementInfo": {
        // Q6: find the element the menu click referred to and report reality.
        const srcUrl = typeof msg.srcUrl === "string" ? msg.srcUrl : "";
        let found: Record<string, unknown> | undefined;
        for (const img of document.images) {
          if (img.currentSrc === srcUrl || img.src === srcUrl) {
            found = {
              tag: "img",
              currentSrc: img.currentSrc || img.src || "",
              src: img.src,
              width: img.naturalWidth,
              height: img.naturalHeight,
              srcset: img.srcset || undefined,
              sizes: img.sizes || undefined,
              loading: img.loading,
            };
            break;
          }
        }
        if (!found && document.querySelector(`[style*="${CSS.escape(srcUrl)}"]`)) {
          found = { tag: "css-background", currentSrc: srcUrl, note: "matched via inline style" };
        }
        sendResponse(found ?? { tag: "none", currentSrc: "", note: "no img element matched" });
        return false;
      }
      default:
        return false;
    }
  });
}
