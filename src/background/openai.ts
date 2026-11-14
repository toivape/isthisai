// OpenAI Content Provenance API client (PLAN §4 step 8, issues #9 and #19).
// Request building, response parsing and error mapping are pure so the flow in
// openaiFlow.ts stays a thin orchestrator. Hard rules: the key travels only in
// the Authorization header, the multipart request never sets its own content
// type, and the file part carries the media type sniffed from magic bytes.

import { FETCH_DEADLINE_MS } from "../shared/limits";
import type { OpenAiError, OpenAiResultPart } from "../shared/types";

export const PROVENANCE_URL = "https://api.openai.com/v1/content_provenance_checks";

export type DoneOpenAiResult = Extract<OpenAiResultPart, { state: "done" }>;

export type ParsedProvenance = { ok: true; result: DoneOpenAiResult } | { ok: false; error: OpenAiError };

export interface ProvenanceRequest {
  url: string;
  headers: Record<string, string>;
  body: FormData;
}

// The part's filename extension follows its media type. The API reads the type
// from the part itself, so a mismatched name only adds risk; an unknown type
// gets a bare name rather than an invented extension.
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function buildRequest(key: string, bytes: Uint8Array, mediaType: string): ProvenanceRequest {
  const body = new FormData();
  // FormData sets the multipart content type and its boundary itself; setting
  // it by hand would drop the boundary.
  // The cast is the lib's Uint8Array<ArrayBufferLike> vs BlobPart friction
  // (same as sha256Hex's digest call); bytes.buffer would ignore a subarray's
  // offset and upload the wrong slice.
  const part = bytes as unknown as ArrayBufferView<ArrayBuffer>;
  const extension = EXTENSIONS[mediaType];
  const filename = extension === undefined ? "image" : `image.${extension}`;
  body.append("file", new Blob([part], { type: mediaType }), filename);
  return { url: PROVENANCE_URL, headers: { Authorization: `Bearer ${key}` }, body };
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

// JSON null means "not reported", which is the same as absent: the string
// "null" must never reach the UI or a verdict.
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function findResult(results: unknown[], type: string): Record<string, unknown> | undefined {
  return results.find((entry): entry is Record<string, unknown> => isObject(entry) && entry.type === type);
}

function parseC2pa(entry: Record<string, unknown>): DoneOpenAiResult["c2pa"] | undefined {
  if (!isOutcome(entry.outcome)) return undefined;
  const validation = entry.validation_state;
  if (validation !== undefined && validation !== null && !isValidation(validation)) return undefined;
  const parsed: DoneOpenAiResult["c2pa"] = { outcome: entry.outcome };
  if (isValidation(validation)) parsed.validation = validation;
  const issuer = optionalString(entry.issuer);
  if (issuer !== undefined) parsed.issuer = issuer;
  const model = optionalString(entry.model);
  if (model !== undefined) parsed.model = model;
  const generatedAt = optionalString(entry.generated_at);
  if (generatedAt !== undefined) parsed.generatedAt = generatedAt;
  return parsed;
}

function parseSynthid(entry: Record<string, unknown>): DoneOpenAiResult["synthid"] | undefined {
  if (!isOutcome(entry.outcome)) return undefined;
  const parsed: DoneOpenAiResult["synthid"] = { outcome: entry.outcome };
  const model = optionalString(entry.model);
  if (model !== undefined) parsed.model = model;
  const generatedAt = optionalString(entry.generated_at);
  if (generatedAt !== undefined) parsed.generatedAt = generatedAt;
  return parsed;
}

// The body of a 2xx response. Both image entries are required: the API omits a
// check that does not apply rather than reporting not_detected, so a missing
// entry means "not checked" and must not be shown as a negative result
// (PLAN §4 "TÄ rule").
export function parseResponse(text: string, serverConverted: boolean): ParsedProvenance {
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
  return { ok: true, result: { state: "done", serverConverted, c2pa, synthid } };
}

// Retry-After is delta-seconds or an HTTP-date (RFC 9110); the two forms are
// disjoint, so a malformed number is rejected rather than falling through to
// Date.parse, which happily reads "1.5" as a date in 2001. A date only becomes
// a countdown with a clock, so the clock is a parameter.
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

// Only a non-2xx status reaches here, so anything else is a caller bug and
// must not read as a result.
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

export async function readProvenanceResponse(response: Response, serverConverted: boolean): Promise<ParsedProvenance> {
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: mapHttpError(response.status, response.headers.get("retry-after")) };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The deadline can expire after the headers arrive, while the body is still
    // being read: that abort is ours, not the network's.
    return { ok: false, error: { code: isAbortError(error) ? "timeout" : "network" } };
  }
  return parseResponse(text, serverConverted);
}

export interface SendProvenanceDeps {
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
}

// The caller may shorten the deadline (the conversion re-fetch, tests); the
// shared fetch deadline applies otherwise.
export function deadlineFor(deadlineMs?: number): number {
  return deadlineMs ?? FETCH_DEADLINE_MS;
}

// One deadline for the whole request, headers and body: a slower upload loses
// the worker (PLAN §4 step 8.5, the measured 30 s limit). A thrown fetch is a
// network failure — never a parsed result.
export async function sendProvenanceUpload(
  request: ProvenanceRequest,
  serverConverted: boolean,
  deps: SendProvenanceDeps = {},
): Promise<ParsedProvenance> {
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
    return await readProvenanceResponse(response, serverConverted);
  } catch (error) {
    return { ok: false, error: { code: isAbortError(error) ? "timeout" : "network" } };
  } finally {
    clearTimeout(timer);
  }
}
