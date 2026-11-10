// Content-script shell. One host element on document.documentElement with a
// closed Shadow DOM holds all injected UI (hard rule: no page-DOM changes
// beyond that host, and no style leaking in either direction). UI only —
// no key access, no network. Injected only after a menu click, never via a
// manifest content_scripts entry (hard rule 1).

import { isBadgeVisible, shouldBadge } from "./badge";
import { findImages } from "./findImages";
import { installOnce } from "./installOnce";
import { readBlobInPage } from "./readBlob";
import { message } from "../shared/i18n";
import { isCheckUpdate, isDismissPopup, isReadBlob } from "../shared/types";
import type { ReadBlobReply } from "../shared/types";

// The idempotently-installed UI instance; the shape is local to the shell.
export interface ContentShell {
  handleCheckUpdate(update: unknown): void;
}

const INSTANCE_KEY = "isthisai.contentShell";
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
  .isthisai-popup {
    position: fixed; z-index: 2147483647;
    right: 16px; top: 16px; max-width: 320px;
    background: #fff; color: #111; border: 1px solid #ccc;
    border-radius: 8px; padding: 12px 16px;
    font: 13px/1.4 system-ui, sans-serif;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  .isthisai-popup h1 { font-size: 14px; margin: 0 0 4px; }
  .isthisai-popup p { margin: 0; }`;

interface PopupHandle {
  close(): void;
}

function createShell(): ContentShell {
  const host = document.createElement("div");
  for (const [property, value] of HOST_RESET) host.style.setProperty(property, value, "important");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = BASE_STYLE;
  shadow.appendChild(style);
  document.documentElement.appendChild(host);

  let popup: PopupHandle | undefined;
  const badges = new Map<HTMLImageElement, HTMLDivElement>();

  function closePopup(): void {
    popup?.close();
    popup = undefined;
  }

  function showPopup(headlineKey: string, caveatKey?: string): PopupHandle {
    const overlay = document.createElement("div");
    overlay.className = "isthisai-popup";
    const headline = document.createElement("h1");
    headline.textContent = message(headlineKey);
    overlay.appendChild(headline);
    if (caveatKey) {
      const caveat = document.createElement("p");
      caveat.textContent = message(caveatKey);
      overlay.appendChild(caveat);
    }
    shadow.appendChild(overlay);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.isTrusted) return;
      if (event.key === "Escape") close();
    };
    // A closed shadow root retargets its events to the host, so any click
    // whose target is not the host is an outside click.
    const onOutside = (event: MouseEvent): void => {
      if (!event.isTrusted) return;
      if (event.target !== host) close();
    };
    const close = (): void => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onOutside, true);
      overlay.remove();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onOutside, true);
    return { close };
  }

  function positionBadge(badge: HTMLDivElement, img: HTMLImageElement): void {
    const rect = img.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    badge.style.display = isBadgeVisible(rect, viewport, img.isConnected) ? "" : "none";
    badge.style.top = `${Math.max(4, rect.top + 4)}px`;
    badge.style.left = `${Math.max(4, rect.right - badge.offsetWidth - 4)}px`;
  }

  function repositionBadges(): void {
    for (const [img, badge] of badges) {
      if (!img.isConnected) {
        badge.remove();
        badges.delete(img);
      } else {
        positionBadge(badge, img);
      }
    }
  }

  // Badges use fixed positioning; keep them on their images while the page
  // scrolls (any scrollable element) or the window resizes.
  window.addEventListener("scroll", repositionBadges, { capture: true });
  window.addEventListener("resize", repositionBadges);

  function addBadge(img: HTMLImageElement): void {
    if (badges.has(img)) return;
    const badge = document.createElement("div");
    badge.className = "isthisai-badge";
    badge.textContent = "TÄ";
    badge.title = message("badge_tooltip");
    badge.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      closePopup();
      popup = showPopup("popup_headline_ai_signal");
    });
    shadow.appendChild(badge);
    positionBadge(badge, img);
    badges.set(img, badge);
  }

  function handleMessage(message: unknown): void {
    if (isDismissPopup(message)) closePopup();
    else handleCheckUpdate(message);
  }

  function handleCheckUpdate(update: unknown): void {
    if (!isCheckUpdate(update)) return;
    closePopup();
    popup = showPopup("popup_headline_checking", "popup_caveat_no_signal");
    if (!shouldBadge(update)) return;
    for (const img of findImages(update.srcUrl)) {
      addBadge(img);
    }
  }

  // Registered inside the factory so a second injection reuses the whole
  // instance (including this listener) instead of adding a duplicate.
  chrome.runtime.onMessage.addListener(handleMessage);

  // readBlob is request/response: the listener must return the reply promise
  // synchronously for the worker's sendMessage to settle.
  chrome.runtime.onMessage.addListener((incoming: unknown): Promise<ReadBlobReply> | undefined => {
    if (!isReadBlob(incoming)) return undefined;
    return readBlobInPage(incoming.url);
  });

  return { handleCheckUpdate };
}

void installOnce(INSTANCE_KEY, createShell);
