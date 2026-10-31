import { describe, expect, test } from "vitest";
import {
  isCheckError,
  isCheckResult,
  isCheckUpdate,
  isConfirmUpload,
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

const minimalResult: Record<string, unknown> = {
  imageHash: "h1",
  mediaType: "image/png",
  verdict: "no_signal",
  localC2pa: { manifest: "absent", aiAction: false },
  localXmp: { state: "not_detected" },
  openai: { state: "not_checked" },
};

const doneResult: Record<string, unknown> = {
  ...minimalResult,
  verdict: "ai_signal",
  localC2pa: {
    manifest: "present",
    aiAction: true,
    claimedIssuer: "OpenAI OpCo, LLC",
    claimedModel: "ChatGPT / gpt-image",
    generatedAt: "2026-01-01T00:00:00Z",
  },
  localXmp: {
    state: "detected",
    digitalSourceType:
      "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    generatorHint: "ChatGPT",
  },
  openai: {
    state: "done",
    serverConverted: false,
    c2pa: {
      outcome: "detected",
      validation: "trusted",
      issuer: "OpenAI OpCo, LLC",
      model: "ChatGPT / gpt-image",
      generatedAt: "2026-01-01T00:00:00Z",
    },
    synthid: { outcome: "detected", model: "gpt-image", generatedAt: "2026-01-01T00:00:00Z" },
  },
};

const checkingUpdate: unknown = {
  type: "checkUpdate",
  checkId: "c1",
  srcUrl: "https://example.test/i.png",
  status: "checking",
};

const doneUpdate: unknown = {
  type: "checkUpdate",
  checkId: "c1",
  srcUrl: "https://example.test/i.png",
  status: "done",
  result: minimalResult,
  openai: { available: true },
};

const failedUpdate: unknown = {
  type: "checkUpdate",
  checkId: "c1",
  srcUrl: "https://example.test/i.png",
  status: "failed",
  error: { code: "fetch_failed" },
};

interface GuardCase {
  name: string;
  guard: (value: unknown) => boolean;
  valid: unknown[];
  invalid: unknown[];
}

const guardCases: GuardCase[] = [
  {
    name: "isCheckUpdate",
    guard: isCheckUpdate,
    valid: [checkingUpdate, doneUpdate, failedUpdate],
    invalid: [
      ...notObjects,
      { type: "checkUpdate", checkId: 1, srcUrl: "u", status: "checking" },
      { type: "checkUpdate", checkId: "c1", status: "checking" },
      { type: "checkUpdate", checkId: "c1", srcUrl: "u", status: "unknown" },
      { type: "checkUpdate", checkId: "c1", srcUrl: "u", status: "done", openai: { available: true } },
      { type: "checkUpdate", checkId: "c1", srcUrl: "u", status: "done", result: minimalResult, openai: { available: "yes" } },
      { type: "checkUpdate", checkId: "c1", srcUrl: "u", status: "done", result: { ...minimalResult, verdict: "bogus" }, openai: { available: true } },
      { type: "checkUpdate", checkId: "c1", srcUrl: "u", status: "failed", error: { code: "network" } },
      { type: "checkUpdate", checkId: "c1", srcUrl: "u", status: "failed" },
    ],
  },
  {
    name: "isCheckResult",
    guard: isCheckResult,
    valid: [minimalResult, doneResult, { ...minimalResult, verdict: "incomplete", localC2pa: { manifest: "error", aiAction: false } }],
    invalid: [
      ...notObjects,
      { imageHash: "h1", mediaType: "image/png", verdict: "no_signal", localC2pa: { manifest: "absent", aiAction: false }, localXmp: { state: "not_detected" } },
      { ...minimalResult, imageHash: 42 },
      { ...minimalResult, verdict: "bogus" },
      { ...minimalResult, localC2pa: { manifest: "absent" } },
      { ...minimalResult, localC2pa: { manifest: "bogus", aiAction: false } },
      { ...minimalResult, localC2pa: { manifest: "absent", aiAction: "no" } },
      { ...minimalResult, localXmp: { state: "bogus" } },
      { ...minimalResult, openai: { state: "bogus" } },
      { ...minimalResult, openai: { state: "done", serverConverted: "yes", c2pa: { outcome: "detected" }, synthid: { outcome: "detected" } } },
      { ...minimalResult, openai: { state: "done", serverConverted: false, synthid: { outcome: "detected" } } },
      { ...minimalResult, openai: { state: "done", serverConverted: false, c2pa: { outcome: "detected" }, synthid: { outcome: "maybe" } } },
    ],
  },
  {
    name: "isCheckError",
    guard: isCheckError,
    valid: [{ code: "permission_denied" }, { code: "fetch_failed" }, { code: "timeout" }, { code: "too_large" }, { code: "unsupported_type" }],
    invalid: [...notObjects, {}, { code: "network" }, { code: "http_401" }, { code: ["timeout"] }],
  },
  {
    name: "isOpenAiError",
    guard: isOpenAiError,
    valid: [{ code: "no_key" }, { code: "rate_limited", retryAfterSec: 30 }, { code: "bad_response" }],
    invalid: [...notObjects, {}, { code: "bogus" }, { code: "http_429" }, { code: "rate_limited", retryAfterSec: "30" }, { code: "rate_limited", retryAfterSec: null }],
  },
  {
    name: "isOpenAiAvailability",
    guard: isOpenAiAvailability,
    valid: [{ available: true }, { available: false, reason: "no_key" }],
    invalid: [...notObjects, {}, { available: "true" }, { available: false }, { available: false, reason: "expired" }],
  },
  {
    name: "isReadBlob",
    guard: isReadBlob,
    valid: [{ type: "readBlob", checkId: "c1", url: "blob:https://example.test/1" }],
    invalid: [...notObjects, { type: "readBlob", checkId: "c1" }, { type: "readBlob", checkId: "c1", url: 5 }],
  },
  {
    name: "isReadBlobReply",
    guard: isReadBlobReply,
    valid: [{ ok: true, base64: "AAAA" }, { ok: false }],
    invalid: [...notObjects, { ok: true }, { ok: "yes" }, { base64: "AAAA" }, { ok: 1 }],
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
    valid: [{ type: "confirmUpload", checkId: "c1", confirmed: true }, { type: "confirmUpload", checkId: "c1", confirmed: false }],
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
    invalid: [...notObjects, { ok: false }, { ok: false, error: { code: "bogus" } }, { ok: "sure" }],
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
