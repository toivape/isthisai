export interface CheckResult {
  imageHash: string;
  mediaType: string;
  verdict: "ai_signal" | "no_signal" | "incomplete";
  localC2pa: {
    manifest: "absent" | "present" | "invalid" | "remote_unfetched" | "error";
    aiAction: boolean;
    claimedIssuer?: string;
    claimedModel?: string;
    generatedAt?: string;
  };
  localXmp: {
    state: "detected" | "not_detected" | "error";
    digitalSourceType?: string;
    generatorHint?: string;
  };
  openai:
    | { state: "not_checked" }
    | {
        state: "done";
        serverConverted: boolean;
        c2pa: {
          outcome: "detected" | "not_detected";
          validation?: "trusted" | "valid" | "invalid" | "not_present";
          issuer?: string;
          model?: string;
          generatedAt?: string;
        };
        synthid: { outcome: "detected" | "not_detected"; model?: string; generatedAt?: string };
      };
}

export type CheckErrorCode =
  | "permission_denied"
  | "fetch_failed"
  | "timeout"
  | "too_large"
  | "unsupported_type";

export interface CheckError {
  code: CheckErrorCode;
}

export type OpenAiErrorCode =
  | "no_key"
  | "cancelled"
  | "check_expired"
  | "hash_mismatch"
  | "unsupported_type"
  | "fetch_failed"
  | "timeout"
  | "http_400"
  | "http_401"
  | "http_404"
  | "http_4xx"
  | "http_5xx"
  | "rate_limited"
  | "network"
  | "bad_response";

export interface OpenAiError {
  code: OpenAiErrorCode;
  retryAfterSec?: number;
}

// worker -> content script
export type CheckUpdate =
  | { type: "checkUpdate"; checkId: string; srcUrl: string; status: "checking" }
  | { type: "checkUpdate"; checkId: string; srcUrl: string; status: "done"; result: CheckResult; openai: OpenAiAvailability }
  | { type: "checkUpdate"; checkId: string; srcUrl: string; status: "failed"; error: CheckError };

export type OpenAiAvailability = { available: true } | { available: false; reason: "no_key" };

// worker -> content script, request/response
export type ReadBlob = { type: "readBlob"; checkId: string; url: string };
export type ReadBlobReply = { ok: true; base64: string } | { ok: false };

// content script -> worker
export type OpenAiRequest = { type: "openaiRequest"; checkId: string };

// confirmation window -> worker
export type ConfirmUpload = { type: "confirmUpload"; checkId: string; confirmed: boolean };

// options page -> worker, request/response
export type TestKey = { type: "testKey" };
export type TestKeyReply = { ok: true } | { ok: false; error: OpenAiError };
export type KeyStatus = { type: "keyStatus" };
export type KeyStatusReply = { hasKey: boolean };

// chrome.storage.local: written by the options page, read only by the worker
export interface ApiKeyStorage {
  apiKey?: string;
}

// chrome.storage.session keys, worker only
export interface CheckRecord {
  checkId: string;
  srcUrl: string;
  frameUrl: string;
  tabId: number;
  frameId: number;
  imageHash: string;
  mediaType: string;
  size: number;
}

export const CHECK_KEY_PREFIX = "check:";
export const RESULT_KEY_PREFIX = "result:";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

export function isCheckResult(value: unknown): value is CheckResult {
  if (!isObject(value)) return false;
  if (!hasString(value, "imageHash") || !hasString(value, "mediaType")) return false;
  if (!isOneOf(value.verdict, ["ai_signal", "no_signal", "incomplete"])) return false;
  const c2pa = value.localC2pa;
  if (!isObject(c2pa)) return false;
  if (!isOneOf(c2pa.manifest, ["absent", "present", "invalid", "remote_unfetched", "error"])) return false;
  if (typeof c2pa.aiAction !== "boolean") return false;
  if (c2pa.claimedIssuer !== undefined && !isString(c2pa.claimedIssuer)) return false;
  if (c2pa.claimedModel !== undefined && !isString(c2pa.claimedModel)) return false;
  if (c2pa.generatedAt !== undefined && !isString(c2pa.generatedAt)) return false;
  const xmp = value.localXmp;
  if (!isObject(xmp)) return false;
  if (!isOneOf(xmp.state, ["detected", "not_detected", "error"])) return false;
  if (xmp.digitalSourceType !== undefined && !isString(xmp.digitalSourceType)) return false;
  if (xmp.generatorHint !== undefined && !isString(xmp.generatorHint)) return false;
  return isOpenAiResultPart(value.openai);
}

function isOpenAiResultPart(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.state === "not_checked") return true;
  if (value.state !== "done") return false;
  if (typeof value.serverConverted !== "boolean") return false;
  return isOpenAiC2pa(value.c2pa) && isOpenAiSynthid(value.synthid);
}

function isOpenAiC2pa(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!isOneOf(value.outcome, ["detected", "not_detected"])) return false;
  if (value.validation !== undefined && !isOneOf(value.validation, ["trusted", "valid", "invalid", "not_present"])) return false;
  if (value.issuer !== undefined && !isString(value.issuer)) return false;
  if (value.model !== undefined && !isString(value.model)) return false;
  if (value.generatedAt !== undefined && !isString(value.generatedAt)) return false;
  return true;
}

function isOpenAiSynthid(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!isOneOf(value.outcome, ["detected", "not_detected"])) return false;
  if (value.model !== undefined && !isString(value.model)) return false;
  if (value.generatedAt !== undefined && !isString(value.generatedAt)) return false;
  return true;
}

export function isCheckError(value: unknown): value is CheckError {
  return isObject(value) && isOneOf(value.code, ["permission_denied", "fetch_failed", "timeout", "too_large", "unsupported_type"]);
}

export function isOpenAiError(value: unknown): value is OpenAiError {
  if (!isObject(value)) return false;
  if (!isOneOf(value.code, ["no_key", "cancelled", "check_expired", "hash_mismatch", "unsupported_type", "fetch_failed", "timeout", "http_400", "http_401", "http_404", "http_4xx", "http_5xx", "rate_limited", "network", "bad_response"])) return false;
  if (value.retryAfterSec !== undefined && typeof value.retryAfterSec !== "number") return false;
  return true;
}

export function isOpenAiAvailability(value: unknown): value is OpenAiAvailability {
  if (!isObject(value)) return false;
  if (value.available === true) return true;
  return value.available === false && value.reason === "no_key";
}

function hasType(value: unknown, type: string): value is Record<string, unknown> {
  return isObject(value) && value.type === type;
}

export function isCheckUpdate(value: unknown): value is CheckUpdate {
  if (!hasType(value, "checkUpdate")) return false;
  if (!hasString(value, "checkId") || !hasString(value, "srcUrl")) return false;
  if (value.status === "checking") return true;
  if (value.status === "done") {
    return isCheckResult(value.result) && isOpenAiAvailability(value.openai);
  }
  if (value.status === "failed") {
    return isCheckError(value.error);
  }
  return false;
}

export function isReadBlob(value: unknown): value is ReadBlob {
  return hasType(value, "readBlob") && hasString(value, "checkId") && hasString(value, "url");
}

export function isReadBlobReply(value: unknown): value is ReadBlobReply {
  if (!isObject(value)) return false;
  if (value.ok === true) return isString(value.base64);
  return value.ok === false;
}

export function isOpenAiRequest(value: unknown): value is OpenAiRequest {
  return hasType(value, "openaiRequest") && hasString(value, "checkId");
}

export function isConfirmUpload(value: unknown): value is ConfirmUpload {
  return hasType(value, "confirmUpload") && hasString(value, "checkId") && typeof value.confirmed === "boolean";
}

export function isTestKey(value: unknown): value is TestKey {
  return hasType(value, "testKey");
}

export function isTestKeyReply(value: unknown): value is TestKeyReply {
  if (!isObject(value)) return false;
  if (value.ok === true) return true;
  return value.ok === false && isOpenAiError(value.error);
}

export function isKeyStatus(value: unknown): value is KeyStatus {
  return hasType(value, "keyStatus");
}

export function isKeyStatusReply(value: unknown): value is KeyStatusReply {
  return isObject(value) && typeof value.hasKey === "boolean";
}
