// XMP packet scanner (PLAN §4 step 6). Container-blind: it searches the raw
// bytes for the packet markers, so JPEG (APP1), PNG (uncompressed iTXt), WebP
// and GIF all work the same way. No XMP library. Compressed PNG text chunks
// are not read (documented limitation, PLAN §3 / §9 M7).

import type { CheckResult } from "../shared/types";

export type LocalXmp = CheckResult["localXmp"];

// One list of generator names. A CreatorTool match is a weak hint and never by
// itself an AI signal (PLAN §4 "Not an AI signal").
const GENERATOR_NAMES = ["ChatGPT", "DALL-E", "Midjourney", "Stable Diffusion", "Firefly", "gpt-image"];

// Same suffix rule as the C2PA mapping (PLAN §4 "Result model").
const AI_SOURCE_SUFFIXES = ["trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia"];

const START = new TextEncoder().encode("<x:xmpmeta");
const END = new TextEncoder().encode("</x:xmpmeta>");

// Attribute and element forms of the two properties. The leading/trailing
// shape differs enough that each form only matches its own syntax.
const DIGITAL_SOURCE_ATTR = /Iptc4xmpExt:DigitalSourceType\s*=\s*(["'])(.*?)\1/s;
const DIGITAL_SOURCE_ELEM = /<Iptc4xmpExt:DigitalSourceType[^>]*>([^<]*)<\/Iptc4xmpExt:DigitalSourceType>/s;
const CREATOR_ATTR = /xmp:CreatorTool\s*=\s*(["'])(.*?)\1/s;
const CREATOR_ELEM = /<xmp:CreatorTool[^>]*>([^<]*)<\/xmp:CreatorTool>/s;

// Byte search so a large image (up to 50 MiB) is never turned into one giant
// string; only the small packet itself is decoded.
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const last = haystack.length - needle.length;
  outer: for (let at = Math.max(from, 0); at <= last; at++) {
    for (let i = 0; i < needle.length; i++) {
      if (haystack[at + i] !== needle[i]) continue outer;
    }
    return at;
  }
  return -1;
}

export function scanXmp(bytes: Uint8Array): LocalXmp {
  const start = indexOfBytes(bytes, START);
  if (start === -1) return { state: "not_detected" };
  const end = indexOfBytes(bytes, END, start + START.length);
  // A start tag with no end tag is a malformed packet, not a missing one.
  if (end === -1) return { state: "error" };

  const packet = new TextDecoder("utf-8").decode(bytes.subarray(start, end + END.length));
  const result: LocalXmp = { state: "not_detected" };

  const sourceType = DIGITAL_SOURCE_ATTR.exec(packet)?.[2] ?? DIGITAL_SOURCE_ELEM.exec(packet)?.[1];
  if (sourceType !== undefined) {
    const value = sourceType.trim();
    if (AI_SOURCE_SUFFIXES.some((suffix) => value.endsWith(suffix))) {
      result.state = "detected";
    } else {
      result.digitalSourceType = value;
    }
  }

  const creator = CREATOR_ATTR.exec(packet)?.[2] ?? CREATOR_ELEM.exec(packet)?.[1];
  if (creator !== undefined && GENERATOR_NAMES.some((name) => creator.toLowerCase().includes(name.toLowerCase()))) {
    result.generatorHint = creator.trim();
  }

  return result;
}
