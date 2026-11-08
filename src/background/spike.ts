// M0 spike #3 (issue #3): pure log-line builders for the owner's console
// paste. Browser code calls these so every measurement has the same shape;
// nothing here touches chrome.* APIs, which keeps the formats unit-testable.
// THROWAWAY: removed before merge; only the PLAN.md answers survive.

export function fmtSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// ---- Q1: 60 MiB base64 reply via tabs.sendMessage ---------------------------

export function msgLine(m: {
  bytes: number;
  ms: number;
  ok: boolean;
  replyMatches: boolean;
}): string {
  const parts = [
    `bytes=${m.bytes}`,
    m.ok ? fmtSize(m.bytes) : "",
    `ms=${Math.round(m.ms)}`,
    `ok=${m.ok}`,
    `replyMatches=${m.replyMatches}`,
  ].filter(Boolean);
  return `[spike:msg] ${parts.join(" ")}`;
}

// ---- Q2: permissions --------------------------------------------------------

export function permCheckLine(m: {
  tabOrigin: string;
  frameOrigin: string;
  containsAllUrls: boolean;
  containsTabOrigin: boolean;
}): string {
  return (
    `[spike:perm] check tabOrigin=${m.tabOrigin} frameOrigin=${m.frameOrigin} ` +
    `containsAllUrls=${m.containsAllUrls} activeTabTabOrigin=${m.containsTabOrigin}`
  );
}

export function permRequestLine(m: {
  requestOk: boolean;
  granted: boolean;
  containsAfter: boolean;
}): string {
  return (
    `[spike:perm] request requestOk=${m.requestOk} granted=${m.granted} containsAfter=${m.containsAfter}`
  );
}

// ---- Q4: 30 s worker survival ------------------------------------------------

export type SurvivalPhase = "download-headers" | "download-body" | "upload";

export function headerBlock(phase: SurvivalPhase, m: {
  ms: number;
  bytes: number;
  headersMs?: number;
  completed: boolean;
}): string {
  const parts = [
    `phase=${phase}`,
    `bytes=${m.bytes}`,
    m.bytes > 0 ? fmtSize(m.bytes) : "",
    `ms=${Math.round(m.ms)}`,
    m.headersMs !== undefined ? `headersMs=${Math.round(m.headersMs)}` : "",
    `completed=${m.completed}`,
  ].filter(Boolean);
  return `[spike:30s] ${parts.join(" ")}`;
}

// ---- Q5: setAccessLevel + content-script storage.local read ------------------

export function verdictLine(m: { accessOk: boolean; contentRead: boolean }): string {
  return `[spike:access] setAccessLevel=${m.accessOk ? "ok" : "FAILED"} contentStorageRead=${m.contentRead}`;
}

// ---- Q6: what srcUrl really is ------------------------------------------------

export function pageRow(m: {
  srcUrl: string;
  frameUrl: string;
  frameId: number;
  currentSrc: string;
  width: number;
  height: number;
  fetchStatus: number;
  fetchOk: boolean;
  fetchSize: number;
  ms: number;
}): string {
  const currentSrc = m.currentSrc || "<none>";
  const fetch = m.fetchOk ? `${m.fetchStatus}` : `ERR ${m.fetchStatus}`;
  const parts = [
    `srcUrl=${m.srcUrl}`,
    `frameUrl=${m.frameUrl}`,
    `frameId=${m.frameId}`,
    `currentSrc=${currentSrc}`,
    `natural=${m.width}x${m.height}`,
    `fetch=${fetch}`,
    m.fetchOk && m.fetchSize > 0 ? `size=${fmtSize(m.fetchSize)}` : "",
    `ms=${Math.round(m.ms)}`,
  ].filter(Boolean);
  return `[spike:src] ${parts.join(" ")}`;
}
