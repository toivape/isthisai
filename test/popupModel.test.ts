import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { popupModel, type PopupLine, type PopupModel } from "../src/content/popupModel";
import type { CheckResult, OpenAiAvailability, OpenAiResultPart } from "../src/shared/types";

const available: OpenAiAvailability = { available: true };
const noKey: OpenAiAvailability = { available: false, reason: "no_key" };

function result(overrides: {
  verdict?: CheckResult["verdict"];
  localC2pa?: Partial<CheckResult["localC2pa"]>;
  localXmp?: Partial<CheckResult["localXmp"]>;
  openai?: OpenAiResultPart;
}): CheckResult {
  return {
    imageHash: "hash",
    mediaType: "image/png",
    verdict: overrides.verdict ?? "no_signal",
    localC2pa: { manifest: "absent", aiAction: false, ...overrides.localC2pa },
    localXmp: { state: "not_detected", ...overrides.localXmp },
    openai: overrides.openai ?? { state: "not_checked" },
  };
}

function openAiDone(
  c2pa: Partial<Extract<OpenAiResultPart, { state: "done" }>["c2pa"]>,
  synthid: Partial<Extract<OpenAiResultPart, { state: "done" }>["synthid"]> = {},
  serverConverted = false,
): OpenAiResultPart {
  return {
    state: "done",
    serverConverted,
    c2pa: { outcome: "not_detected", ...c2pa },
    synthid: { outcome: "not_detected", ...synthid },
  };
}

function line(model: PopupModel, labelKey: string): PopupLine {
  const found = model.lines.find((l) => l.labelKey === labelKey);
  if (found === undefined) throw new Error(`no line ${labelKey} in ${model.lines.map((l) => l.labelKey).join(", ")}`);
  return found;
}

const trainedAlgorithmic = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

describe("headline", () => {
  test("follows the verdict", () => {
    expect(popupModel(result({ verdict: "ai_signal" }), available).headlineKey).toBe("popup_headline_ai_signal");
    expect(popupModel(result({ verdict: "no_signal" }), available).headlineKey).toBe("popup_headline_no_signal");
    expect(popupModel(result({ verdict: "incomplete" }), available).headlineKey).toBe("popup_headline_incomplete");
  });

  test("only incomplete carries a detail paragraph", () => {
    expect(popupModel(result({ verdict: "incomplete" }), available).detailKey).toBe("popup_detail_incomplete");
    expect(popupModel(result({ verdict: "ai_signal" }), available).detailKey).toBeUndefined();
    expect(popupModel(result({ verdict: "no_signal" }), available).detailKey).toBeUndefined();
  });
});

describe("the C2PA line", () => {
  test("absent: no Content Credentials were found", () => {
    const model = popupModel(result({ localC2pa: { manifest: "absent", aiAction: false } }), available);
    expect(line(model, "popup_line_c2pa").parts).toEqual([{ key: "popup_c2pa_absent" }]);
  });

  test("present with an AI action names the claimed issuer and model", () => {
    const model = popupModel(
      result({
        localC2pa: {
          manifest: "present",
          aiAction: true,
          claimedIssuer: "OpenAI OpCo, LLC",
          claimedModel: "ChatGPT / gpt-image",
        },
      }),
      available,
    );
    expect(line(model, "popup_line_c2pa").parts).toEqual([
      { key: "popup_c2pa_present_ai" },
      { key: "popup_claimed_issuer", substitutions: ["OpenAI OpCo, LLC"] },
      { key: "popup_claimed_model", substitutions: ["ChatGPT / gpt-image"] },
    ]);
  });

  test("present without an AI action (a camera) is not presented as an AI source", () => {
    const model = popupModel(
      result({ localC2pa: { manifest: "present", aiAction: false, claimedIssuer: "Leica Camera AG" } }),
      available,
    );
    expect(line(model, "popup_line_c2pa").parts).toEqual([
      { key: "popup_c2pa_present_other" },
      { key: "popup_claimed_issuer", substitutions: ["Leica Camera AG"] },
    ]);
  });

  test("invalid with a broken binding says the manifest did not verify", () => {
    const model = popupModel(
      result({
        localC2pa: { manifest: "invalid", aiAction: true, integrity: "unverified", claimedIssuer: "OpenAI OpCo, LLC" },
      }),
      available,
    );
    expect(line(model, "popup_line_c2pa").parts).toEqual([{ key: "popup_c2pa_unverified" }]);
  });

  test("invalid with an intact binding names the profile failure and the claimed issuer", () => {
    const model = popupModel(
      result({
        localC2pa: {
          manifest: "invalid",
          aiAction: true,
          integrity: "verified",
          claimedIssuer: "Microsoft Corporation",
          claimedModel: "Bing Image Creator",
        },
      }),
      available,
    );
    expect(line(model, "popup_line_c2pa").parts).toEqual([
      { key: "popup_c2pa_profile" },
      { key: "popup_claimed_issuer", substitutions: ["Microsoft Corporation"] },
      { key: "popup_claimed_model", substitutions: ["Bing Image Creator"] },
    ]);
  });

  test("a remote manifest says it was not downloaded", () => {
    const model = popupModel(result({ localC2pa: { manifest: "remote_unfetched", aiAction: false } }), available);
    expect(line(model, "popup_line_c2pa").parts).toEqual([{ key: "popup_c2pa_remote" }]);
  });

  test("a read error is reported as its own state", () => {
    const model = popupModel(result({ localC2pa: { manifest: "error", aiAction: false } }), available);
    expect(line(model, "popup_line_c2pa").parts).toEqual([{ key: "popup_c2pa_error" }]);
  });

  test("an issuer without a model omits the model part", () => {
    const model = popupModel(
      result({ localC2pa: { manifest: "present", aiAction: true, claimedIssuer: "OpenAI OpCo, LLC" } }),
      available,
    );
    expect(line(model, "popup_line_c2pa").parts).toEqual([
      { key: "popup_c2pa_present_ai" },
      { key: "popup_claimed_issuer", substitutions: ["OpenAI OpCo, LLC"] },
    ]);
  });
});

describe("the XMP line", () => {
  test("detected names the unsigned metadata and the DigitalSourceType", () => {
    const model = popupModel(
      result({ localXmp: { state: "detected", digitalSourceType: trainedAlgorithmic } }),
      available,
    );
    expect(line(model, "popup_line_xmp").parts).toEqual([
      { key: "popup_xmp_detected" },
      { key: "popup_xmp_source_type", substitutions: [trainedAlgorithmic] },
    ]);
  });

  test("detected without a source type still reports the metadata", () => {
    const model = popupModel(result({ localXmp: { state: "detected" } }), available);
    expect(line(model, "popup_line_xmp").parts).toEqual([{ key: "popup_xmp_detected" }]);
  });

  test("a generator hint is shown only when the scanner recorded one", () => {
    const model = popupModel(
      result({ localXmp: { state: "detected", generatorHint: "Exiv2" } }),
      available,
    );
    expect(line(model, "popup_line_xmp").parts).toEqual([
      { key: "popup_xmp_detected" },
      { key: "popup_xmp_generator", substitutions: ["Exiv2"] },
    ]);
  });

  test("not detected and error each have their own wording", () => {
    expect(line(popupModel(result({ localXmp: { state: "not_detected" } }), available), "popup_line_xmp").parts).toEqual([
      { key: "popup_xmp_not_detected" },
    ]);
    expect(line(popupModel(result({ localXmp: { state: "error" } }), available), "popup_line_xmp").parts).toEqual([
      { key: "popup_xmp_error" },
    ]);
  });
});

describe("the SynthID line", () => {
  test("before a check it says so", () => {
    const model = popupModel(result({}), available);
    expect(line(model, "popup_line_synthid").parts).toEqual([{ key: "popup_synthid_not_checked" }]);
  });

  test("the button is enabled when an OpenAI check is available", () => {
    expect(popupModel(result({}), available).button).toEqual({ state: "enabled" });
  });

  test("the button is disabled with the no-key reason when no key is saved", () => {
    expect(popupModel(result({}), noKey).button).toEqual({ state: "disabled", reasonKey: "popup_button_no_key" });
  });

  test("after a check the button is gone and a detected watermark is shown", () => {
    const model = popupModel(result({ openai: openAiDone({}, { outcome: "detected", model: "SynthID" }) }), available);
    expect(model.button).toEqual({ state: "hidden" });
    expect(line(model, "popup_line_synthid").parts).toEqual([
      { key: "popup_synthid_detected" },
      { key: "popup_claimed_model", substitutions: ["SynthID"] },
    ]);
  });

  test("after a check a missing watermark is shown", () => {
    const model = popupModel(result({ openai: openAiDone({}) }), available);
    expect(line(model, "popup_line_synthid").parts).toEqual([{ key: "popup_synthid_not_detected" }]);
  });

  test("a server-converted result warns that the copy may have been re-encoded", () => {
    const model = popupModel(result({ openai: openAiDone({}, {}, true) }), available);
    expect(model.showConvertedNote).toBe(true);
    expect(popupModel(result({ openai: openAiDone({}) }), available).showConvertedNote).toBe(false);
  });
});

describe("the OpenAI C2PA line", () => {
  test("is absent until a check has run", () => {
    const model = popupModel(result({}), available);
    expect(model.lines.map((l) => l.labelKey)).toEqual(["popup_line_c2pa", "popup_line_xmp", "popup_line_synthid"]);
  });

  test("a detected manifest is shown with its validation state and issuer", () => {
    const model = popupModel(
      result({
        openai: openAiDone({ outcome: "detected", validation: "trusted", issuer: "Google LLC", model: "Imagen" }),
      }),
      available,
    );
    expect(model.lines.map((l) => l.labelKey)).toEqual([
      "popup_line_c2pa",
      "popup_line_xmp",
      "popup_line_synthid",
      "popup_line_openai_c2pa",
    ]);
    expect(line(model, "popup_line_openai_c2pa").parts).toEqual([
      { key: "popup_openai_c2pa_detected" },
      { key: "popup_openai_c2pa_validation_trusted" },
      { key: "popup_claimed_issuer", substitutions: ["Google LLC"] },
      { key: "popup_claimed_model", substitutions: ["Imagen"] },
    ]);
  });

  test("every validation state has its own wording", () => {
    for (const validation of ["trusted", "valid", "invalid", "not_present"] as const) {
      const model = popupModel(result({ openai: openAiDone({ outcome: "detected", validation }) }), available);
      expect(line(model, "popup_line_openai_c2pa").parts[1]).toEqual({
        key: `popup_openai_c2pa_validation_${validation}`,
      });
    }
  });

  test("a missing manifest is reported", () => {
    const model = popupModel(result({ openai: openAiDone({}) }), available);
    expect(line(model, "popup_line_openai_c2pa").parts).toEqual([{ key: "popup_openai_c2pa_not_detected" }]);
  });

  test("a detected manifest without a validation state omits that part", () => {
    // `validation` is optional in the type; a manifest that carries none must
    // not produce a part for the missing state.
    const model = popupModel(result({ openai: openAiDone({ outcome: "detected" }) }), available);
    expect(line(model, "popup_line_openai_c2pa").parts).toEqual([{ key: "popup_openai_c2pa_detected" }]);
  });

  test("never reads as OpenAI vouching for the manifest", () => {
    // A third-party manifest comes back trusted (a Google-signed file), so a
    // word like "verified by OpenAI" would read as OpenAI vouching for another
    // vendor's image (hard rule 8, PLAN §5).
    const model = popupModel(
      result({ openai: openAiDone({ outcome: "detected", validation: "trusted", issuer: "Google LLC" }) }),
      available,
    );
    const messages = JSON.parse(readFileSync("_locales/en/messages.json", "utf8")) as Record<string, { message: string }>;
    const rendered = line(model, "popup_line_openai_c2pa")
      .parts.map((part) => {
        let text = messages[part.key]?.message ?? part.key;
        (part.substitutions ?? []).forEach((value, index) => {
          text = text.replace(`$${index + 1}`, value);
        });
        return text;
      })
      .join(" ");
    expect(rendered).toMatch(/Google LLC/);
    expect(rendered).not.toMatch(/verif/i);
    expect(rendered).not.toMatch(/OpenAI/);
  });
});

describe("the OpenAI note", () => {
  test("appears only after a check", () => {
    expect(popupModel(result({}), available).showOpenAiNote).toBe(false);
    expect(popupModel(result({ openai: openAiDone({}) }), available).showOpenAiNote).toBe(true);
  });
});

describe("every key the model can emit", () => {
  const cases: PopupModel[] = [
    popupModel(result({ verdict: "no_signal" }), available),
    popupModel(result({ verdict: "incomplete" }), available),
    popupModel(result({ localC2pa: { manifest: "present", aiAction: true, claimedIssuer: "x", claimedModel: "y" } }), available),
    popupModel(result({ localC2pa: { manifest: "present", aiAction: false } }), available),
    popupModel(result({ localC2pa: { manifest: "invalid", aiAction: true, integrity: "verified" } }), available),
    popupModel(result({ localC2pa: { manifest: "invalid", aiAction: true, integrity: "unverified" } }), available),
    popupModel(result({ localC2pa: { manifest: "remote_unfetched", aiAction: false } }), available),
    popupModel(result({ localC2pa: { manifest: "error", aiAction: false } }), available),
    popupModel(result({ localXmp: { state: "detected", digitalSourceType: "d", generatorHint: "g" } }), available),
    popupModel(result({ localXmp: { state: "error" } }), available),
    popupModel(result({ openai: openAiDone({ outcome: "detected", validation: "trusted", issuer: "i", model: "m" }, { outcome: "detected", model: "s" }, true) }), noKey),
  ];

  test("names a message both locales define", () => {
    const en = new Set(Object.keys(JSON.parse(readFileSync("_locales/en/messages.json", "utf8")) as object));
    const fi = new Set(Object.keys(JSON.parse(readFileSync("_locales/fi/messages.json", "utf8")) as object));
    const keys = new Set<string>();
    for (const model of cases) {
      keys.add(model.headlineKey);
      if (model.detailKey) keys.add(model.detailKey);
      keys.add("popup_button_openai");
      keys.add("popup_caveat_no_signal");
      keys.add("popup_openai_note");
      if (model.button.state === "disabled") keys.add(model.button.reasonKey);
      if (model.showConvertedNote) keys.add("popup_synthid_converted");
      for (const l of model.lines) {
        keys.add(l.labelKey);
        for (const part of l.parts) keys.add(part.key);
      }
    }
    expect(keys.size).toBeGreaterThan(20);
    for (const key of keys) {
      expect(en.has(key), `${key} missing from en`).toBe(true);
      expect(fi.has(key), `${key} missing from fi`).toBe(true);
    }
  });
});
