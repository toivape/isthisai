// Image byte collection (PLAN §4 step 3): download with one 25 s deadline,
// stream-cap at 50 MiB, never re-encode (hard rule 2), only fetch the chosen
// image (hard rule 7). blob: URLs are read by the content script (only the
// page can read them) and arrive base64-encoded.

import { sniffMediaType } from "./sniff";
import { decodeBase64, encodeBase64 } from "../shared/base64";
import { FETCH_DEADLINE_MS, MAX_BLOB_BYTES, MAX_IMAGE_BYTES } from "../shared/limits";
import type { CheckError, ReadBlob, ReadBlobReply } from "../shared/types";

// Brave's <img> request Accept value, copied from DevTools (Network, Img).
export const IMAGE_ACCEPT = "image/jxl,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

export type ImageBytes = { kind: "bytes"; bytes: Uint8Array; mediaType: string } | { kind: "error"; error: CheckError };

const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Serialized URLs are ASCII; a non-ASCII char means a malformed payload.
function percentDecode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  let length = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code > 0x7f) throw new Error("non-ASCII data URL payload");
    const hex = code === 0x25 ? text.slice(at + 1, at + 3) : "";
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out[length++] = parseInt(hex, 16);
      at += 2;
    } else {
      out[length++] = code;
    }
  }
  return out.subarray(0, length);
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return binary;
}

/** data: URL decoder for image/* payloads, base64 or percent-encoded. */
export function decodeDataUrl(url: string, maxBytes: number = MAX_IMAGE_BYTES): ImageBytes {
  const unsupported: ImageBytes = { kind: "error", error: { code: "unsupported_type" } };
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) return unsupported;
  const [meta, ...params] = url.slice(5, comma).split(";");
  if (!meta.toLowerCase().startsWith("image/")) return unsupported;
  const isBase64 = params.some((param) => param.trim().toLowerCase() === "base64");
  const payload = url.slice(comma + 1);
  // Cheap rejection before decoding, using a lower bound on the decoded size
  // (every byte takes at most 3 chars as %XX, every base64 byte at least 4/3
  // chars, and escaped base64 chars take 3 each; -2 allows for base64 padding).
  // The exact check follows decoding.
  if (payload.length / (isBase64 ? 4 : 3) - 2 > maxBytes) {
    return { kind: "error", error: { code: "too_large" } };
  }
  try {
    const raw = percentDecode(payload);
    const bytes = isBase64 ? decodeBase64(bytesToBinaryString(raw)) : raw;
    if (bytes.length > maxBytes) return { kind: "error", error: { code: "too_large" } };
    return { kind: "bytes", bytes, mediaType: meta };
  } catch {
    return unsupported;
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

export function readBlobRequest(checkId: string, url: string): ReadBlob {
  return { type: "readBlob", checkId, url };
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
    const reply = await deps.readBlob(url).catch((): ReadBlobReply => ({ ok: false }));
    if (!reply.ok) return { kind: "error", error: { code: reply.reason === "too_large" ? "too_large" : "fetch_failed" } };
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
