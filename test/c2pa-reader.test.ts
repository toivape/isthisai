import { beforeEach, describe, expect, test, vi } from "vitest";

// The reader is a wasm object whose free() must run on every path: a leaked
// reader in a long-lived worker holds wasm memory. The real wasm cannot report
// that, so this file mocks @contentauth/c2pa-wasm and asserts the contract.
const fromBytes = vi.fn();

vi.mock("@contentauth/c2pa-wasm", () => ({
  default: vi.fn(async () => undefined),
  WasmReader: { fromBytes: (...args: unknown[]) => fromBytes(...args) },
}));

const { readC2pa } = await import("../src/background/c2pa");

function fakeReader(json: string): { json(): string; free: ReturnType<typeof vi.fn> } {
  return { json: () => json, free: vi.fn() };
}

const VALID_STORE = JSON.stringify({
  active_manifest: "m",
  manifests: { m: { label: "m", assertions: [] } },
  validation_state: "Valid",
});

describe("readC2pa: reader lifecycle", () => {
  beforeEach(() => {
    fromBytes.mockReset();
  });

  test("frees the reader after a successful parse", async () => {
    const reader = fakeReader(VALID_STORE);
    fromBytes.mockResolvedValue(reader);
    const result = await readC2pa("image/png", new Uint8Array([1, 2, 3]), "ignored-when-mocked");
    expect(result).toMatchObject({ manifest: "present" });
    expect(reader.free).toHaveBeenCalledOnce();
  });

  test("frees the reader when the json payload is malformed", async () => {
    const reader = fakeReader("not json");
    fromBytes.mockResolvedValue(reader);
    const result = await readC2pa("image/png", new Uint8Array([1, 2, 3]), "ignored-when-mocked");
    // JSON.parse throws inside the try, so the finally must still free.
    expect(result).toEqual({ manifest: "error", aiAction: false });
    expect(reader.free).toHaveBeenCalledOnce();
  });

  test("does not attempt to free when fromBytes rejects before a reader exists", async () => {
    fromBytes.mockRejectedValue(new Error("C2pa(JumbfNotFound)"));
    const result = await readC2pa("image/png", new Uint8Array([1, 2, 3]), "ignored-when-mocked");
    expect(result).toEqual({ manifest: "absent", aiAction: false });
  });
});
