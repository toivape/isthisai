// Worker-side handlers for the options page (issue #10). They live here rather
// than in the worker entry so the logic stays unit-testable and mutation-checked;
// index.ts only wires chrome.storage and the runtime messages to them.
//
// The key is read here and never returned (hard rule 3): keyStatus replies with a
// boolean, and testKey puts the key in one Authorization header and nowhere else.

import { buildRequest, sendProvenanceUpload, type SendProvenanceDeps } from "./openai";
import { isOpenAiType, sniffMediaType } from "./sniff";
import type { KeyStatusReply, TestKeyReply } from "../shared/types";

export interface ApiKeySource {
  readKey(): Promise<string | undefined>;
}

// Only the extension's own options page may ask about or spend the key. The URL
// is the discriminator, not the presence of a tab: an injected content script
// reports the *page's* URL, which can never be chrome-extension://<ours>/…, while
// the options page reports its own URL even when Chrome hosts it in a tab (the
// embedded options_ui case). Requiring "no tab" would therefore reject the real
// options page — Chrome's MessageSender docs say tab is set for any connection
// opened from a tab.
export function isOptionsPageSender(sender: { url?: string | undefined }, optionsUrlPrefix: string): boolean {
  return typeof sender.url === "string" && sender.url.startsWith(optionsUrlPrefix);
}

export async function keyStatus(source: ApiKeySource): Promise<KeyStatusReply> {
  const key = await source.readKey();
  return { hasKey: typeof key === "string" && key !== "" };
}

export interface TestKeyDeps extends ApiKeySource, SendProvenanceDeps {
  loadSample(): Promise<Uint8Array>;
}

// Uploads the bundled sample so the user can find out whether their key works
// without spending a check on their own image. Clicking the button is the
// confirmation (PLAN §6); the sample carries no provenance, so the result says
// nothing about any real image.
export async function testKey(deps: TestKeyDeps): Promise<TestKeyReply> {
  const key = await deps.readKey();
  if (key === undefined || key === "") return { ok: false, error: { code: "no_key" } };

  const bytes = await deps.loadSample();
  // Sniffed, not assumed: hard rule 4 decides the media type from magic bytes.
  // AVIF and HEIC sniff fine but OpenAI will not accept them, and this path has
  // no server conversion, so they are refused rather than sent to fail as a 400.
  const mediaType = sniffMediaType(bytes);
  if (!isOpenAiType(mediaType)) return { ok: false, error: { code: "unsupported_type" } };

  const built = buildRequest(key, bytes, mediaType);
  if (!built.ok) return { ok: false, error: built.error };

  const parsed = await sendProvenanceUpload(built.request, { fetchImpl: deps.fetchImpl, deadlineMs: deps.deadlineMs });
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
}
