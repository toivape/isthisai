// Container builders for the c2pa tests (PLAN §8: small inputs are built in
// code, not committed as files). Byte layouts verified against c2pa-wasm 0.13.4.
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([new TextEncoder().encode(type), data]);
  const crc = crc32(body);
  const len = data.length;
  return new Uint8Array([
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...body,
    (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff,
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 1x1 RGB PNG: IHDR + IDAT (filter 0, RGB) + IEND.
// IHDR is 13 bytes: width(4), height(4), bitDepth, colorType, compression,
// filter, interlace. A 9-byte payload is invalid (parsers reject the file).
function minimalPng(): Uint8Array {
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = new Uint8Array(deflateSync(new Uint8Array([0, 0xff, 0x00, 0x00])));
  return concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

export { minimalPng };

function le32(value: number): Uint8Array {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

// ---- XMP container builders (PLAN §8: inputs are built in code). One packet,
// four containers, to prove the scanner is container-blind. Byte layouts are
// the standard XMP carriers; the scanner only looks at the raw bytes.

const XMP_NAMESPACE = "http://ns.adobe.com/xap/1.0/";

// JPEG: SOI, one APP1 segment (namespace NUL packet), EOI.
export function jpegWithXmpPacket(packet: string): Uint8Array {
  const body = concat([new TextEncoder().encode(XMP_NAMESPACE), new Uint8Array([0]), new TextEncoder().encode(packet)]);
  const length = body.length + 2; // the length field counts itself
  return concat([
    Uint8Array.from([0xff, 0xd8]),
    Uint8Array.from([0xff, 0xe1, (length >>> 8) & 0xff, length & 0xff]),
    body,
    Uint8Array.from([0xff, 0xd9]),
  ]);
}

// PNG: uncompressed iTXt chunk (keyword "XML:com.adobe.xmp").
export function pngWithXmpPacket(packet: string): Uint8Array {
  const head = new TextEncoder().encode("XML:com.adobe.xmp\0\0\0\0\0");
  return concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk("iTXt", concat([head, new TextEncoder().encode(packet)])),
    pngChunk("IDAT", new Uint8Array(deflateSync(new Uint8Array([0, 0xff, 0x00, 0x00])))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// WebP: RIFF/WEBP with an "XMP " chunk (padded to even length per RIFF).
export function webpWithXmpPacket(packet: string): Uint8Array {
  const data = new TextEncoder().encode(packet);
  const pad = data.length % 2 === 1 ? new Uint8Array([0]) : new Uint8Array(0);
  const chunk = concat([new TextEncoder().encode("XMP "), le32(data.length), data, pad]);
  const riffSize = 4 + chunk.length;
  return concat([new TextEncoder().encode("RIFF"), le32(riffSize), new TextEncoder().encode("WEBP"), chunk]);
}

// GIF: application extension 0x21 0xFF, block size 0x0B, "XMP DataXMP", the
// packet, the Adobe magic trailer (0x01 then descending 0xFF..0x00) and the
// 0x00 terminator. The packet sits contiguously after the 11-byte app id; the
// magic trailer is required — exiftool rejects a GIF that lacks it.
export function gifWithXmpPacket(packet: string): Uint8Array {
  const header = Uint8Array.from([0x21, 0xff, 0x0b, ...new TextEncoder().encode("XMP DataXMP")]);
  const trailer = Uint8Array.from([0x01, ...Array.from({ length: 256 }, (_, i) => 255 - i)]);
  return concat([
    new TextEncoder().encode("GIF89a"),
    Uint8Array.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
    header,
    new TextEncoder().encode(packet),
    trailer,
    Uint8Array.from([0x00, 0x3b]),
  ]);
}

// PNG with an XMP packet in an iTXt chunk; used to point dcterms:provenance
// at a remote manifest URL.
export function pngWithXmpProvenance(url: string): Uint8Array {
  const xmp =
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"` +
    `><rdf:Description rdf:about="" xmlns:dcterms="http://purl.org/dc/terms/" dcterms:provenance="${url}"/>` +
    `</rdf:RDF></x:xmpmeta>`;
  // iTXt: keyword NUL compressionFlag compressionMethod languageTag NUL translatedTag NUL text
  const head = new TextEncoder().encode("XML:com.adobe.xmp\0\0\0\0\0");
  return concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk("iTXt", concat([head, new TextEncoder().encode(xmp)])),
    pngChunk("IDAT", new Uint8Array(deflateSync(new Uint8Array([0, 0xff, 0x00, 0x00])))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// Canonical 35-byte 1x1 GIF89a.
export function minimalGif(): Uint8Array {
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
  ]);
}

// Minimal RIFF/WEBP with a VP8L chunk.
export function minimalWebp(): Uint8Array {
  const vp8l = Uint8Array.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const chunk = concat([new TextEncoder().encode("VP8L"), Uint8Array.from([0x0d, 0x00, 0x00, 0x00]), vp8l]);
  const riffSize = 4 + chunk.length;
  return concat([
    new TextEncoder().encode("RIFF"),
    Uint8Array.from([riffSize & 0xff, (riffSize >>> 8) & 0xff, (riffSize >>> 16) & 0xff, (riffSize >>> 24) & 0xff]),
    new TextEncoder().encode("WEBP"),
    chunk,
  ]);
}
