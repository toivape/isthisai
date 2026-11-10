// Chunked base64 for JSON messages: an ArrayBuffer in an extension message
// would be silently dropped (messages are JSON-serialised), so blob payloads
// travel as base64 (PLAN §3).

const CHUNK = 0x8000; // 32 KiB per String.fromCharCode.apply call

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text); // throws on invalid input
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
