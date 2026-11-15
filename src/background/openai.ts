// OpenAI Content Provenance API client (PLAN §4 step 8). The key travels only in
// the Authorization header, and the file part carries the sniffed media type.

import { FETCH_DEADLINE_MS } from "../shared/limits";
import type { OpenAiError, OpenAiResultPart } from "../shared/types";

export const PROVENANCE_URL = "https://api.openai.com/v1/content_provenance_checks";

type DoneOpenAiResult = Extract<OpenAiResultPart, { state: "done" }>;

export type ProvenanceSignals = Pick<DoneOpenAiResult, "c2pa" | "synthid">;

export type ParsedProvenance = { ok: true; result: ProvenanceSignals } | { ok: false; error: OpenAiError };

export interface ProvenanceRequest {
  url: string;
  headers: Record<string, string>;
  body: FormData;
}

export type BuiltRequest = { ok: true; request: ProvenanceRequest } | { ok: false; error: OpenAiError };

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Anything outside visible ASCII makes fetch throw before sending, which would
// otherwise surface as a network error.
const SENDABLE_KEY = /^[\x21-\x7e]+$/;

export function buildRequest(key: string, bytes: Uint8Array, mediaType: string): BuiltRequest {
  const trimmed = key.trim();
  if (!SENDABLE_KEY.test(trimmed)) return { ok: false, error: { code: "invalid_key" } };
  // No Content-Type header: FormData sets it together with the boundary.
  const body = new FormData();
  // Cast only, not bytes.buffer: the buffer would ignore a subarray's offset.
  const part = bytes as unknown as ArrayBufferView<ArrayBuffer>;
  const extension = EXTENSIONS[mediaType];
  const filename = extension === undefined ? "image" : `image.${extension}`;
  body.append("file", new Blob([part], { type: mediaType }), filename);
  return { ok: true, request: { url: PROVENANCE_URL, headers: { Authorization: `Bearer ${trimmed}` }, body } };
}

type Outcome = "detected" | "not_detected";
type Validation = "trusted" | "valid" | "invalid" | "not_present";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutcome(value: unknown): value is Outcome {
  return value === "detected" || value === "not_detected";
}

function isValidation(value: unknown): value is Validation {
  return value === "trusted" || value === "valid" || value === "invalid" || value === "not_present";
}

// JSON null means "not reported" and maps to absent, never to the string "null".
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function findResult(results: unknown[], type: string): Record<string, unknown> | undefined {
  return results.find((entry): entry is Record<string, unknown> => isObject(entry) && entry.type === type);
}

function parseC2pa(entry: Record<string, unknown>): ProvenanceSignals["c2pa"] | undefined {
  if (!isOutcome(entry.outcome)) return undefined;
  const validation = entry.validation_state;
  if (validation !== undefined && validation !== null && !isValidation(validation)) return undefined;
  const parsed: ProvenanceSignals["c2pa"] = { outcome: entry.outcome };
  if (isValidation(validation)) parsed.validation = validation;
  const issuer = optionalString(entry.issuer);
  if (issuer !== undefined) parsed.issuer = issuer;
  const model = optionalString(entry.model);
  if (model !== undefined) parsed.model = model;
  const generatedAt = optionalString(entry.generated_at);
  if (generatedAt !== undefined) parsed.generatedAt = generatedAt;
  return parsed;
}

function parseSynthid(entry: Record<string, unknown>): ProvenanceSignals["synthid"] | undefined {
  if (!isOutcome(entry.outcome)) return undefined;
  const parsed: ProvenanceSignals["synthid"] = { outcome: entry.outcome };
  const model = optionalString(entry.model);
  if (model !== undefined) parsed.model = model;
  const generatedAt = optionalString(entry.generated_at);
  if (generatedAt !== undefined) parsed.generatedAt = generatedAt;
  return parsed;
}

// Both image entries are required: a missing entry means "not checked", which
// must never be shown as not_detected.
export function parseResponse(text: string): ParsedProvenance {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "bad_response" } };
  }
  const results = isObject(payload) ? payload.results : undefined;
  if (!Array.isArray(results)) return { ok: false, error: { code: "bad_response" } };
  const c2paEntry = findResult(results, "c2pa");
  const synthidEntry = findResult(results, "synthid");
  if (c2paEntry === undefined || synthidEntry === undefined) return { ok: false, error: { code: "bad_response" } };
  const c2pa = parseC2pa(c2paEntry);
  const synthid = parseSynthid(synthidEntry);
  if (c2pa === undefined || synthid === undefined) return { ok: false, error: { code: "bad_response" } };
  return { ok: true, result: { c2pa, synthid } };
}

// Delta-seconds or an HTTP-date (RFC 9110). A malformed number must not fall
// through to Date.parse, which reads "1.5" as a date.
const DELTA_FORM = /^[+-]?\d*\.?\d+$/;

export function retryAfterSeconds(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (DELTA_FORM.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

// Callers pass only non-2xx statuses; anything else maps to bad_response.
export function mapHttpError(status: number, retryAfter: string | null, now: number = Date.now()): OpenAiError {
  if (status === 429) {
    const seconds = retryAfterSeconds(retryAfter, now);
    return seconds === undefined ? { code: "rate_limited" } : { code: "rate_limited", retryAfterSec: seconds };
  }
  if (status === 400) return { code: "http_400" };
  if (status === 401) return { code: "http_401" };
  if (status === 404) return { code: "http_404" };
  if (status >= 500) return { code: "http_5xx" };
  if (status >= 400) return { code: "http_4xx" };
  return { code: "bad_response" };
}

const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

// Releases the connection an unread streaming body would otherwise hold open.
// A failed release must not replace the typed error the caller needs.
async function releaseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release, or already released.
  }
}

export async function readProvenanceResponse(response: Response): Promise<ParsedProvenance> {
  if (response.status < 200 || response.status >= 300) {
    // The error body is never read, but it must not keep downloading after the
    // caller has its answer — and the caller clears its deadline timer then
    // (fetchImage.ts cancels its reader for the same reason).
    await releaseBody(response);
    return { ok: false, error: mapHttpError(response.status, response.headers.get("retry-after")) };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The deadline can expire while the body is still being read.
    return { ok: false, error: { code: isAbortError(error) ? "timeout" : "network" } };
  }
  return parseResponse(text);
}

export interface SendProvenanceDeps {
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
}

export function deadlineFor(deadlineMs?: number): number {
  return deadlineMs ?? FETCH_DEADLINE_MS;
}

// One deadline covers headers and body (PLAN §4 step 8.5).
export async function sendProvenanceUpload(request: ProvenanceRequest, deps: SendProvenanceDeps = {}): Promise<ParsedProvenance> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineFor(deps.deadlineMs));
  try {
    const response = await doFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    return await readProvenanceResponse(response);
  } catch (error) {
    return { ok: false, error: { code: isAbortError(error) ? "timeout" : "network" } };
  } finally {
    clearTimeout(timer);
  }
}
