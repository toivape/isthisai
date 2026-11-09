import { applyI18n, message } from "../shared/i18n";

applyI18n(document);

// M1: when the page cannot be injected (restricted frames), the worker opens
// this window with ?view=result and shows the placeholder result here.
// M4 (#18) wires the upload confirmation view; until then it stays hidden.
const params = new URLSearchParams(location.search);
if (params.get("view") === "result") {
  document.getElementById("confirm-view")?.setAttribute("hidden", "");
  document.getElementById("result-view")?.removeAttribute("hidden");
  document.title = message("confirm_title_result");
}
