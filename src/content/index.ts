// Content-script shell. One host element on document.documentElement with a
// closed Shadow DOM holds all injected UI (hard rule: no page-DOM changes
// beyond that host, and no style leaking in either direction). UI only —
// no key access, no network. Injected only after a menu click, never via a
// manifest content_scripts entry (hard rule 1).

import { badgeAction, isBadgeVisible } from "./badge";
import { findImages, rememberDataUrl, srcUrlToMatch } from "./findImages";
import { installOnce } from "./installOnce";
import { createSpinner, renderPopup, showToast, type PopupHandle } from "./popup";
import { popupModel, type PopupModel } from "./popupModel";
import { DISMISS_ID, isStaleUpdate } from "./presentation";
import { readBlobInPage } from "./readBlob";
import { errorMessageKey } from "../shared/errors";
import { message } from "../shared/i18n";
import { openAiErrorMessage } from "../shared/openaiErrors";
import { isCheckUpdate, isDismissPopup, isOpenAiRequestReply, isReadBlob } from "../shared/types";
import type { CheckUpdate, OpenAiRequest, ReadBlobReply } from "../shared/types";

// The idempotently-installed UI instance; the shape is local to the shell.
export interface ContentShell {
  handleCheckUpdate(update: unknown): void;
}

const INSTANCE_KEY = "isthisai.contentShell";

// The worker can be stopped mid-check (MV3, PLAN §4 step 9); the page-side
// timer is the only thing that can notice.
export const INTERRUPTION_MS = 60_000;

// Inline !important beats page rules like `div { transform: … }`, which would
// otherwise turn the host into the containing block of the fixed children.
const HOST_RESET: ReadonlyArray<readonly [string, string]> = [
  ["all", "initial"],
  ["display", "block"],
  ["position", "static"],
  ["transform", "none"],
  ["filter", "none"],
  ["perspective", "none"],
  ["contain", "none"],
  ["will-change", "auto"],
];
const BASE_STYLE = `
  :host { all: initial; }
  .isthisai-badge {
    position: fixed; z-index: 2147483647;
    background: #7c3aed; color: #fff;
    font: 700 12px/1 system-ui, sans-serif;
    padding: 3px 5px; border-radius: 4px; cursor: pointer;
  }
  .isthisai-spinner {
    position: fixed; z-index: 2147483647;
    box-sizing: border-box; width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.7); border-top-color: #7c3aed;
    background: rgba(0, 0, 0, 0.3);
    animation: isthisai-spin 0.8s linear infinite;
  }
  @keyframes isthisai-spin { to { transform: rotate(360deg); } }
  .isthisai-popup {
    position: fixed; z-index: 2147483647;
    right: 16px; top: 16px; max-width: 320px;
    /* A fixed box below the fold cannot be scrolled into view, so the popup
       itself scrolls: in a short iframe the button and caveat must stay
       reachable. */
    box-sizing: border-box; max-height: calc(100vh - 32px); overflow-y: auto;
    background: #fff; color: #111; border: 1px solid #ccc;
    border-radius: 8px; padding: 12px 16px;
    font: 13px/1.4 system-ui, sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  .isthisai-popup h1 { font-size: 14px; margin: 0 0 4px; }
  .isthisai-popup p { margin: 0; }
  .isthisai-popup .isthisai-line { margin-top: 6px; }
  .isthisai-popup .isthisai-line strong { display: block; }
  .isthisai-popup .isthisai-note { margin-top: 8px; color: #444; }
  .isthisai-popup button { margin-top: 8px; }
  .isthisai-toast {
    position: fixed; z-index: 2147483647;
    left: 16px; bottom: 16px; max-width: 360px;
    background: #111; color: #fff; border-radius: 6px; padding: 10px 14px;
    font: 13px/1.4 system-ui, sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }`;

function createShell(): ContentShell {
  const host = document.createElement("div");
  for (const [property, value] of HOST_RESET) host.style.setProperty(property, value, "important");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = BASE_STYLE;
  shadow.appendChild(style);
  document.documentElement.appendChild(host);

  let popup: PopupHandle | undefined;
  let interruptedTimer: ReturnType<typeof setTimeout> | undefined;
  let openAiInFlight = false;
  const badges = new Map<HTMLImageElement, HTMLDivElement>();
  const spinners = new Map<HTMLImageElement, HTMLDivElement>();
  // The data: image each recent check was about. A data: image is the only case
  // the OpenAI flow cannot re-fetch on its own: the check record stores its URL
  // without the payload (PLAN §3), so the page supplies the real one rather than
  // guessing between two data: images of the same type.
  const checkedSrcUrls = new Map<string, string>();
  const rememberSrcUrl = (checkId: string, srcUrl: string): void => rememberDataUrl(checkedSrcUrls, checkId, srcUrl);

  let followedCheckId: string | undefined;
  let openedCheckId: string | undefined;

  type DoneUpdate = Extract<CheckUpdate, { status: "done" }>;

  function closePopup(): void {
    popup?.close();
    popup = undefined;
  }

  // The OpenAI request is answered by the worker, whose own done update
  // re-renders the popup with the result; only a failure needs words here. A
  // second click while one is in flight is refused (PLAN §5).
  function requestOpenAi(checkId: string, button: HTMLButtonElement): void {
    if (openAiInFlight) return;
    openAiInFlight = true;
    button.disabled = true;
    chrome.runtime
      .sendMessage({ type: "openaiRequest", checkId } satisfies OpenAiRequest)
      .then((reply: unknown) => {
        if (isOpenAiRequestReply(reply) && reply.ok) return;
        if (isOpenAiRequestReply(reply) && reply.ok === false) {
          const { key, substitutions } = openAiErrorMessage(reply.error);
          showToast(shadow, message(key, substitutions));
          return;
        }
        // No reply at all: the worker never answered (stopped or reloaded).
        showToast(shadow, message("error_openai_unusable_reply"));
      })
      .catch(() => showToast(shadow, message("error_openai_unusable_reply")))
      .finally(() => {
        openAiInFlight = false;
        if (button.isConnected) button.disabled = false;
      });
  }

  function showResult(update: DoneUpdate): void {
    // The user is looking at this check now, so its updates are applied even if
    // a newer check was started here in the meantime (an OpenAI upload is slow
    // enough for that). The running check stays followed, so its own result and
    // spinner handling are untouched.
    openedCheckId = update.checkId;
    closePopup();
    popup = renderPopup(shadow, host, popupModel(update.result, update.openai), (button) =>
      requestOpenAi(update.checkId, button),
    );
  }

  function showChecking(): void {
    closePopup();
    const model: PopupModel = {
      headlineKey: "popup_headline_checking",
      lines: [],
      button: { state: "hidden" },
      showOpenAiNote: false,
      showConvertedNote: false,
    };
    popup = renderPopup(shadow, host, model, () => {});
  }

  function stopInterruptionTimer(): void {
    if (interruptedTimer !== undefined) {
      clearTimeout(interruptedTimer);
      interruptedTimer = undefined;
    }
  }

  function startInterruptionTimer(checkId: string): void {
    stopInterruptionTimer();
    interruptedTimer = setTimeout(() => {
      interruptedTimer = undefined;
      if (followedCheckId !== checkId) return;
      // No terminal update will come, so the check is over as far as the page
      // is concerned: drop the spinner and the "checking" popup, or they would
      // animate forever beside the toast.
      clearSpinners();
      closePopup();
      showToast(shadow, message("toast_interrupted"));
    }, INTERRUPTION_MS);
  }

  function positionOverlay(element: HTMLElement, img: HTMLImageElement): void {
    const rect = img.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    element.style.display = isBadgeVisible(rect, viewport, img.isConnected) ? "" : "none";
    element.style.top = `${Math.max(4, rect.top + 4)}px`;
    element.style.left = `${Math.max(4, rect.right - element.offsetWidth - 4)}px`;
  }

  function repositionOverlays(): void {
    for (const overlays of [badges, spinners]) {
      for (const [img, element] of overlays) {
        if (!img.isConnected) {
          element.remove();
          overlays.delete(img);
        } else {
          positionOverlay(element, img);
        }
      }
    }
  }

  // Overlays use fixed positioning; keep them on their images while the page
  // scrolls (any scrollable element) or the window resizes.
  window.addEventListener("scroll", repositionOverlays, { capture: true });
  window.addEventListener("resize", repositionOverlays);

  function addBadge(img: HTMLImageElement, update: DoneUpdate): void {
    badges.get(img)?.remove();
    const badge = document.createElement("div");
    badge.className = "isthisai-badge";
    badge.textContent = "TÄ";
    badge.title = message("badge_tooltip");
    badge.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      closePopup();
      showResult(update);
    });
    shadow.appendChild(badge);
    positionOverlay(badge, img);
    badges.set(img, badge);
  }

  function removeBadge(img: HTMLImageElement): void {
    badges.get(img)?.remove();
    badges.delete(img);
  }

  function addSpinner(img: HTMLImageElement): void {
    spinners.get(img)?.remove();
    const spinner = createSpinner();
    shadow.appendChild(spinner);
    positionOverlay(spinner, img);
    spinners.set(img, spinner);
  }

  function clearSpinners(): void {
    for (const spinner of spinners.values()) spinner.remove();
    spinners.clear();
  }

  function handleMessage(message: unknown): void {
    if (isDismissPopup(message)) {
      // A newer check started elsewhere in the tab: this frame is invalidated
      // (terminal updates of its own in-flight check must not reopen a popup),
      // not reset to the fresh-shell state.
      followedCheckId = DISMISS_ID;
      openedCheckId = undefined;
      stopInterruptionTimer();
      clearSpinners();
      closePopup();
    } else {
      handleCheckUpdate(message);
    }
  }

  function handleCheckUpdate(update: unknown): void {
    if (!isCheckUpdate(update)) return;
    rememberSrcUrl(update.checkId, update.srcUrl);
    if (isStaleUpdate(followedCheckId, update, openedCheckId)) return;
    // The worker's OpenAI done update repeats a data: srcUrl without its payload;
    // the full URL the check saw is what the page's <img> actually carries.
    const matchUrl = srcUrlToMatch(update.srcUrl, checkedSrcUrls.get(update.checkId));
    closePopup();
    // An opened check's completion must not touch the running check's spinner or timer.
    const running = update.checkId === followedCheckId || update.status === "checking";
    if (running) clearSpinners();

    if (update.status === "checking") {
      followedCheckId = update.checkId;
      openedCheckId = undefined;
      startInterruptionTimer(update.checkId);
      const images = findImages(matchUrl);
      // No element carries this URL (a CSS background, a <picture> edge case):
      // there is nowhere to put a spinner, so the corner popup stands in.
      if (images.length === 0) showChecking();
      else for (const img of images) addSpinner(img);
      return;
    }

    if (running) stopInterruptionTimer();
    if (update.status === "failed") {
      showToast(shadow, message(errorMessageKey(update.error.code)));
      return;
    }
    showDone(update, matchUrl);
  }

  function showDone(update: DoneUpdate, matchUrl: string): void {
    const images = findImages(matchUrl);
    const action = badgeAction(update);
    if (action !== "keep") {
      for (const img of images) {
        if (action === "add") addBadge(img, update);
        else removeBadge(img);
      }
    }
    switch (update.result.verdict) {
      case "ai_signal":
        // Badge only; clicking it opens the popup. Without a matched element
        // there is nothing to click, so the popup stands in (PLAN §5).
        if (images.length === 0) showResult(update);
        return;
      case "no_signal":
        showToast(shadow, message("toast_no_signal"));
        showResult(update);
        return;
      case "incomplete":
        showResult(update);
        return;
    }
  }

  // Registered inside the factory so a second injection reuses the whole
  // instance (including this listener) instead of adding a duplicate.
  chrome.runtime.onMessage.addListener(handleMessage);

  // readBlob is request/response: the listener must return the reply promise
  // synchronously for the worker's sendMessage to settle. This untyped chrome
  // overload expects void, but returning the promise is the MV3 contract.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  chrome.runtime.onMessage.addListener((incoming: unknown): Promise<ReadBlobReply> | undefined => {
    if (!isReadBlob(incoming)) return undefined;
    return readBlobInPage(incoming.url, checkedSrcUrls.get(incoming.checkId));
  });

  return { handleCheckUpdate };
}

void installOnce(INSTANCE_KEY, createShell);
