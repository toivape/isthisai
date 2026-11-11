import { describe, expect, test } from "vitest";
import {
  isCheckError,
  isCheckRecord,
  isCheckResult,
  isCheckUpdate,
  isConfirmUpload,
  isDismissPopup,
  isKeyStatus,
  isKeyStatusReply,
  isOpenAiAvailability,
  isOpenAiError,
  isOpenAiRequest,
  isReadBlob,
  isReadBlobReply,
  isTestKey,
  isTestKeyReply,
} from "../src/shared/types";

const notObjects: unknown[] = [
  null,
  undefined,
  true,
  42,
  "checkUpdate",
  [],
  [{}],
  { type: "unknownKind" },
];

// Builders whose every field is valid, so an invalid case can turn off exactly
// one field. A guard mutant is only killed by an input that fails that one
// guard and passes the rest; an input that trips several at once lets the
// other guards cover for it.
function validRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkId: "c1",
    srcUrl: "https://example.test/i.png",
    frameUrl: "https://example.test/",
    tabId: 7,
    frameId: 0,
    imageHash: "h1",
    mediaType: "image/png",
    size: 1234,
    ...over,
  };
}

function validResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageHash: "h1",
    mediaType: "image/png",
    verdict: "no_signal",
    localC2pa: { manifest: "absent", aiAction: false },
    localXmp: { state: "not_detected" },
    openai: { state: "not_checked" },
    ...over,
  };
}

const openAiDone = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: "done",
  serverConverted: false,
  c2pa: { outcome: "detected" },
  synthid: { outcome: "not_detected" },
  ...over,
});

const checkUpdate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "checkUpdate",
  checkId: "c1",
  srcUrl: "https://example.test/i.png",
  status: "checking",
  ...over,
});

interface GuardCase {
  name: string;
  guard: (value: unknown) => boolean;
  valid: unknown[];
  invalid: unknown[];
}

const guardCases: GuardCase[] = [
  {
    name: "isDismissPopup",
    guard: isDismissPopup,
    valid: [{ type: "dismissPopup" }],
    invalid: [...notObjects, { type: "checkUpdate" }, { type: "dismissPopups" }],
  },
  {
    name: "isCheckUpdate",
    guard: isCheckUpdate,
    valid: [
      checkUpdate(),
      checkUpdate({ status: "done", result: validResult(), openai: { available: true } }),
      checkUpdate({ status: "done", result: validResult(), openai: { available: false, reason: "no_key" } }),
      checkUpdate({ status: "failed", error: { code: "fetch_failed" } }),
    ],
    invalid: [
      ...notObjects,
      checkUpdate({ checkId: 1 }),
      checkUpdate({ srcUrl: 1 }),
      checkUpdate({ checkId: undefined }),
      checkUpdate({ srcUrl: undefined }),
      checkUpdate({ status: "unknown" }),
      // An unknown status with an otherwise valid failed payload kills the
      // mutant that treats every non-done status as "failed".
      checkUpdate({ status: "unknown", error: { code: "fetch_failed" } }),
      checkUpdate({ status: "done", openai: { available: true } }),
      checkUpdate({ status: "done", result: validResult(), openai: { available: "yes" } }),
      checkUpdate({ status: "done", result: validResult(), openai: { available: false, reason: "expired" } }),
      checkUpdate({ status: "done", result: validResult({ verdict: "bogus" }), openai: { available: true } }),
      checkUpdate({ status: "failed", error: { code: "network" } }),
      checkUpdate({ status: "failed" }),
    ],
  },
  {
    name: "isCheckResult",
    guard: isCheckResult,
    valid: [
      validResult(),
      ...["ai_signal", "no_signal", "incomplete"].map((verdict) => validResult({ verdict })),
      ...["absent", "present", "invalid", "remote_unfetched", "error"].map((manifest) =>
        validResult({ localC2pa: { manifest, aiAction: false } }),
      ),
      ...["detected", "not_detected", "error"].map((state) => validResult({ localXmp: { state } })),
      validResult({
        localC2pa: { manifest: "present", aiAction: true, claimedIssuer: "x", claimedModel: "y", generatedAt: "z" },
      }),
      validResult({ localXmp: { state: "detected", digitalSourceType: "d", generatorHint: "g" } }),
      validResult({ openai: openAiDone() }),
      ...["trusted", "valid", "invalid", "not_present"].map((validation) =>
        validResult({ openai: openAiDone({ c2pa: { outcome: "detected", validation } }) }),
      ),
      validResult({
        openai: openAiDone({
          serverConverted: true,
          c2pa: { outcome: "detected", validation: "trusted", issuer: "i", model: "m", generatedAt: "g" },
          synthid: { outcome: "detected", model: "m", generatedAt: "g" },
        }),
      }),
    ],
    invalid: [
      ...notObjects,
      validResult({ imageHash: 1 }),
      validResult({ mediaType: 1 }),
      validResult({ verdict: "bogus" }),
      validResult({ localC2pa: 5 }),
      validResult({ localC2pa: { manifest: "absent" } }),
      validResult({ localC2pa: { manifest: "bogus", aiAction: false } }),
      validResult({ localC2pa: { manifest: "absent", aiAction: "no" } }),
      validResult({ localC2pa: { manifest: "absent", aiAction: false, claimedIssuer: 5 } }),
      validResult({ localC2pa: { manifest: "absent", aiAction: false, claimedModel: 5 } }),
      validResult({ localC2pa: { manifest: "absent", aiAction: false, generatedAt: 5 } }),
      validResult({ localXmp: 5 }),
      validResult({ localXmp: { state: "bogus" } }),
      validResult({ localXmp: { state: "not_detected", digitalSourceType: 5 } }),
      validResult({ localXmp: { state: "not_detected", generatorHint: 5 } }),
      validResult({ openai: 5 }),
      validResult({ openai: { state: "bogus" } }),
      // A non-done state carrying the whole done payload kills the mutant that
      // drops the state check.
      validResult({ openai: openAiDone({ state: "bogus" }) }),
      validResult({ openai: { state: "done", c2pa: { outcome: "detected" }, synthid: { outcome: "detected" } } }),
      validResult({ openai: openAiDone({ serverConverted: "yes" }) }),
      validResult({ openai: openAiDone({ c2pa: 5 }) }),
      validResult({ openai: openAiDone({ c2pa: { outcome: "bogus" } }) }),
      validResult({ openai: openAiDone({ c2pa: { outcome: "" } }) }),
      validResult({ openai: openAiDone({ c2pa: { outcome: "detected", validation: "bogus" } }) }),
      validResult({ openai: openAiDone({ c2pa: { outcome: "detected", validation: 5 } }) }),
      validResult({ openai: openAiDone({ c2pa: { outcome: "detected", issuer: 5 } }) }),
      validResult({ openai: openAiDone({ c2pa: { outcome: "detected", model: 5 } }) }),
      validResult({ openai: openAiDone({ c2pa: { outcome: "detected", generatedAt: 5 } }) }),
      validResult({ openai: openAiDone({ synthid: 5 }) }),
      validResult({ openai: openAiDone({ synthid: { outcome: "bogus" } }) }),
      validResult({ openai: openAiDone({ synthid: { outcome: "detected", model: 5 } }) }),
      validResult({ openai: openAiDone({ synthid: { outcome: "detected", generatedAt: 5 } }) }),
      validResult({ openai: { state: "done", serverConverted: false, c2pa: { outcome: "detected" } } }),
    ],
  },
  {
    name: "isCheckRecord",
    guard: isCheckRecord,
    valid: [validRecord()],
    invalid: [
      ...notObjects,
      {},
      { checkId: "c1" },
      validRecord({ checkId: 1 }),
      validRecord({ srcUrl: 1 }),
      validRecord({ frameUrl: 1 }),
      validRecord({ imageHash: 1 }),
      validRecord({ mediaType: 1 }),
      validRecord({ tabId: "7" }),
      validRecord({ frameId: "0" }),
      validRecord({ size: "1" }),
    ],
  },
  {
    name: "isCheckError",
    guard: isCheckError,
    valid: [
      { code: "permission_denied" },
      { code: "fetch_failed" },
      { code: "timeout" },
      { code: "too_large" },
      { code: "unsupported_type" },
    ],
    invalid: [...notObjects, {}, { code: "network" }, { code: "http_401" }, { code: ["timeout"] }, { code: 5 }],
  },
  {
    name: "isOpenAiError",
    guard: isOpenAiError,
    // Every code in the union must be accepted on its own, or a mutant that
    // blanks one list entry goes unnoticed.
    valid: [
      ...[
        "no_key", "cancelled", "check_expired", "hash_mismatch", "unsupported_type", "fetch_failed",
        "timeout", "http_400", "http_401", "http_404", "http_4xx", "http_5xx", "rate_limited", "network",
        "bad_response",
      ].map((code) => ({ code })),
      { code: "rate_limited", retryAfterSec: 30 },
      { code: "rate_limited", retryAfterSec: 0 },
    ],
    invalid: [
      ...notObjects,
      {},
      { code: "bogus" },
      { code: "http_429" },
      { code: 401 },
      { code: "rate_limited", retryAfterSec: "30" },
      { code: "rate_limited", retryAfterSec: null },
    ],
  },
  {
    name: "isOpenAiAvailability",
    guard: isOpenAiAvailability,
    valid: [{ available: true }, { available: true, reason: "no_key" }, { available: false, reason: "no_key" }],
    invalid: [...notObjects, {}, { available: "true" }, { available: false }, { available: false, reason: "expired" }, { available: 1 },
      // available is neither false nor true but reason is right: distinguishes
      // "available === false" from "reason === 'no_key'".
      { available: 1, reason: "no_key" }, { available: null, reason: "no_key" }],
  },
  {
    name: "isReadBlob",
    guard: isReadBlob,
    valid: [{ type: "readBlob", checkId: "c1", url: "blob:https://example.test/1" }],
    invalid: [
      ...notObjects,
      { type: "readBlob", checkId: "c1" },
      { type: "readBlob", checkId: "c1", url: 5 },
      { type: "readBlob", checkId: 5, url: "u" },
    ],
  },
  {
    name: "isReadBlobReply",
    guard: isReadBlobReply,
    valid: [{ ok: true, base64: "AAAA" }, { ok: false }, { ok: false, reason: "too_large" }],
    invalid: [
      ...notObjects,
      {},
      { ok: true },
      { ok: true, base64: 5 },
      { ok: false, reason: "bogus" },
      { ok: 1 },
    ],
  },
  {
    name: "isOpenAiRequest",
    guard: isOpenAiRequest,
    valid: [{ type: "openaiRequest", checkId: "c1" }],
    invalid: [...notObjects, { type: "openaiRequest" }, { type: "openaiRequest", checkId: 5 }],
  },
  {
    name: "isConfirmUpload",
    guard: isConfirmUpload,
    valid: [
      { type: "confirmUpload", checkId: "c1", confirmed: true },
      { type: "confirmUpload", checkId: "c1", confirmed: false },
    ],
    invalid: [...notObjects, { type: "confirmUpload", checkId: "c1" }, { type: "confirmUpload", checkId: "c1", confirmed: "true" }],
  },
  {
    name: "isTestKey",
    guard: isTestKey,
    valid: [{ type: "testKey" }],
    invalid: [...notObjects, { type: "testkey" }, {}],
  },
  {
    name: "isTestKeyReply",
    guard: isTestKeyReply,
    valid: [{ ok: true }, { ok: false, error: { code: "http_401" } }],
    invalid: [...notObjects, {}, { ok: false }, { ok: false, error: { code: "bogus" } }, { ok: "sure" }, { ok: 1 },
      // ok is neither true nor false but the error is valid: distinguishes
      // "value.ok === false" from "isOpenAiError(value.error)".
      { ok: 1, error: { code: "http_401" } }],
  },
  {
    name: "isKeyStatus",
    guard: isKeyStatus,
    valid: [{ type: "keyStatus" }],
    invalid: [...notObjects, { type: "keystatus" }, {}],
  },
  {
    name: "isKeyStatusReply",
    guard: isKeyStatusReply,
    valid: [{ hasKey: true }, { hasKey: false }],
    invalid: [...notObjects, {}, { hasKey: "yes" }, { hasKey: 1 }],
  },
];

describe("message type guards", () => {
  test.each(guardCases)("accepts valid messages: $name", ({ guard, valid }) => {
    for (const value of valid) {
      expect(guard(value), JSON.stringify(value)).toBe(true);
    }
  });

  test.each(guardCases)("rejects non-messages, unknown types and missing fields: $name", ({ guard, invalid }) => {
    for (const value of invalid) {
      expect(guard(value), JSON.stringify(value)).toBe(false);
    }
  });
});
