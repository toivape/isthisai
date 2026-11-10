import { errorMessageKey } from "../shared/errors";
import { applyI18n, message } from "../shared/i18n";
import { isCheckError } from "../shared/types";

applyI18n(document);

// M1: when the page cannot be injected (restricted frames), the worker opens
// this window with ?view=result and shows the placeholder result here.
// M4 (#18) wires the upload confirmation view; until then it stays hidden.
const params = new URLSearchParams(location.search);
if (params.get("view") === "result") {
  document.getElementById("confirm-view")?.setAttribute("hidden", "");
  document.getElementById("result-view")?.removeAttribute("hidden");
  document.title = message("confirm_title_result");
  const error = { code: params.get("error") };
  if (isCheckError(error)) {
    const headline = document.getElementById("result-headline");
    if (headline) headline.textContent = message(errorMessageKey(error.code));
    document.getElementById("result-caveat")?.setAttribute("hidden", "");
  }
}
