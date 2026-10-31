import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { localeParity, RULES, ruleViolations, scanRepo, type RuleId, type Violation } from "./rules";

const CASES: {
  rule: Exclude<RuleId, "locale-parity">;
  bad: { path: string; content: string }[];
  clean: { path: string; content: string }[];
}[] = [
  {
    rule: "no-reencode",
    bad: [
      {
        path: "src/content/bad.ts",
        content: 'const ctx = canvas.getContext("2d");\nconst off = new OffscreenCanvas(1, 1);\nconst url = img.toDataURL();\nimg.toBlob(() => {});\ncreateImageBitmap(img);\n',
      },
    ],
    clean: [{ path: "src/content/good.ts", content: "const bytes = new Uint8Array(0);\n" }],
  },
  {
    rule: "no-content-type",
    bad: [
      { path: "src/background/bad.ts", content: 'const headers = { "Content-Type": "image/jpeg" };\n' },
      { path: "src/background/bad2.ts", content: 'const headers = { "content-type": "image/jpeg" };\n' },
      { path: "src/background/bad3.ts", content: "const header = `Content-Type`;\n" },
    ],
    clean: [
      { path: "src/background/good.ts", content: 'const headers = { Accept: "image/jpeg" };\n' },
      { path: "src/background/good2.ts", content: "// fetch and FormData set Content-Type themselves\n" },
    ],
  },
  {
    rule: "no-image-jpg",
    bad: [
      { path: "src/background/bad.ts", content: 'const mediaType = "image/jpg";\n' },
      { path: "src/background/bad2.ts", content: "const mediaType = 'image/jpg';\n" },
      { path: "src/background/bad3.ts", content: "const mediaType = `image/jpg`;\n" },
      { path: "src/background/bad4.ts", content: 'const mediaType = "IMAGE/JPG";\n' },
    ],
    clean: [{ path: "src/background/good.ts", content: 'const mediaType = "image/jpeg";\n' }],
  },
  {
    rule: "c2pa-wasm-gated",
    bad: [
      { path: "src/background/openai.ts", content: 'import { WasmReader } from "@contentauth/c2pa-wasm";\n' },
      {
        path: "src/background/c2pa.ts",
        content: 'import { WasmReader } from "@contentauth/c2pa-wasm";\nexport function read(bytes) {\n  return WasmReader.fromBytes("image/png", bytes);\n}\n',
      },
      {
        path: "src/background/c2pa.ts",
        content: 'import { WasmReader } from "@contentauth/c2pa-wasm";\nconst remote = { verify: { remote_manifest_fetch: false } };\nconst ocsp = { verify: { ocsp_fetch: false } };\n',
      },
    ],
    clean: [
      {
        path: "src/background/c2pa.ts",
        content: 'import { WasmReader } from "@contentauth/c2pa-wasm";\nconst context = { verify: { remote_manifest_fetch: false, ocsp_fetch: false } };\n',
      },
      {
        path: "src/background/c2pa.ts",
        content: "import { WasmReader } from '@contentauth/c2pa-wasm';\nconst context = '{\"verify\":{\"remote_manifest_fetch\":false,\"ocsp_fetch\":false}}';\n",
      },
      { path: "src/background/check.ts", content: "// no c2pa here\n" },
    ],
  },
  {
    rule: "api-key-placement",
    bad: [
      { path: "src/content/index.ts", content: 'const { apiKey } = await chrome.storage.local.get("apiKey");\n' },
      { path: "src/background/check.ts", content: 'console.log("apiKey", key);\n' },
      { path: "src/shared/util.ts", content: 'export const keyName = "apiKey";\n' },
    ],
    clean: [
      { path: "src/background/openai.ts", content: 'const { apiKey } = await chrome.storage.local.get("apiKey");\n' },
      { path: "src/options/options.ts", content: "await chrome.storage.local.set({ apiKey });\n" },
      { path: "src/shared/types.ts", content: "export interface ApiKeyStorage { apiKey?: string }\n" },
    ],
  },
  {
    rule: "locale-forbidden-words",
    bad: [
      { path: "_locales/en/messages.json", content: '{"a":{"message":"This is a real photo"},"b":{"message":"a verified human"},"c":{"message":"not fake or authentic"}}' },
      { path: "_locales/fi/messages.json", content: '{"a":{"message":"aito kuva"},"b":{"message":"väärennös"}}' },
    ],
    clean: [
      { path: "_locales/en/messages.json", content: '{"a":{"message":"No AI signal found"}}' },
      { path: "src/content/index.ts", content: "const fake = 1;\n" },
    ],
  },
  {
    rule: "manifest-clean",
    bad: [
      { path: "manifest.json", content: '{"content_scripts": []}' },
      { path: "manifest.json", content: '{"externally_connectable": {}}' },
    ],
    clean: [
      { path: "manifest.json", content: '{"manifest_version": 3}' },
      { path: "src/background/bad.json", content: '{"content_scripts": []}' },
    ],
  },
];

// Each entry waives ALL violations of `rule` in `path`.
// Add an entry only together with a comment saying why the exception is safe.
const ALLOWED_EXCEPTIONS: { rule: RuleId; path: string }[] = [];

describe("hard-rule scanners", () => {
  test.each(CASES)("flags known-bad snippets: $rule", ({ rule, bad }) => {
    const check = RULES[rule];
    for (const snippet of bad) {
      const violations = check(snippet.path, snippet.content);
      expect(violations.length, `${rule} should flag ${snippet.path}`).toBeGreaterThan(0);
      expect(violations.every((v) => v.rule === rule)).toBe(true);
    }
  });

  test.each(CASES)("accepts clean snippets: $rule", ({ rule, clean }) => {
    const check = RULES[rule];
    for (const snippet of clean) {
      expect(check(snippet.path, snippet.content), `${rule} should accept ${snippet.path}`).toEqual([]);
    }
  });

  test("every rule has a known-bad and a clean snippet case", () => {
    const ruleIds = Object.keys(RULES).sort();
    const caseIds = [...new Set(CASES.map((c) => c.rule))].sort();
    expect(caseIds).toEqual(ruleIds);
  });
});

describe("locale parity", () => {
  test("flags keys missing from either locale", () => {
    const violations = localeParity(
      "_locales/en/messages.json",
      '{"a":{"message":"1"},"b":{"message":"2"}}',
      "_locales/fi/messages.json",
      '{"a":{"message":"1"}}',
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.rule === "locale-parity")).toBe(true);
  });

  test("reports invalid JSON", () => {
    expect(localeParity("_locales/en/messages.json", "not json", "_locales/fi/messages.json", "{}").length).toBeGreaterThan(0);
  });

  test("accepts locales with identical keys", () => {
    expect(
      localeParity("_locales/en/messages.json", '{"a":{"message":"1"}}', "_locales/fi/messages.json", '{"a":{"message":"yksi"}}'),
    ).toEqual([]);
  });
});

describe("repository scan", () => {
  test("picks up source files whatever compilable extension they use", () => {
    // Create a source file with an extension outside the obvious .ts/.js set
    // and prove the scanner reaches it.
    const probe = join("src", "rules-scan-probe.mts");
    writeFileSync(probe, "// probe\n");
    try {
      expect(scanRepo().map((f) => f.path)).toContain("src/rules-scan-probe.mts");
    } finally {
      rmSync(probe);
    }
  });

  test("reaches every scaffolded area", () => {
    const paths = scanRepo().map((f) => f.path);
    for (const expected of [
      "manifest.json",
      "_locales/en/messages.json",
      "_locales/fi/messages.json",
      "src/background/index.ts",
      "src/content/index.ts",
      "src/shared/types.ts",
      "src/shared/i18n.ts",
      "src/options/options.ts",
      "src/options/options.html",
      "src/confirm/confirm.ts",
      "src/confirm/confirm.html",
    ]) {
      expect(paths, `scanner must find ${expected}`).toContain(expected);
    }
  });

  test("has no violations outside the allowed exceptions", () => {
    const files = scanRepo();
    const contentOf = (path: string): string => {
      const file = files.find((f) => f.path === path);
      if (!file) throw new Error(`scanner found no ${path}`);
      return file.content;
    };
    const violations: Violation[] = [
      ...ruleViolations(files),
      ...localeParity(
        "_locales/en/messages.json",
        contentOf("_locales/en/messages.json"),
        "_locales/fi/messages.json",
        contentOf("_locales/fi/messages.json"),
      ),
    ];
    const unexpected = violations.filter(
      (v) => !ALLOWED_EXCEPTIONS.some((e) => e.rule === v.rule && e.path === v.path),
    );
    expect(
      unexpected.map((v) => `${v.rule} ${v.path}${v.line ? `:${v.line}` : ""} — ${v.detail}`),
    ).toEqual([]);
  });
});
