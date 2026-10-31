import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, sep } from "node:path";

export type PerFileRuleId =
  | "no-reencode"
  | "no-content-type"
  | "no-image-jpg"
  | "c2pa-wasm-gated"
  | "api-key-placement"
  | "locale-forbidden-words"
  | "manifest-clean";

export type RuleId = PerFileRuleId | "locale-parity";

export interface Violation {
  rule: RuleId;
  path: string;
  line: number; // 0 = file-level
  detail: string;
}

export type Rule = (path: string, content: string) => Violation[];

export interface RepoFile {
  path: string;
  content: string;
}

// Text files only: binary assets (wasm, png) cannot trip the rules meaningfully.
// Covers every extension Vite can compile (resolve.extensions) plus assets:
// a source file using a rarer extension (.mts, .cjs, .tsx) must not dodge the rules.
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
  ".json", ".html", ".css", ".svg",
]);

const SCAN_DIRS = ["src", "_locales"];
const SCAN_FILES = ["manifest.json"];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

export function scanRepo(): RepoFile[] {
  const paths = [
    ...SCAN_DIRS.flatMap((dir) => (existsSync(dir) ? walk(dir) : [])),
    ...SCAN_FILES,
  ].filter((p) => TEXT_EXTENSIONS.has(extname(p).toLowerCase()));
  return paths
    .map((p) => ({ path: p.split(sep).join("/"), content: readFileSync(p, "utf8") }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const violation = (rule: RuleId, path: string, line: number, detail: string): Violation => ({
  rule,
  path,
  line,
  detail,
});

function matches(
  path: string,
  content: string,
  rule: PerFileRuleId,
  regex: RegExp,
  detail: string,
): Violation[] {
  return content
    .split("\n")
    .flatMap((text, index) =>
      regex.test(text) ? [violation(rule, path, index + 1, detail)] : [],
    );
}

// Never re-encode the image before analysis or upload (canvas destroys both
// metadata and watermark). createImageBitmap alone does not re-encode, but it
// opens the door to it; keep the rule simple.
const noReencode: Rule = (path, content) =>
  matches(path, content, "no-reencode", /\b(canvas|OffscreenCanvas|toDataURL|toBlob|createImageBitmap)\b/, "re-encoding API forbidden");

// The OpenAI multipart request must let fetch + FormData set Content-Type.
// Header names are case-insensitive in fetch, so match any casing, inside
// any quote style including template literals. Prose in comments has no
// quotes around the name and stays allowed.
const noContentType: Rule = (path, content) =>
  matches(path, content, "no-content-type", /(["'`])content-type\1/i, "hand-set Content-Type header forbidden");

// The JPEG media type is image/jpeg, never image/jpg. Media types are
// case-insensitive and any quote style counts.
const noImageJpg: Rule = (path, content) =>
  matches(path, content, "no-image-jpg", /(["'`])image\/jpg\1/i, "use image/jpeg, not image/jpg");

// c2pa-wasm is allowed only in src/background/c2pa.ts, and every
// WasmReader.fromBytes call there must pass a verify context with both
// remote fetches disabled: a crafted image could otherwise make the wasm
// fetch an attacker's URL (hard rule 7). Flags in an unused value, outside
// verify, or a missing third argument are all treated as ungated.
const c2paImportPattern = /@contentauth\/c2pa-wasm/;
const callPattern = /\.fromBytes\s*\(([^)]*)\)/g;
const gatedLiteral = /verify:\s*\{\s*remote_manifest_fetch:\s*false\s*,\s*ocsp_fetch:\s*false\s*\}|verify:\s*\{\s*ocsp_fetch:\s*false\s*,\s*remote_manifest_fetch:\s*false\s*\}/;
// collapseQuotes mirrors the scanner's collapse for JSON-string contexts:
// '{"verify":{"remote_manifest_fetch":false,"ocsp_fetch":false}}'
const collapseQuotes = (text: string): string => text.replace(/['"`\s]/g, "");
const contextVariablePattern = (name: string): RegExp => new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([^;]+);`);
const c2paWasmGated: Rule = (path, content) => {
  if (!c2paImportPattern.test(content)) return [];
  if (path !== "src/background/c2pa.ts") {
    return [violation("c2pa-wasm-gated", path, 0, "c2pa-wasm imported outside src/background/c2pa.ts")];
  }
  return [...content.matchAll(callPattern)].flatMap((call) => {
    const args = call[1];
    const gated =
      gatedLiteral.test(args) ||
      collapseQuotes(args).includes("verify:{remote_manifest_fetch:false,ocsp_fetch:false") ||
      collapseQuotes(args).includes("verify:{ocsp_fetch:false,remote_manifest_fetch:false");
    if (gated) return [];
    // The context may also be a variable: check its declaration.
    const varMatch = args.match(/,\s*([A-Za-z_$][\w$]*)\s*\)?$/);
    if (varMatch) {
      const decl = content.match(contextVariablePattern(varMatch[1]));
      if (decl && (gatedLiteral.test(decl[1]) || collapseQuotes(decl[1]).includes("verify:{remote_manifest_fetch:false,ocsp_fetch:false") || collapseQuotes(decl[1]).includes("verify:{ocsp_fetch:false,remote_manifest_fetch:false"))) {
        return [];
      }
    }
    return [violation("c2pa-wasm-gated", path, 0, "WasmReader.fromBytes without remote_manifest_fetch:false and ocsp_fetch:false under verify")];
  });
};

// The API key may be named only where it is written or stored, never read
// or logged. src/shared/types.ts declares its storage shape; the content
// script and confirm page must never touch it.
const apiKeyPlacement: Rule = (path, content) => {
  const allowed =
    path.startsWith("src/background/") ||
    path.startsWith("src/options/") ||
    path === "src/shared/types.ts";
  return content
    .split("\n")
    .flatMap((text, index) => {
      if (!/\bapiKey\b/.test(text)) return [];
      if (/console\./.test(text)) {
        return [violation("api-key-placement", path, index + 1, "apiKey on a console line")];
      }
      return allowed
        ? []
        : [violation("api-key-placement", path, index + 1, "apiKey outside the worker, options page and shared types")];
    });
};

// Result wording must never claim the image is human-made or forged.
// Whole words only: "aito" must not match inside "aitoaika" etc.
const localeForbiddenWords: Rule = (path, content) => {
  if (!path.startsWith("_locales/")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [violation("locale-forbidden-words", path, 0, "invalid JSON in messages file")];
  }
  if (!isObject(parsed)) return [];
  const forbidden: [RegExp, string][] = [
    [/\breal\b/i, "real"],
    [/\bfake\b/i, "fake"],
    [/\bauthentic\b/i, "authentic"],
    [/\bverified\s+human\b/i, "verified human"],
    [/\baito\b/i, "aito"],
    [/\bväärennös\b/i, "väärennös"],
    [/\bväärennetty\b/i, "väärennetty"],
  ];
  const violations: Violation[] = [];
  walkMessages(parsed, (key, text) => {
    for (const [regex, word] of forbidden) {
      if (regex.test(text)) {
        violations.push(violation("locale-forbidden-words", path, 0, `forbidden word "${word}" in ${key}`));
      }
    }
  });
  return violations;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkMessages(
  node: unknown,
  visit: (key: string, text: string) => void,
  prefix: string[] = [],
): void {
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (isObject(value) && typeof value.message === "string") {
      visit([...prefix, key].join("."), value.message);
    } else {
      walkMessages(value, visit, [...prefix, key]);
    }
  }
}

// The manifest must not auto-inject or expose the extension to web pages.
const manifestClean: Rule = (path, content) => {
  if (path !== "manifest.json") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [violation("manifest-clean", path, 0, "manifest.json is not valid JSON")];
  }
  if (!isObject(parsed)) return [];
  const violations: Violation[] = [];
  if (parsed.content_scripts !== undefined) {
    violations.push(violation("manifest-clean", path, 0, "content_scripts in manifest"));
  }
  if (parsed.externally_connectable !== undefined) {
    violations.push(violation("manifest-clean", path, 0, "externally_connectable in manifest"));
  }
  return violations;
};

export const RULES: Record<PerFileRuleId, Rule> = {
  "no-reencode": noReencode,
  "no-content-type": noContentType,
  "no-image-jpg": noImageJpg,
  "c2pa-wasm-gated": c2paWasmGated,
  "api-key-placement": apiKeyPlacement,
  "locale-forbidden-words": localeForbiddenWords,
  "manifest-clean": manifestClean,
};

export function ruleViolations(files: RepoFile[]): Violation[] {
  return files.flatMap((file) =>
    (Object.values(RULES) as Rule[]).flatMap((check) => check(file.path, file.content)),
  );
}

export function localeParity(
  enPath: string,
  enContent: string,
  fiPath: string,
  fiContent: string,
): Violation[] {
  const keysOf = (path: string, content: string): { keys: Set<string> | null; error?: string } => {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isObject(parsed)) return { keys: null, error: "not an object" };
      return { keys: new Set(Object.keys(parsed)) };
    } catch {
      return { keys: null, error: "invalid JSON" };
    }
  };
  const en = keysOf(enPath, enContent);
  const fi = keysOf(fiPath, fiContent);
  if (!en.keys) return [violation("locale-parity", enPath, 0, en.error ?? "unreadable")];
  if (!fi.keys) return [violation("locale-parity", fiPath, 0, fi.error ?? "unreadable")];
  const violations: Violation[] = [];
  for (const key of en.keys) {
    if (!fi.keys.has(key)) {
      violations.push(violation("locale-parity", fiPath, 0, `key "${key}" missing from fi locale`));
    }
  }
  for (const key of fi.keys) {
    if (!en.keys.has(key)) {
      violations.push(violation("locale-parity", enPath, 0, `key "${key}" missing from en locale`));
    }
  }
  return violations;
}
