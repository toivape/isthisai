// The injected UI, drawn from a PopupModel (popupModel.ts). All of it lives in
// the closed Shadow DOM the shell created: page CSS cannot reach in, and the
// page cannot read the nodes back. UI only — no key access, no network. Page
// scripts can still dispatch synthetic events, so every handler here ignores
// events whose isTrusted is false (PLAN §5).

import { message } from "../shared/i18n";
import type { PopupModel } from "./popupModel";

export interface PopupHandle {
  close(): void;
}

/** A brief corner message (no signal, an error, an interrupted check). */
export const TOAST_MS = 6000;

export function showToast(shadow: ShadowRoot, text: string): HTMLDivElement {
  const toast = document.createElement("div");
  toast.className = "isthisai-toast";
  toast.setAttribute("role", "status");
  toast.textContent = text;
  shadow.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_MS);
  return toast;
}

export function createSpinner(): HTMLDivElement {
  const spinner = document.createElement("div");
  spinner.className = "isthisai-spinner";
  spinner.setAttribute("role", "status");
  return spinner;
}

function partsText(parts: PopupModel["lines"][number]["parts"]): string {
  return parts.map((part) => message(part.key, part.substitutions)).join(" ");
}

/**
 * Renders the popup and closes it on Esc or an outside click. The close
 * listeners live on the document but only react to trusted events, so a page
 * script cannot close the popup either (PLAN §5, §8 item 17).
 */
export function renderPopup(
  shadow: ShadowRoot,
  host: HTMLElement,
  model: PopupModel,
  onOpenAi: (button: HTMLButtonElement) => void,
): PopupHandle {
  const overlay = document.createElement("div");
  overlay.className = "isthisai-popup";

  const headline = document.createElement("h1");
  headline.textContent = message(model.headlineKey);
  overlay.appendChild(headline);

  if (model.detailKey !== undefined) {
    const detail = document.createElement("p");
    detail.textContent = message(model.detailKey);
    overlay.appendChild(detail);
  }

  for (const line of model.lines) {
    const paragraph = document.createElement("p");
    paragraph.className = "isthisai-line";
    const label = document.createElement("strong");
    label.textContent = message(line.labelKey);
    paragraph.appendChild(label);
    paragraph.appendChild(document.createTextNode(` ${partsText(line.parts)}`));
    overlay.appendChild(paragraph);
  }

  if (model.showConvertedNote) {
    const converted = document.createElement("p");
    converted.className = "isthisai-note";
    converted.textContent = message("popup_synthid_converted");
    overlay.appendChild(converted);
  }

  if (model.button.state !== "hidden") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = message("popup_button_openai");
    if (model.button.state === "disabled") {
      button.disabled = true;
      const reason = document.createElement("p");
      reason.className = "isthisai-note";
      reason.textContent = message(model.button.reasonKey);
      overlay.appendChild(reason);
    }
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      onOpenAi(button);
    });
    overlay.appendChild(button);
  }

  if (model.showOpenAiNote) {
    const note = document.createElement("p");
    note.className = "isthisai-note";
    note.textContent = message("popup_openai_note");
    overlay.appendChild(note);
  }

  const caveat = document.createElement("p");
  caveat.className = "isthisai-note";
  caveat.textContent = message("popup_caveat_no_signal");
  overlay.appendChild(caveat);

  shadow.appendChild(overlay);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.isTrusted) return;
    if (event.key === "Escape") close();
  };
  // A closed shadow root retargets its events to the host, so any click whose
  // target is not the host is an outside click.
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
