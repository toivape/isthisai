import { describe, expect, test } from "vitest";
import {
  fmtSize,
  headerBlock,
  msgLine,
  pageRow,
  permCheckLine,
  permRequestLine,
  verdictLine,
} from "../src/background/spike";

test("fmtSize prints MiB for large sizes", () => {
  expect(fmtSize(41_943_040)).toBe("40.0 MiB");
  expect(fmtSize(1024)).toBe("1.0 KiB");
  expect(fmtSize(0)).toBe("0 B");
});

test("msgLine formats a measured message-size line", () => {
  const line = msgLine({ bytes: 62_914_560, ms: 1200, ok: true, replyMatches: true });
  expect(line).toBe("[spike:msg] bytes=62914560 60.0 MiB ms=1200 ok=true replyMatches=true");
});

test("msgLine marks a failure without claiming a size", () => {
  const line = msgLine({ bytes: 0, ms: 5, ok: false, replyMatches: false });
  expect(line).toBe("[spike:msg] bytes=0 ms=5 ok=false replyMatches=false");
});

test("permCheckLine reports origins and contains results", () => {
  const line = permCheckLine({
    tabOrigin: "https://page.example",
    frameOrigin: "https://frame.example",
    containsAllUrls: false,
    containsTabOrigin: true,
  });
  expect(line).toBe(
    "[spike:perm] check tabOrigin=https://page.example frameOrigin=https://frame.example " +
      "containsAllUrls=false activeTabTabOrigin=true",
  );
});

test("permRequestLine reports request outcome", () => {
  const line = permRequestLine({ requestOk: true, granted: true, containsAfter: true });
  expect(line).toBe("[spike:perm] request requestOk=true granted=true containsAfter=true");
  const denied = permRequestLine({ requestOk: true, granted: false, containsAfter: false });
  expect(denied).toBe("[spike:perm] request requestOk=true granted=false containsAfter=false");
});

test("headerBlock formats each survival phase", () => {
  const line = headerBlock("download-headers", {
    ms: 35_800,
    bytes: 41_943_040,
    headersMs: 35_000,
    completed: true,
  });
  expect(line).toBe(
    "[spike:30s] phase=download-headers bytes=41943040 40.0 MiB ms=35800 headersMs=35000 completed=true",
  );
  const body = headerBlock("download-body", { ms: 42_000, bytes: 41_943_040, completed: true });
  expect(body).toBe("[spike:30s] phase=download-body bytes=41943040 40.0 MiB ms=42000 completed=true");
  const up = headerBlock("upload", { ms: 43_000, bytes: 41_943_040, headersMs: 42_500, completed: true });
  expect(up).toBe("[spike:30s] phase=upload bytes=41943040 40.0 MiB ms=43000 headersMs=42500 completed=true");
});

test("verdictLine formats setAccessLevel and content-script storage read", () => {
  const ok = verdictLine({ accessOk: true, contentRead: false });
  expect(ok).toBe("[spike:access] setAccessLevel=ok contentStorageRead=false");
  const failed = verdictLine({ accessOk: false, contentRead: true });
  expect(failed).toBe("[spike:access] setAccessLevel=FAILED contentStorageRead=true");
});

test("pageRow formats one srcUrl measurement", () => {
  const row = pageRow({
    srcUrl: "https://x.example/img.jpg",
    frameUrl: "https://page.example",
    frameId: 3,
    currentSrc: "https://x.example/img.jpg",
    width: 1080,
    height: 1350,
    fetchStatus: 200,
    fetchOk: true,
    fetchSize: 123456,
    ms: 90,
  });
  expect(row).toBe(
    "[spike:src] srcUrl=https://x.example/img.jpg frameUrl=https://page.example frameId=3 " +
      "currentSrc=https://x.example/img.jpg natural=1080x1350 fetch=200 size=120.6 KiB ms=90",
  );
});

test("pageRow shows a failed fetch without size and an unmatched element", () => {
  const row = pageRow({
    srcUrl: "https://private.example/img.jpg",
    frameUrl: "https://page.example",
    frameId: 0,
    currentSrc: "",
    width: 0,
    height: 0,
    fetchStatus: 403,
    fetchOk: false,
    fetchSize: 0,
    ms: 210,
  });
  expect(row).toBe(
    "[spike:src] srcUrl=https://private.example/img.jpg frameUrl=https://page.example frameId=0 " +
      "currentSrc=<none> natural=0x0 fetch=ERR 403 ms=210",
  );
});
