import { confirmsFor, formatSize, parseConfirmParams, type ConfirmChoice, type ConfirmParams } from "./view";
import { errorMessageKey } from "../shared/errors";
import { applyI18n, message } from "../shared/i18n";
import { isCheckError, type ConfirmUpload } from "../shared/types";

applyI18n(document);

const search = new URLSearchParams(location.search);
const image = parseConfirmParams(location.search);

// M1: when the page cannot be injected (restricted frames), the worker opens
// this window with ?view=result and shows the result here instead.
if (search.get("view") === "result") {
  document.getElementById("confirm-view")?.setAttribute("hidden", "");
  document.getElementById("result-view")?.removeAttribute("hidden");
  document.title = message("confirm_title_result");
  const error = { code: search.get("error") };
  if (isCheckError(error)) {
    const headline = document.getElementById("result-headline");
    if (headline) headline.textContent = message(errorMessageKey(error.code));
    document.getElementById("result-caveat")?.setAttribute("hidden", "");
  }
} else {
  renderImageDetails(image);
}

// The image itself is never loaded here (PLAN §3: no extra request); the worker
// already knows these three values.
function renderImageDetails(image: ConfirmParams): void {
  const size = formatSize(image.sizeBytes);
  const lines: Array<[string, string | undefined]> = [
    ["confirm-origin", image.origin === undefined ? undefined : message("confirm_origin", [image.origin])],
    ["confirm-type", image.mediaType === "" ? undefined : message("confirm_type", [image.mediaType])],
    ["confirm-size", size === undefined ? undefined : message("confirm_size", [size])],
  ];
  document.getElementById("confirm-converted")?.toggleAttribute("hidden", !image.converted);
  for (const [id, text] of lines) {
    const element = document.getElementById(id);
    if (element === null) continue;
    element.hidden = text === undefined;
    if (text !== undefined) element.textContent = text;
  }
}

// Exactly one answer per window: the first choice wins, so closing after a click
// cannot send a second one (hard rule 5: consent is the upload button only).
let answered = false;

function answer(choice: ConfirmChoice): void {
  if (answered) return;
  answered = true;
  const reply = { type: "confirmUpload", checkId: image.checkId, confirmed: confirmsFor(choice) } satisfies ConfirmUpload;
  void chrome.runtime.sendMessage(reply).catch(() => undefined);
  if (choice !== "closed") window.close();
}

document.getElementById("upload")?.addEventListener("click", () => answer("upload"));
document.getElementById("cancel")?.addEventListener("click", () => answer("cancel"));
// Closing the window is a decline, not a silent nothing.
window.addEventListener("pagehide", () => answer("closed"));
