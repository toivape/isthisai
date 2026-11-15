// blob: URLs can only be read by the page that created them, so the worker
// asks the content script to fetch the bytes (the only network-adjacent call
// the content script ever makes, and it stays same-origin). A data: URL whose
// payload the cache stripped is read the same way: the page still holds the
// image, and the worker's hash check rejects a wrong match. The reply travels
// base64-encoded: extension messages are JSON-only (PLAN §3).

import { encodeBase64 } from "../shared/base64";
import { MAX_BLOB_BYTES } from "../shared/limits";
import type { ReadBlobReply } from "../shared/types";
import { findImagesByPrefix } from "./findImages";

// The stored data: URL is payload-free, so the page's own image is found by
// prefix and its full URL is what gets fetched.
function dataUrlSource(prefix: string): string | undefined {
  const [img] = findImagesByPrefix(prefix);
  if (img === undefined) return undefined;
  return img.currentSrc === "" ? img.src : img.currentSrc;
}

export async function readBlobInPage(url: string): Promise<ReadBlobReply> {
  const target = url.startsWith("data:") ? dataUrlSource(url) : url;
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
