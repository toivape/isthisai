// Image byte collection (PLAN §4 step 3): download with one 25 s deadline,
// stream-cap at 50 MiB, never re-encode (hard rule 2), only fetch the chosen
// image (hard rule 7). blob: URLs are read by the content script (only the
// page can read them) and arrive base64-encoded.

import { sniffMediaType } from "./sniff";
import { decodeBase64, encodeBase64 } from "../shared/base64";
import { FETCH_DEADLINE_MS, MAX_BLOB_BYTES, MAX_IMAGE_BYTES } from "../shared/limits";
import type { CheckError, ReadBlobReply } from "../shared/types";

// Brave's <img> request Accept value; the owner copies the exact string from
// DevTools into the PR that wires this into the worker.
export const IMAGE_ACCEPT = "image/avif,image/jxl,image/png,image/webp,image/*;q=0.8,*/*;q=0.5";

export type ImageBytes = { kind: "bytes"; bytes: Uint8Array; mediaType: string } | { kind: "error"; error: CheckError };

const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** data: URL decoder; only base64 payloads of image/* types are supported. */
export function decodeDataUrl(url: string, maxBytes: number = MAX_IMAGE_BYTES): ImageBytes {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) {
    return { kind: "error", error: { code: "unsupported_type" } };
  }
  const [meta] = url.slice(5, comma).split(";");
  if (!meta.startsWith("image/")) return { kind: "error", error: { code: "unsupported_type" } };
  if (!url.slice(5, comma).includes(";base64")) {
    return { kind: "error", error: { code: "unsupported_type" } };
  }
  try {
    const bytes = decodeBase64(url.slice(comma + 1));
    if (bytes.length > maxBytes) return { kind: "error", error: { code: "too_large" } };
    return { kind: "bytes", bytes, mediaType: meta };
  } catch {
    return { kind: "error", error: { code: "unsupported_type" } };
  }
}

export interface FetchImageOptions {
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
}

export async function fetchImageBytes(url: string, options: FetchImageOptions = {}): Promise<ImageBytes> {
  const doFetch = options.fetchImpl ?? fetch;
  const deadline = options.deadlineMs ?? FETCH_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        credentials: "omit",
        headers: { Accept: IMAGE_ACCEPT },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) return { kind: "error", error: { code: "timeout" } };
      return { kind: "error", error: { code: "fetch_failed" } };
    }
    if (!response.ok) return { kind: "error", error: { code: "fetch_failed" } };
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) return { kind: "error", error: { code: "too_large" } };
      return { kind: "bytes", bytes, mediaType: "" };
    }
    // Streamed read: stop as soon as the cap is exceeded; do not download
    // everything and only then check (PLAN §4 step 3).
    const parts: Uint8Array[] = [];
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_IMAGE_BYTES) {
          return { kind: "error", error: { code: "too_large" } };
        }
        parts.push(value);
      }
    } finally {
      // Release the connection on every exit path: too_large, abort (the read
      // above rejects with AbortError), or a broken stream.
      reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(received);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    return { kind: "bytes", bytes, mediaType: "" };
  } catch (error) {
    if (isAbortError(error)) return { kind: "error", error: { code: "timeout" } };
    return { kind: "error", error: { code: "fetch_failed" } };
  } finally {
    clearTimeout(timer);
  }
}

/** Decodes a content-script blob reply; the payload cap keeps messages under 64 MiB. */
export function decodeBase64WithLimit(base64: string, maxBytes: number): ImageBytes | { kind: "error"; error: CheckError } {
  const byteLength = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (byteLength > maxBytes) return { kind: "error", error: { code: "too_large" } };
  try {
    return { kind: "bytes", bytes: decodeBase64(base64), mediaType: "" };
  } catch {
    return { kind: "error", error: { code: "fetch_failed" } };
  }
}

export type CollectedImage =
  | { kind: "image"; bytes: Uint8Array; mediaType: string; size: number; imageHash: string }
  | { kind: "error"; error: CheckError };

export interface CollectImageDeps {
  fetchImpl?: typeof fetch;
  /** Reads a blob: URL in the page context; replies base64. */
  readBlob: (url: string) => Promise<ReadBlobReply>;
}

export async function collectImage(url: string, deps: CollectImageDeps): Promise<CollectedImage> {
  let bytes: ImageBytes;
  if (url.startsWith("data:")) {
    bytes = decodeDataUrl(url);
  } else if (url.startsWith("blob:")) {
    const reply = await deps.readBlob(url).catch(() => ({ ok: false }) as ReadBlobReply);
    if (!reply.ok) return { kind: "error", error: { code: "fetch_failed" } };
    bytes = decodeBase64WithLimit(reply.base64, MAX_BLOB_BYTES);
  } else {
    bytes = await fetchImageBytes(url, { fetchImpl: deps.fetchImpl });
  }
  if (bytes.kind === "error") return { kind: "error", error: bytes.error };
  const mediaType = sniffMediaType(bytes.bytes);
  if (mediaType === "unknown") return { kind: "error", error: { code: "unsupported_type" } };
  const imageHash = await sha256Hex(bytes.bytes);
  return { kind: "image", bytes: bytes.bytes, mediaType, size: bytes.bytes.length, imageHash };
}

export { encodeBase64 };
