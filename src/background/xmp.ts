// XMP packet scanner (PLAN §4 step 6). Container-blind: it searches the raw
// bytes for the packet markers, so JPEG (APP1), PNG (uncompressed iTXt), WebP
// and GIF all work the same way. No XMP library. Compressed PNG text chunks
// are not read (documented limitation, PLAN §3 / §9 M7).
//
// Known limits (regex scan, not an XML parser):
// - Only the conventional prefixes Iptc4xmpExt: and xmp: are recognised.
// - UTF-16 packets are not decoded (reported as not_detected).
// - The attribute form can match the same text inside another property's value.
// - A "</x:xmpmeta>" inside a comment ends the packet early.

import type { CheckResult } from "../shared/types";

export type LocalXmp = CheckResult["localXmp"];

// One list of generator names. A CreatorTool match is a weak hint and never by
// itself an AI signal (PLAN §4 "Not an AI signal").
const GENERATOR_NAMES = ["ChatGPT", "DALL-E", "Midjourney", "Stable Diffusion", "Firefly", "gpt-image"];

// Same suffix rule as the C2PA mapping (PLAN §4 "Result model").
const AI_SOURCE_SUFFIXES = ["trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia"];

const START = new TextEncoder().encode("<x:xmpmeta");
const END = new TextEncoder().encode("</x:xmpmeta>");

// Attribute and element forms of the two properties. Element values may carry
// an rdf:resource attribute instead of text, and their text may be wrapped in
// CDATA; entities in either form are decoded before matching.
const DIGITAL_SOURCE_RESOURCE = /<Iptc4xmpExt:DigitalSourceType\b[^>]*\brdf:resource\s*=\s*(["'])(.*?)\1/s;
const DIGITAL_SOURCE_ELEM = /<Iptc4xmpExt:DigitalSourceType\b[^>]*>([\s\S]*?)<\/Iptc4xmpExt:DigitalSourceType>/s;
const DIGITAL_SOURCE_ATTR = /\bIptc4xmpExt:DigitalSourceType\s*=\s*(["'])(.*?)\1/s;
const CREATOR_RESOURCE = /<xmp:CreatorTool\b[^>]*\brdf:resource\s*=\s*(["'])(.*?)\1/s;
const CREATOR_ELEM = /<xmp:CreatorTool\b[^>]*>([\s\S]*?)<\/xmp:CreatorTool>/s;
const CREATOR_ATTR = /\bxmp:CreatorTool\s*=\s*(["'])(.*?)\1/s;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// XML character/entity references are equivalent to their characters: a value
// spelled with &#116; or &#x74; must match one spelled with "t".
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, ref: string) => {
    let code: number;
    if (ref[0] === "#") {
      code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    } else {
      return NAMED_ENTITIES[ref] ?? match;
    }
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

// <![CDATA[...]]> is text, not markup: drop the markers and keep the content.
function unwrapCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function propertyValue(packet: string, resource: RegExp, element: RegExp, attribute: RegExp): string | undefined {
  const value = resource.exec(packet)?.[2] ?? element.exec(packet)?.[1] ?? attribute.exec(packet)?.[2];
  return value === undefined ? undefined : decodeXmlEntities(unwrapCdata(value)).trim();
}

// Comments are not data: a commented-out property must not count. Strip them
// once, before any property is read.
function stripComments(packet: string): string {
  return packet.replace(/<!--[\s\S]*?-->/g, "");
}

export function scanXmp(bytes: Uint8Array): LocalXmp {
  const start = indexOfBytes(bytes, START);
  if (start === -1) return { state: "not_detected" };
  const end = indexOfBytes(bytes, END, start + START.length);
  // A start tag with no end tag is a malformed packet, not a missing one.
  if (end === -1) return { state: "error" };

  const packet = stripComments(new TextDecoder("utf-8").decode(bytes.subarray(start, end + END.length)));
  const result: LocalXmp = { state: "not_detected" };

  const sourceType = propertyValue(packet, DIGITAL_SOURCE_RESOURCE, DIGITAL_SOURCE_ELEM, DIGITAL_SOURCE_ATTR);
  if (sourceType) {
    if (AI_SOURCE_SUFFIXES.some((suffix) => sourceType.endsWith(suffix))) {
      result.state = "detected";
    } else {
      result.digitalSourceType = sourceType;
    }
  }

  const creator = propertyValue(packet, CREATOR_RESOURCE, CREATOR_ELEM, CREATOR_ATTR);
  if (creator !== undefined && GENERATOR_NAMES.some((name) => creator.toLowerCase().includes(name.toLowerCase()))) {
    result.generatorHint = creator;
  }

  return result;
}

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
