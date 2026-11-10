// Media type detection from magic bytes only (never the file extension or
// Content-Type header, hard rule 4). The returned string is passed both to
// WasmReader.fromBytes (which accepts image/png, image/jpeg, image/webp,
// image/gif, image/avif, image/heic) and as the OpenAI upload part type.

export type SniffedType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/avif"
  | "image/heic"
  | "unknown";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

// ISO-BMFF (AVIF/HEIC): 4-byte size, "ftyp", then the 4-byte major brand.
// The brand list also carries compatible brands; the major brand alone
// identifies the container here.
function sniffIsoBmff(bytes: Uint8Array): SniffedType | "unknown" {
  if (bytes.length < 12) return "unknown";
  if (asciiAt(bytes, 4, 4) !== "ftyp") return "unknown";
  const brand = asciiAt(bytes, 8, 4);
  if (brand === "avif" || brand === "avis") return "image/avif";
  if (brand === "heic" || brand === "heix" || brand === "hevc" || brand === "hevx") return "image/heic";
  return "unknown";
}

export function sniffMediaType(bytes: Uint8Array): SniffedType {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (bytes.length >= 12 && asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (asciiAt(bytes, 0, 6) === "GIF87a" || asciiAt(bytes, 0, 6) === "GIF89a") return "image/gif";
  return sniffIsoBmff(bytes);
}

// OpenAI accepts PNG, JPEG and WebP only (section 2).
export function isOpenAiType(type: SniffedType): boolean {
  return type === "image/png" || type === "image/jpeg" || type === "image/webp";
}
