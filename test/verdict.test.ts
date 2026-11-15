import { describe, expect, test } from "vitest";
import { computeVerdict, mergeOpenAi } from "../src/background/verdict";
import type { CheckResult, OpenAiResultPart } from "../src/shared/types";

// Builder helpers keep each case focused on the signal being described.
function result(overrides: {
  localC2pa?: Partial<CheckResult["localC2pa"]>;
  localXmp?: Partial<CheckResult["localXmp"]>;
  openai?: OpenAiResultPart;
}): CheckResult {
  return {
    imageHash: "hash",
    mediaType: "image/png",
    verdict: "incomplete",
    localC2pa: { manifest: "absent", aiAction: false, ...overrides.localC2pa },
    localXmp: { state: "not_detected", ...overrides.localXmp },
    openai: overrides.openai ?? { state: "not_checked" },
  };
}

function openAiDone(
  c2pa: Partial<Extract<OpenAiResultPart, { state: "done" }>["c2pa"]>,
  synthid: Partial<Extract<OpenAiResultPart, { state: "done" }>["synthid"]> = {},
): OpenAiResultPart {
  return {
    state: "done",
    serverConverted: false,
    c2pa: { outcome: "not_detected", ...c2pa },
    synthid: { outcome: "not_detected", ...synthid },
  };
}

const trainedAlgorithmic = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

describe("computeVerdict", () => {
  test("nothing found gives no_signal", () => {
    const verdict = computeVerdict(result({}));
    expect(verdict).toBe("no_signal");
  });

  test("C2PA present with AI action gives ai_signal", () => {
    expect(computeVerdict(result({ localC2pa: { manifest: "present", aiAction: true } }))).toBe("ai_signal");
  });

  test("C2PA present without AI action (camera) gives no_signal", () => {
    expect(computeVerdict(result({ localC2pa: { manifest: "present", aiAction: false } }))).toBe("no_signal");
  });

  test("an invalid manifest with an intact binding and an AI action gives ai_signal", () => {
    // A signer certificate the C2PA profile rejects, with the signature and data
    // hash both verified: the image really does carry an AI claim.
    expect(
      computeVerdict(result({ localC2pa: { manifest: "invalid", aiAction: true, integrity: "verified" } })),
    ).toBe("ai_signal");
  });

  test("a tampered manifest with an AI action gives no_signal", () => {
    // The AI action is still readable but the bytes no longer match the binding,
    // so the claim is not evidence about this image.
    expect(
      computeVerdict(result({ localC2pa: { manifest: "invalid", aiAction: true, integrity: "unverified" } })),
    ).toBe("no_signal");
  });

  test("an invalid manifest with an AI action but no integrity recorded gives no_signal", () => {
    // The field is absent when there was nothing to assess; it must not be read
    // as verified.
    expect(computeVerdict(result({ localC2pa: { manifest: "invalid", aiAction: true } }))).toBe("no_signal");
  });

  test("C2PA error, or remote_unfetched, with nothing else gives incomplete", () => {
    expect(computeVerdict(result({ localC2pa: { manifest: "error", aiAction: false } }))).toBe("incomplete");
    expect(computeVerdict(result({ localC2pa: { manifest: "remote_unfetched", aiAction: false } }))).toBe("incomplete");
  });

  test("XMP detected gives ai_signal; XMP error alone gives incomplete", () => {
    expect(
      computeVerdict(result({ localXmp: { state: "detected", digitalSourceType: trainedAlgorithmic } })),
    ).toBe("ai_signal");
    expect(computeVerdict(result({ localXmp: { state: "error" } }))).toBe("incomplete");
  });

  test("generator hint alone gives no_signal", () => {
    expect(computeVerdict(result({ localXmp: { state: "not_detected", generatorHint: "ChatGPT" } }))).toBe("no_signal");
  });

  test("OpenAI C2PA detected with trusted or valid gives ai_signal; with invalid does not", () => {
    expect(computeVerdict(result({ openai: openAiDone({ outcome: "detected", validation: "trusted" }) }))).toBe("ai_signal");
    expect(computeVerdict(result({ openai: openAiDone({ outcome: "detected", validation: "valid" }) }))).toBe("ai_signal");
    expect(computeVerdict(result({ openai: openAiDone({ outcome: "detected", validation: "invalid" }) }))).toBe("no_signal");
  });

  test("OpenAI not_detected with a trusted or valid third-party manifest is not a signal", () => {
    // Observed on real files: a Google-signed image returns outcome not_detected
    // with validation trusted, and a Microsoft-signed one with valid. The API
    // still describes the manifest; only the outcome gates the signal.
    expect(computeVerdict(result({ openai: openAiDone({ outcome: "not_detected", validation: "trusted" }) }))).toBe("no_signal");
    expect(computeVerdict(result({ openai: openAiDone({ outcome: "not_detected", validation: "valid" }) }))).toBe("no_signal");
  });

  test("OpenAI SynthID detected gives ai_signal", () => {
    expect(computeVerdict(result({ openai: openAiDone({}, { outcome: "detected" }) }))).toBe("ai_signal");
  });

  test("C2PA error plus OpenAI SynthID detected gives ai_signal", () => {
    const r = result({
      localC2pa: { manifest: "error", aiAction: false },
      openai: openAiDone({}, { outcome: "detected" }),
    });
    expect(computeVerdict(r)).toBe("ai_signal");
  });
});

describe("mergeOpenAi", () => {
  test("keeps the local parts and recomputes the verdict", () => {
    const local = result({
      localC2pa: { manifest: "absent", aiAction: false },
      localXmp: { state: "not_detected" },
    });
    const openai = openAiDone({}, { outcome: "detected" });
    const merged = mergeOpenAi(local, openai);
    expect(merged.openai).toEqual(openai);
    expect(merged.localC2pa).toEqual(local.localC2pa);
    expect(merged.localXmp).toEqual(local.localXmp);
    expect(merged.verdict).toBe("ai_signal");
  });
});
