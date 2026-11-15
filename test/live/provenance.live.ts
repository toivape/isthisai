import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildRequest, sendProvenanceUpload } from "../../src/background/openai";
import { sniffMediaType } from "../../src/background/sniff";

// Opt-in: one real upload per image, so each run uses four requests of a strict
// rate limit. The key value must never appear in an assertion message.

const KEY = process.env.OPENAI_API_KEY;

test("OPENAI_API_KEY is set (its value is never printed)", () => {
  expect(KEY, "Set OPENAI_API_KEY before running npm run test:live.").toBeTruthy();
});

interface ExpectedSignal {
  type: string;
  outcome: string;
  validation_state?: string | null;
}

function expectedSignal(fixture: string, type: string): ExpectedSignal {
  const parsed = JSON.parse(readFileSync(`test/fixtures/${fixture}`, "utf8")) as { results: ExpectedSignal[] };
  const entry = parsed.results.find((signal) => signal.type === type);
  if (entry === undefined) throw new Error(`${fixture} has no ${type} entry`);
  return entry;
}

async function check(image: string) {
  const bytes = new Uint8Array(readFileSync(`test/fixtures/${image}`));
  const built = buildRequest(KEY ?? "", bytes, sniffMediaType(bytes));
  if (!built.ok) throw new Error(`${image}: ${built.error.code}`);
  const parsed = await sendProvenanceUpload(built.request);
  if (!parsed.ok) {
    throw new Error(`${image}: ${parsed.error.code}${parsed.error.retryAfterSec === undefined ? "" : ` (retry after ${parsed.error.retryAfterSec}s)`}`);
  }
  return parsed.result;
}

const CASES = [
  { image: "ai-test-halloween.png", fixture: "openai-halloween.json", issuer: "OpenAI OpCo, LLC", model: "gpt-image" },
  { image: "ai-tes-iceland.jpg", fixture: "openai-iceland.json" },
  { image: "ai-test-halloween-resaved.jpg", fixture: "openai-halloween-resaved.json" },
];

describe.skipIf(KEY === undefined)("live content provenance checks", () => {
  for (const { image, fixture, issuer, model } of CASES) {
    test(`${image} matches ${fixture}`, async () => {
      const result = await check(image);
      expect(result.c2pa.outcome).toBe(expectedSignal(fixture, "c2pa").outcome);
      expect(result.synthid.outcome).toBe(expectedSignal(fixture, "synthid").outcome);
      const validation = expectedSignal(fixture, "c2pa").validation_state;
      if (validation !== null && validation !== undefined) {
        expect(result.c2pa.validation).toBe(validation);
      }
      if (issuer !== undefined) expect(result.c2pa.issuer).toBe(issuer);
      if (model !== undefined) expect(result.c2pa.model).toContain(model);
    });
  }

  test("meta bunny: neither signal is an OpenAI signal", async () => {
    // Meta's own C2PA and watermark are not OpenAI signals (PLAN §10 Q3).
    const result = await check("ai-meta-bunny.jpg");
    expect(result.c2pa.outcome).toBe("not_detected");
    expect(result.synthid.outcome).toBe("not_detected");
  });
});
