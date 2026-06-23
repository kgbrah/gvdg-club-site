import { describe, it, expect } from "vitest";
import { hashPin, verifyPin, constantTimeEqual } from "../src/crypto.js";

describe("PIN hashing (PBKDF2 via WebCrypto)", () => {
  it("verifies a correct PIN against its stored hash", async () => {
    const stored = await hashPin("4821");
    expect(await verifyPin("4821", stored)).toBe(true);
  });

  it("rejects an incorrect PIN", async () => {
    const stored = await hashPin("4821");
    expect(await verifyPin("0000", stored)).toBe(false);
  });

  it("uses a random salt so the same PIN hashes differently each time", async () => {
    const a = await hashPin("1234");
    const b = await hashPin("1234");
    expect(a).not.toEqual(b);
    // ...but both still verify
    expect(await verifyPin("1234", a)).toBe(true);
    expect(await verifyPin("1234", b)).toBe(true);
  });

  it("produces the documented encoded format pbkdf2$sha256$<iters>$<salt>$<hash>", async () => {
    const stored = await hashPin("9999");
    const parts = stored.split("$");
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("sha256");
    expect(Number(parts[2])).toBeGreaterThanOrEqual(100000);
    expect(parts).toHaveLength(5);
  });

  it("returns false (never throws) on a malformed stored value", async () => {
    expect(await verifyPin("1234", "garbage")).toBe(false);
    expect(await verifyPin("1234", "")).toBe(false);
    expect(await verifyPin("1234", "pbkdf2$sha256$only$three")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("is true for identical byte arrays", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
  it("is false for differing arrays of equal length", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
  it("is false for arrays of differing length", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });
});
