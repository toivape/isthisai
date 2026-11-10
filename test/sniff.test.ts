import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { isOpenAiType, sniffMediaType } from "../src/background/sniff";

// Byte helpers: tests describe magic bytes at the offsets the formats use.
function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function bytesOf(text: string): Uint8Array {
  return new Uint8Array([...text].map((ch) => ch.charCodeAt(0)));
}

// ...PNG then anything: the signature is the first 8 bytes.
function pngBytes(): Uint8Array {
  return bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
}

// ISO-BMFF (AVIF/HEIC): size(4) "ftyp"(4) major brand(4) minor version(4)
function ftypBytes(brand: string): Uint8Array {
  return new Uint8Array([...bytes(0x00, 0x00, 0x00, 0x20), ...bytesOf("ftyp"), ...bytesOf(brand), ...bytesOf("0000")]);
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`test/fixtures/${name}`));
}

describe("sniffMediaType", () => {
  test("detects PNG from its 8-byte signature", () => {
    expect(sniffMediaType(pngBytes())).toBe("image/png");
  });

  test("detects JPEG and returns image/jpeg", () => {
    expect(sniffMediaType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("image/jpeg");
  });

  test("detects WebP (RIFF....WEBP)", () => {
    expect(sniffMediaType(bytesOf("RIFF\x24\x00\x00\x00WEBPVP8 "))).toBe("image/webp");
  });

  test("detects GIF87a and GIF89a", () => {
    expect(sniffMediaType(bytesOf("GIF87a"))).toBe("image/gif");
    expect(sniffMediaType(bytesOf("GIF89a"))).toBe("image/gif");
  });

  test("detects AVIF and HEIC from the ftyp brand", () => {
    expect(sniffMediaType(ftypBytes("avif"))).toBe("image/avif");
    expect(sniffMediaType(ftypBytes("heic"))).toBe("image/heic");
  });

  test("returns unknown for empty and truncated input", () => {
    expect(sniffMediaType(new Uint8Array(0))).toBe("unknown");
    // Truncated: too short for any signature.
    expect(sniffMediaType(bytes(0x89, 0x50))).toBe("unknown");
    // Six bytes is enough for GIF; five is truncated.
    expect(sniffMediaType(bytesOf("GIF89"))).toBe("unknown");
  });

  test("returns unknown for SVG text and BMP", () => {
    expect(sniffMediaType(bytesOf("<svg xmlns="))).toBe("unknown");
    expect(sniffMediaType(bytes(0x42, 0x4d, 0x00, 0x00))).toBe("unknown");
  });

  test("returns unknown for a RIFF file that is not WebP", () => {
    expect(sniffMediaType(bytesOf("RIFF\x24\x00\x00\x00WAVE"))).toBe("unknown");
  });

  test("sniffs both image fixtures in test/fixtures/ correctly", () => {
    expect(sniffMediaType(fixture("ai-test-halloween.png"))).toBe("image/png");
    expect(sniffMediaType(fixture("ai-tes-iceland.jpg"))).toBe("image/jpeg");
  });
});

describe("isOpenAiType", () => {
  test("is true only for PNG, JPEG and WebP", () => {
    expect(isOpenAiType("image/png")).toBe(true);
    expect(isOpenAiType("image/jpeg")).toBe(true);
    expect(isOpenAiType("image/webp")).toBe(true);
    expect(isOpenAiType("image/gif")).toBe(false);
    expect(isOpenAiType("image/avif")).toBe(false);
    expect(isOpenAiType("image/heic")).toBe(false);
    expect(isOpenAiType("unknown")).toBe(false);
  });
});
