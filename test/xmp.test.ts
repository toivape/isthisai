import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { scanXmp } from "../src/background/xmp";
import type { CheckResult } from "../src/shared/types";
import {
  gifWithXmpPacket,
  jpegWithXmpPacket,
  pngWithXmpPacket,
  webpWithXmpPacket,
} from "./helpers/images";

type LocalXmp = CheckResult["localXmp"];

const TRAINED = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const COMPOSITE = "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia";
const ALGORITHMIC = "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia";

const RDF =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"' +
  ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"';

// Attribute form: DigitalSourceType as an attribute on rdf:Description.
function attributePacket(sourceType: string, extra = ""): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">${RDF} Iptc4xmpExt:DigitalSourceType="${sourceType}"${extra}/></rdf:RDF></x:xmpmeta>`;
}

// Element form: <Iptc4xmpExt:DigitalSourceType>value</...> as a property.
function elementPacket(sourceType: string, extra = ""): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/">${RDF}>${extra}<Iptc4xmpExt:DigitalSourceType>${sourceType}</Iptc4xmpExt:DigitalSourceType></rdf:Description></rdf:RDF></x:xmpmeta>`;
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`test/fixtures/${name}`));
}

const DETECTED = { state: "detected" } satisfies LocalXmp;
const NOT_DETECTED = { state: "not_detected" } satisfies LocalXmp;

describe("scanXmp: the packet is found in every container", () => {
  test("JPEG APP1 segment", () => {
    expect(scanXmp(jpegWithXmpPacket(attributePacket(TRAINED)))).toEqual(DETECTED);
  });

  test("PNG uncompressed iTXt chunk", () => {
    expect(scanXmp(pngWithXmpPacket(attributePacket(TRAINED)))).toEqual(DETECTED);
  });

  test("WebP 'XMP ' chunk", () => {
    expect(scanXmp(webpWithXmpPacket(attributePacket(TRAINED)))).toEqual(DETECTED);
  });

  test("GIF application extension", () => {
    expect(scanXmp(gifWithXmpPacket(attributePacket(TRAINED)))).toEqual(DETECTED);
  });
});

describe("scanXmp: DigitalSourceType mapping", () => {
  test("attribute form with trainedAlgorithmicMedia is detected", () => {
    expect(scanXmp(jpegWithXmpPacket(attributePacket(TRAINED)))).toEqual(DETECTED);
  });

  test("element form with trainedAlgorithmicMedia is detected", () => {
    expect(scanXmp(jpegWithXmpPacket(elementPacket(TRAINED)))).toEqual(DETECTED);
  });

  test("compositeWithTrainedAlgorithmicMedia is detected", () => {
    expect(scanXmp(jpegWithXmpPacket(attributePacket(COMPOSITE)))).toEqual(DETECTED);
  });

  test("algorithmicMedia is not detected but the value is recorded", () => {
    expect(scanXmp(jpegWithXmpPacket(attributePacket(ALGORITHMIC)))).toEqual({
      state: "not_detected",
      digitalSourceType: ALGORITHMIC,
    } satisfies LocalXmp);
  });

  test("a packet without DigitalSourceType is not detected and records no value", () => {
    const packet = `<x:xmpmeta xmlns:x="adobe:ns:meta/">${RDF}/></rdf:RDF></x:xmpmeta>`;
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual(NOT_DETECTED);
  });
});

describe("scanXmp: CreatorTool is a hint only", () => {
  test("a known generator name gives a generatorHint but stays not_detected", () => {
    const packet = attributePacket(
      "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
      ' xmp:CreatorTool="ChatGPT"',
    );
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({
      state: "not_detected",
      generatorHint: "ChatGPT",
      digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
    } satisfies LocalXmp);
  });

  test("an unknown CreatorTool is ignored", () => {
    const packet = attributePacket(
      "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
      ' xmp:CreatorTool="Adobe Photoshop 26.0"',
    );
    const result = scanXmp(jpegWithXmpPacket(packet));
    expect(result.state).toBe("not_detected");
    expect(result.generatorHint).toBeUndefined();
  });
});

describe("scanXmp: missing or malformed packets", () => {
  test("no packet is not_detected", () => {
    expect(scanXmp(fixture("ai-tes-iceland.jpg"))).toEqual(NOT_DETECTED);
  });

  test("an unterminated packet is an error", () => {
    const unterminated = `<x:xmpmeta xmlns:x="adobe:ns:meta/">${RDF} Iptc4xmpExt:DigitalSourceType="${TRAINED}"/></rdf:RDF>`;
    expect(scanXmp(jpegWithXmpPacket(unterminated))).toEqual({ state: "error" } satisfies LocalXmp);
  });

  test("empty bytes are not_detected", () => {
    expect(scanXmp(new Uint8Array(0))).toEqual(NOT_DETECTED);
  });
});

describe("scanXmp: fixtures", () => {
  test("iceland phone photo has no XMP packet", () => {
    expect(scanXmp(fixture("ai-tes-iceland.jpg"))).toEqual(NOT_DETECTED);
  });

  test("halloween PNG: its DigitalSourceType bytes are in C2PA, not an XMP packet", () => {
    expect(scanXmp(fixture("ai-test-halloween.png"))).toEqual(NOT_DETECTED);
  });
});

describe("scanXmp: XML serialization forms", () => {
  const CAPTURE = "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture";
  const NOT_AI = { state: "not_detected", digitalSourceType: CAPTURE } satisfies LocalXmp;

  test("a commented-out AI element before a real capture property is not detected", () => {
    const packet =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">${RDF}` +
      `><!-- <Iptc4xmpExt:DigitalSourceType>${TRAINED}</Iptc4xmpExt:DigitalSourceType> -->` +
      `<Iptc4xmpExt:DigitalSourceType>${CAPTURE}</Iptc4xmpExt:DigitalSourceType></rdf:Description></rdf:RDF></x:xmpmeta>`;
    expect(scanXmp(new TextEncoder().encode(packet))).toEqual(NOT_AI);
  });

  test("a commented-out AI attribute before a real capture attribute is not detected", () => {
    const packet =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">${RDF}>` +
      `<!-- <rdf:Description Iptc4xmpExt:DigitalSourceType="${TRAINED}"/> -->` +
      `<rdf:Description rdf:about="" Iptc4xmpExt:DigitalSourceType="${CAPTURE}"/></rdf:RDF></x:xmpmeta>`;
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual(NOT_AI);
  });

  test("rdf:resource element form with trainedAlgorithmicMedia is detected", () => {
    const packet =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">${RDF}>` +
      `<Iptc4xmpExt:DigitalSourceType rdf:resource="${TRAINED}"/></rdf:Description></rdf:RDF></x:xmpmeta>`;
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual(DETECTED);
  });

  test("a numeric character reference in the element value is decoded", () => {
    const escaped = TRAINED.replace("trained", "&#116;rained");
    const packet = elementPacket(escaped);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual(DETECTED);
  });

  test("a numeric character reference in the attribute value is decoded", () => {
    const escaped = TRAINED.replace("trained", "&#x74;rained");
    const packet = attributePacket(escaped);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual(DETECTED);
  });

  test("a recorded non-AI value is stored decoded, not escaped", () => {
    const escaped = CAPTURE.replace("Capture", "&#67;apture");
    const packet = elementPacket(escaped);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({ state: "not_detected", digitalSourceType: CAPTURE } satisfies LocalXmp);
  });

  test("an empty DigitalSourceType value records nothing", () => {
    expect(scanXmp(jpegWithXmpPacket(attributePacket("")))).toEqual(NOT_DETECTED);
    expect(scanXmp(jpegWithXmpPacket(elementPacket("")))).toEqual(NOT_DETECTED);
  });

  test("a CDATA-wrapped element value is data, not markup", () => {
    const packet = elementPacket(`<![CDATA[${TRAINED}]]>`);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual(DETECTED);
  });

  test("a comment inside the value is stripped before matching", () => {
    // Comment sits between two halves of a generator name: stripping it joins
    // them into a match; replacing it with text breaks the name apart.
    const split = `Chat<!--x-->GPT`;
    const packet =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">${RDF} xmp:CreatorTool="${split}"/></rdf:RDF></x:xmpmeta>`;
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({ state: "not_detected", generatorHint: "ChatGPT" } satisfies LocalXmp);
  });

  test("a property immediately before the end marker is still read", () => {
    // The packet slice must include the whole end marker; cutting it short
    // would drop this trailing property.
    const packet = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description Iptc4xmpExt:DigitalSourceType="${TRAINED}"/></x:xmpmeta>`;
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual(DETECTED);
  });
});

// These cases exist to pin down the exact shape of each regex: the boundary
// quantifiers, the whitespace around "=" and the anchor of the value group.
// A narrower regex or a dropped quantifier must turn one of these red.
describe("scanXmp: property regex boundaries", () => {
  const body = (inner: string): Uint8Array => new TextEncoder().encode(`<x:xmpmeta xmlns:x="adobe:ns:meta/">${inner}</x:xmpmeta>`);

  test("rdf:resource recognises a tag with an attribute before it and spaces around =", () => {
    const tagged =
      `<rdf:RDF><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">` +
      `<Iptc4xmpExt:DigitalSourceType x="1" rdf:resource = "${TRAINED}"/></rdf:Description></rdf:RDF>`;
    expect(scanXmp(body(tagged))).toEqual(DETECTED);
  });

  test("element form recognises a start tag that carries an attribute", () => {
    const tagged =
      `<rdf:RDF><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">` +
      `<Iptc4xmpExt:DigitalSourceType foo="1">${TRAINED}</Iptc4xmpExt:DigitalSourceType></rdf:Description></rdf:RDF>`;
    expect(scanXmp(body(tagged))).toEqual(DETECTED);
  });

  test("attribute form recognises spaces around =", () => {
    const tagged =
      `<rdf:RDF><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"` +
      ` Iptc4xmpExt:DigitalSourceType = "${TRAINED}"/></rdf:RDF>`;
    expect(scanXmp(body(tagged))).toEqual(DETECTED);
  });

  test("a value is trimmed of surrounding whitespace before matching", () => {
    const tagged =
      `<rdf:RDF><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">` +
      `<Iptc4xmpExt:DigitalSourceType>  ${TRAINED}  </Iptc4xmpExt:DigitalSourceType></rdf:Description></rdf:RDF>`;
    expect(scanXmp(body(tagged))).toEqual(DETECTED);
  });

  test("CreatorTool rdf:resource form recognises an attribute before it and spaces around =", () => {
    const tagged =
      `<rdf:RDF><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/">` +
      `<xmp:CreatorTool x="1" rdf:resource = "ChatGPT"/></rdf:Description></rdf:RDF>`;
    expect(scanXmp(body(tagged))).toEqual({ state: "not_detected", generatorHint: "ChatGPT" } satisfies LocalXmp);
  });

  test("CreatorTool rdf:resource form recognises no whitespace around =", () => {
    const tagged =
      `<rdf:RDF><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/">` +
      `<xmp:CreatorTool rdf:resource="ChatGPT"/></rdf:Description></rdf:RDF>`;
    expect(scanXmp(body(tagged))).toEqual({ state: "not_detected", generatorHint: "ChatGPT" } satisfies LocalXmp);
  });

  test("CreatorTool element form recognises a start tag that carries an attribute", () => {
    // "Stable Diffusion" carries a space: the value group must match across
    // whitespace, not just non-whitespace characters.
    const tagged =
      `<rdf:RDF><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/">` +
      `<xmp:CreatorTool foo="1">Stable Diffusion</xmp:CreatorTool></rdf:Description></rdf:RDF>`;
    expect(scanXmp(body(tagged))).toEqual({ state: "not_detected", generatorHint: "Stable Diffusion" } satisfies LocalXmp);
  });

  test("CreatorTool attribute form recognises spaces around =", () => {
    const tagged =
      `<rdf:RDF><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/"` +
      ` xmp:CreatorTool = "Midjourney"/></rdf:RDF>`;
    expect(scanXmp(body(tagged))).toEqual({ state: "not_detected", generatorHint: "Midjourney" } satisfies LocalXmp);
  });
});

describe("scanXmp: XML entity decoding", () => {
  const CAPTURE = "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture";

  test("a named entity is decoded", () => {
    const packet = attributePacket(`${CAPTURE}&amp;x`);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({
      state: "not_detected",
      digitalSourceType: `${CAPTURE}&x`,
    } satisfies LocalXmp);
  });

  test("every predefined named entity is decoded", () => {
    const cases: Array<[string, string]> = [
      ["lt", "<"],
      ["gt", ">"],
      ["quot", '"'],
      ["apos", "'"],
    ];
    for (const [name, char] of cases) {
      const packet = attributePacket(`${CAPTURE}&${name};`);
      expect(scanXmp(jpegWithXmpPacket(packet)), name).toEqual({
        state: "not_detected",
        digitalSourceType: `${CAPTURE}${char}`,
      } satisfies LocalXmp);
    }
  });

  test("an unknown named entity is left as written", () => {
    const packet = attributePacket(`${CAPTURE}&nosuch;`);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({
      state: "not_detected",
      digitalSourceType: `${CAPTURE}&nosuch;`,
    } satisfies LocalXmp);
  });

  test("an uppercase-hex character reference is decoded", () => {
    const packet = attributePacket(`${CAPTURE}&#X41;`);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({
      state: "not_detected",
      digitalSourceType: `${CAPTURE}A`,
    } satisfies LocalXmp);
  });

  test("the NUL code point is a valid reference", () => {
    const packet = attributePacket(`${CAPTURE}&#0;`);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({
      state: "not_detected",
      digitalSourceType: `${CAPTURE}\u0000`,
    } satisfies LocalXmp);
  });

  test("the highest code point is a valid reference", () => {
    const packet = attributePacket(`${CAPTURE}&#1114111;`);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({
      state: "not_detected",
      digitalSourceType: `${CAPTURE}\u{10ffff}`,
    } satisfies LocalXmp);
  });

  test("a code point above the Unicode range is left as written, not thrown", () => {
    const packet = attributePacket(`${CAPTURE}&#1114112;`);
    expect(scanXmp(jpegWithXmpPacket(packet))).toEqual({
      state: "not_detected",
      digitalSourceType: `${CAPTURE}&#1114112;`,
    } satisfies LocalXmp);
  });
});

describe("scanXmp: packet boundaries", () => {
  test("an end marker before the start marker does not close a later packet", () => {
    // The scan starts at "<x:xmpmeta"; an earlier "</x:xmpmeta>" must not be
    // picked up as its terminator (the END search starts after the START).
    const bytes = new TextEncoder().encode(`AAAAAAAAAA${"</x:xmpmeta>"}<x:xmpmeta>`);
    expect(scanXmp(bytes)).toEqual({ state: "error" } satisfies LocalXmp);
  });
});

