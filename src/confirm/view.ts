// The confirmation window's view model (PLAN §3, issue #18). The worker opens
// this page with the image's details as query parameters rather than a srcUrl,
// so a data: URL's payload never travels in a window URL, and the page never
// loads the image (no extra request). Rendering and the upload decision live
// here so both are unit-testable without a browser.

export interface ConfirmParams {
  checkId: string;
  origin: string | undefined;
  mediaType: string;
  sizeBytes: number | undefined;
}

function optionalText(value: string | null): string | undefined {
  return value === null || value.trim() === "" ? undefined : value;
}

function optionalSize(value: string | null): number | undefined {
  const text = optionalText(value);
  if (text === undefined) return undefined;
  const bytes = Number(text);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
}

export function parseConfirmParams(search: string): ConfirmParams {
  const params = new URLSearchParams(search);
  return {
    checkId: params.get("checkId") ?? "",
    origin: optionalText(params.get("origin")),
    mediaType: optionalText(params.get("mediaType")) ?? "",
    sizeBytes: optionalSize(params.get("sizeBytes")),
  };
}

/** 1024-based units, as the browser's own download UI uses. */
export function formatSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

export type ConfirmChoice = "upload" | "cancel" | "closed";

/** Everything except the upload button declines: closing the window must never
 * be read as consent (hard rule 5). */
export function confirmsFor(choice: ConfirmChoice): boolean {
  return choice === "upload";
}
