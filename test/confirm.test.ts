import { describe, expect, test } from "vitest";
import { confirmsFor, formatSize, parseConfirmParams } from "../src/confirm/view";

// The worker passes the image details as query parameters rather than a srcUrl,
// so a data: URL's payload never has to travel in a window URL. The page renders
// them and decides nothing else.

describe("parseConfirmParams", () => {
  test("reads the check id, origin, media type and size from the window URL", () => {
    const search = "?view=confirm&checkId=c1&origin=https%3A%2F%2Fpage.example&mediaType=image%2Fjpeg&sizeBytes=459248";
    expect(parseConfirmParams(search)).toEqual({
      checkId: "c1",
      origin: "https://page.example",
      mediaType: "image/jpeg",
      sizeBytes: 459248,
    });
  });

  test("an absent or empty origin is absent, not an empty label", () => {
    // A data: or blob: image has no origin to show; the line must disappear
    // rather than read "From: ".
    expect(parseConfirmParams("?checkId=c1&mediaType=image/png").origin).toBeUndefined();
    expect(parseConfirmParams("?checkId=c1&origin=").origin).toBeUndefined();
  });

  test("whitespace-only values are absent, not rendered blank", () => {
    const padded = parseConfirmParams("?checkId=c1&origin=%20&mediaType=%20&sizeBytes=%20");
    expect(padded.origin).toBeUndefined();
    expect(padded.mediaType).toBe("");
    expect(padded.sizeBytes).toBeUndefined();
  });

  test("absent parameters fall back rather than leaking undefined", () => {
    const bare = parseConfirmParams("");
    expect(bare.checkId).toBe("");
    expect(bare.mediaType).toBe("");
    expect(bare.origin).toBeUndefined();
    expect(bare.sizeBytes).toBeUndefined();
  });

  test("an absent or unparseable size is absent rather than zero", () => {
    expect(parseConfirmParams("?checkId=c1").sizeBytes).toBeUndefined();
    expect(parseConfirmParams("?checkId=c1&sizeBytes=").sizeBytes).toBeUndefined();
    expect(parseConfirmParams("?checkId=c1&sizeBytes=not-a-number").sizeBytes).toBeUndefined();
    expect(parseConfirmParams("?checkId=c1&sizeBytes=-5").sizeBytes).toBeUndefined();
  });

  test("a size of zero is a size, not an absent one", () => {
    expect(parseConfirmParams("?checkId=c1&sizeBytes=0").sizeBytes).toBe(0);
  });
});

describe("formatSize", () => {
  test("renders bytes, KiB and MiB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KiB");
    expect(formatSize(459248)).toBe("448.5 KiB");
    expect(formatSize(1572864)).toBe("1.5 MiB");
  });

  test("each unit boundary belongs to the larger unit", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KiB");
    expect(formatSize(1048575)).toBe("1024.0 KiB");
    expect(formatSize(1048576)).toBe("1.0 MiB");
  });

  test("an absent size renders nothing", () => {
    expect(formatSize(undefined)).toBeUndefined();
  });
});

describe("confirmsFor", () => {
  test("only the upload button confirms; cancel and a closed window decline", () => {
    // A closed window must never be read as consent (hard rule 5).
    expect(confirmsFor("upload")).toBe(true);
    expect(confirmsFor("cancel")).toBe(false);
    expect(confirmsFor("closed")).toBe(false);
  });
});
