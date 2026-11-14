import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildRequest, sendProvenanceUpload } from "../../src/background/openai";
import { sniffMediaType } from "../../src/background/sniff";

// Opt-in: hits the real Content Provenance API once per fixture. Run with
// `npm run test:live` and OPENAI_API_KEY set; it never runs under `npm test`.
// The key value is only ever placed in the Authorization header — it is not
// logged, not put in a URL and not part of any assertion message.

const KEY = process.env.OPENAI_API_KEY;

test("OPENAI_API_KEY is set (its value is never printed)", () => {
  expect(KEY, "Set OPENAI_API_KEY before running npm run test:live.").toBeTruthy();
});

interface ExpectedSignal {
  type: string;
  outcome: string;
  validation_state?: string | null;
}

// The owner's recorded responses are the expected values (PLAN §8).
function expectedSignal(fixture: string, type: string): ExpectedSignal {
  const parsed = JSON.parse(readFileSync(`test/fixtures/${fixture}`, "utf8")) as { results: ExpectedSignal[] };
  const entry = parsed.results.find((signal) => signal.type === type);
  if (entry === undefined) throw new Error(`${fixture} has no ${type} entry`);
  return entry;
}

async function check(image: string) {
  const bytes = new Uint8Array(readFileSync(`test/fixtures/${image}`));
  const parsed = await sendProvenanceUpload(buildRequest(KEY ?? "", bytes, sniffMediaType(bytes)), false);
  if (!parsed.ok) {
    throw new Error(`${image}: ${parsed.error.code}${parsed.error.retryAfterSec === undefined ? "" : ` (retry after ${parsed.error.retryAfterSec}s)`}`);
  }
  return parsed.result;
}

const CASES = [
  { image: "ai-test-halloween.png", fixture: "openai-halloween.json" },
  { image: "ai-tes-iceland.jpg", fixture: "openai-iceland.json" },
  { image: "ai-test-halloween-resaved.jpg", fixture: "openai-halloween-resaved.json" },
];

describe.skipIf(KEY === undefined)("live content provenance checks", () => {
  for (const { image, fixture } of CASES) {
    test(`${image} matches ${fixture}`, async () => {
      const result = await check(image);
      expect(result.c2pa.outcome).toBe(expectedSignal(fixture, "c2pa").outcome);
      expect(result.synthid.outcome).toBe(expectedSignal(fixture, "synthid").outcome);
      const validation = expectedSignal(fixture, "c2pa").validation_state;
      if (validation !== null && validation !== undefined) {
        expect(result.c2pa.validation).toBe(validation);
      }
    });
  }

  test("the halloween image is attributed to OpenAI", async () => {
    const result = await check("ai-test-halloween.png");
    expect(result.c2pa.issuer).toBe("OpenAI OpCo, LLC");
    expect(result.c2pa.model).toContain("gpt-image");
  });

  test("meta bunny: neither signal is an OpenAI signal", async () => {
    // Meta's own C2PA and watermark are not OpenAI provenance, so the API
    // reports not_detected for both — the documented limit in PLAN §10 Q3,
    // observed rather than assumed.
    const result = await check("ai-meta-bunny.jpg");
    expect(result.c2pa.outcome).toBe("not_detected");
    expect(result.synthid.outcome).toBe("not_detected");
  });
});
