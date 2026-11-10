// blob: URLs can only be read by the page that created them, so the worker
// asks the content script to fetch the bytes (the only network-adjacent call
// the content script ever makes, and it stays same-origin). The reply travels
// base64-encoded: extension messages are JSON-only (PLAN §3).

import { encodeBase64 } from "../shared/base64";
import { MAX_BLOB_BYTES } from "../shared/limits";
import type { ReadBlobReply } from "../shared/types";

export async function readBlobInPage(url: string): Promise<ReadBlobReply> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return { ok: false }; // revoked or unreadable blob URL
  }
  if (!response.ok) return { ok: false };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BLOB_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, base64: encodeBase64(bytes) };
}
