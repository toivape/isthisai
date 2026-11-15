// blob: URLs can only be read by the page that created them, so the worker
// asks the content script to fetch the bytes (the only network-adjacent call
// the content script ever makes, and it stays same-origin). A data: URL whose
// payload the cache stripped is read the same way: the page still holds the
// image, and the worker's hash check rejects a wrong match. The reply travels
// base64-encoded: extension messages are JSON-only (PLAN §3).

import { encodeBase64 } from "../shared/base64";
import { MAX_BLOB_BYTES } from "../shared/limits";
import type { ReadBlobReply } from "../shared/types";
import { dataUrlToRead } from "./findImages";

// The stored data: URL is payload-free. The page resolves it to the exact URL
// the check saw, or to the image whose source carries the prefix.
function dataUrlSource(prefix: string, knownSource: string | undefined): string | undefined {
  return dataUrlToRead(prefix, knownSource);
}

export async function readBlobInPage(url: string, knownSource?: string): Promise<ReadBlobReply> {
  const target = url.startsWith("data:") ? dataUrlSource(url, knownSource) : url;
  if (target === undefined || target === "") return { ok: false };
  let response: Response;
  try {
    response = await fetch(target);
  } catch {
    return { ok: false }; // revoked or unreadable blob URL
  }
  if (!response.ok) return { ok: false };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BLOB_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, base64: encodeBase64(bytes) };
}
