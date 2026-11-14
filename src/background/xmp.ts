// XMP packet scanner (PLAN §4 step 6). Container-blind: it searches the raw
// bytes for the packet markers, so JPEG (APP1), PNG (uncompressed iTXt), WebP
// and GIF all work the same way. No XMP library. Compressed PNG text chunks
// are not read (documented limitation, PLAN §3 / §9 M7).
//
// Known limits (regex scan, not an XML parser):
// - Property prefixes are read from the packet's xmlns declarations; a packet
//   that omits them is not read (real XMP declares them).
// - Prefix bindings are packet-wide, not scoped: a prefix bound to the IPTC URI
//   in one element and to another URI elsewhere is misread as IPTC.
// - The rdf: prefix on rdf:resource is assumed conventional, not resolved.
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

const IPTC_EXT_NS = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/";
const XMP_NS = "http://ns.adobe.com/xap/1.0/";

// A prefix is a local alias for a namespace URI, and the URI is what identifies
// a property: Adobe writes Iptc4xmpExt:, Exiv2 writes iptcExt:. Returns every
// prefix the packet binds to `uri`, plus "" for the default namespace, which
// applies to element names only, never to attributes.
const XMLNS_DECL = /\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(["'])(.*?)\2/g;

function prefixesFor(packet: string, uri: string): string[] {
  const prefixes = new Set<string>();
  for (const [, prefix, , declared] of packet.matchAll(XMLNS_DECL)) {
    if (declared === uri) prefixes.add(prefix ?? "");
  }
  return [...prefixes];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Every serialisation of one property: rdf:resource, element text and attribute
// value. Element text may be wrapped in CDATA; entities in either form are
// decoded before matching.
function propertyValue(packet: string, uri: string, local: string): string | undefined {
  for (const prefix of prefixesFor(packet, uri)) {
    const name = escapeRegex(prefix === "" ? local : `${prefix}:${local}`);
    const raw =
      new RegExp(`<${name}\\b[^>]*\\brdf:resource\\s*=\\s*(["'])(.*?)\\1`, "s").exec(packet)?.[2] ??
      new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "s").exec(packet)?.[1] ??
      (prefix === "" ? undefined : new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "s").exec(packet)?.[2]);
    if (raw !== undefined) return decodeXmlEntities(unwrapCdata(raw)).trim();
  }
  return undefined;
}

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

  const sourceType = propertyValue(packet, IPTC_EXT_NS, "DigitalSourceType");
  if (sourceType) {
    if (AI_SOURCE_SUFFIXES.some((suffix) => sourceType.endsWith(suffix))) {
      result.state = "detected";
    } else {
      result.digitalSourceType = sourceType;
    }
  }

  const creator = propertyValue(packet, XMP_NS, "CreatorTool");
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
