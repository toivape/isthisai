// The result popup's view model (PLAN §5, issue #13). A pure function from the
// stored result and the OpenAI availability to the lines, headline and button
// state, so every row of the TÄ rule can be pinned in tests without a browser.
// Rendering lives in popup.ts.

import { verdictPresentation } from "./presentation";
import type { CheckResult, OpenAiAvailability, OpenAiResultPart } from "../shared/types";

/** One i18n message, rendered next to the others on its line. */
export interface MessagePart {
  key: string;
  substitutions?: string[];
}

/** A labelled line: "Content Credentials (C2PA)" and its state and details. */
export interface PopupLine {
  labelKey: string;
  parts: MessagePart[];
}

export type PopupButton =
  | { state: "enabled" }
  | { state: "disabled"; reasonKey: string }
  | { state: "hidden" };

export interface PopupModel {
  headlineKey: string;
  /** A headline-level note (the incomplete wording); absent for the others. */
  detailKey?: string;
  lines: PopupLine[];
  button: PopupButton;
  /** "OpenAI detects only OpenAI signals", next to the OpenAI result. */
  showOpenAiNote: boolean;
  /** The server re-encoded the uploaded copy, which can remove signals. */
  showConvertedNote: boolean;
}

const NO_KEY_REASONS: Record<"no_key", string> = { no_key: "popup_button_no_key" };

function claimed(issuer: string | undefined, model: string | undefined): MessagePart[] {
  const parts: MessagePart[] = [];
  if (issuer !== undefined) parts.push({ key: "popup_claimed_issuer", substitutions: [issuer] });
  if (model !== undefined) parts.push({ key: "popup_claimed_model", substitutions: [model] });
  return parts;
}

function c2paLine(c2pa: CheckResult["localC2pa"]): PopupLine {
  const labelKey = "popup_line_c2pa";
  switch (c2pa.manifest) {
    case "absent":
      return { labelKey, parts: [{ key: "popup_c2pa_absent" }] };
    case "present":
      return {
        labelKey,
        parts: [
          { key: c2pa.aiAction ? "popup_c2pa_present_ai" : "popup_c2pa_present_other" },
          ...claimed(c2pa.claimedIssuer, c2pa.claimedModel),
        ],
      };
    case "invalid":
      // An intact binding with a rejected signer certificate still shows TÄ, so
      // the wording must not read as tampering (PLAN §4 "Why integrity exists").
      return c2pa.integrity === "verified"
        ? { labelKey, parts: [{ key: "popup_c2pa_profile" }, ...claimed(c2pa.claimedIssuer, c2pa.claimedModel)] }
        : { labelKey, parts: [{ key: "popup_c2pa_unverified" }] };
    case "remote_unfetched":
      return { labelKey, parts: [{ key: "popup_c2pa_remote" }] };
    case "error":
      return { labelKey, parts: [{ key: "popup_c2pa_error" }] };
  }
}

function xmpLine(xmp: CheckResult["localXmp"]): PopupLine {
  const labelKey = "popup_line_xmp";
  switch (xmp.state) {
    case "detected": {
      const parts: MessagePart[] = [{ key: "popup_xmp_detected" }];
      if (xmp.digitalSourceType !== undefined) {
        parts.push({ key: "popup_xmp_source_type", substitutions: [xmp.digitalSourceType] });
      }
      if (xmp.generatorHint !== undefined) {
        parts.push({ key: "popup_xmp_generator", substitutions: [xmp.generatorHint] });
      }
      return { labelKey, parts };
    }
    case "not_detected":
      return { labelKey, parts: [{ key: "popup_xmp_not_detected" }] };
    case "error":
      return { labelKey, parts: [{ key: "popup_xmp_error" }] };
  }
}

function synthidLine(openai: OpenAiResultPart): PopupLine {
  const labelKey = "popup_line_synthid";
  if (openai.state !== "done") return { labelKey, parts: [{ key: "popup_synthid_not_checked" }] };
  if (openai.synthid.outcome === "detected") {
    return { labelKey, parts: [{ key: "popup_synthid_detected" }, ...claimed(undefined, openai.synthid.model)] };
  }
  return { labelKey, parts: [{ key: "popup_synthid_not_detected" }] };
}

// OpenAI's own C2PA result gets its own line: a third-party manifest can come
// back "trusted", which must not read as OpenAI vouching for it (PLAN §5).
function openAiC2paLine(c2pa: Extract<OpenAiResultPart, { state: "done" }>["c2pa"]): PopupLine {
  const labelKey = "popup_line_openai_c2pa";
  if (c2pa.outcome !== "detected") return { labelKey, parts: [{ key: "popup_openai_c2pa_not_detected" }] };
  const parts: MessagePart[] = [{ key: "popup_openai_c2pa_detected" }];
  if (c2pa.validation !== undefined) parts.push({ key: `popup_openai_c2pa_validation_${c2pa.validation}` });
  parts.push(...claimed(c2pa.issuer, c2pa.model));
  return { labelKey, parts };
}

export function popupModel(result: CheckResult, availability: OpenAiAvailability): PopupModel {
  const { headlineKey, detailKey } = verdictPresentation(result.verdict);
  const openai = result.openai;
  const lines: PopupLine[] = [c2paLine(result.localC2pa), xmpLine(result.localXmp), synthidLine(openai)];
  const checked = openai.state === "done";
  if (openai.state === "done") lines.push(openAiC2paLine(openai.c2pa));

  let button: PopupButton = { state: "hidden" };
  if (!checked) {
    button = availability.available ? { state: "enabled" } : { state: "disabled", reasonKey: NO_KEY_REASONS[availability.reason] };
  }

  return {
    headlineKey,
    detailKey,
    lines,
    button,
    showOpenAiNote: checked,
    showConvertedNote: openai.state === "done" && openai.serverConverted,
  };
}
