/**
 * Tests for lib/decode.ts — cover remaining error paths.
 *
 * Targets:
 * - decodeStampWithDiagnostics: V4 decode failure with DEBUG_DECODE=true (CBOR extraction)
 * - decodeStampWithDiagnostics: decoded token with missing mint URL
 * - decodeStampWithDiagnostics: decoded token with no proofs
 * - decodeStamp: various error paths
 * - setDebugDecode: toggle debug flag
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { getEncodedTokenV4 } from "@cashu/cashu-ts";
import {
  decodeStamp,
  decodeStampWithDiagnostics,
  setDebugDecode,
  DEBUG_DECODE,
} from "../lib/decode.js";

const TEST_MINT = "https://mint.example.com";

function makeProofs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    amount: 1,
    id: "009a1f293253e41e",
    secret: `secret_${i}`,
    C: "02" + "ab".repeat(32),
  }));
}

describe("decodeStamp", () => {
  test("throws on empty string", () => {
    expect(() => decodeStamp("")).toThrow("Empty token");
  });

  test("throws on whitespace-only string", () => {
    expect(() => decodeStamp("   ")).toThrow("Empty token");
  });

  test("throws on invalid token data", () => {
    expect(() => decodeStamp("cashuBinvalid")).toThrow("Invalid Cashu token");
  });

  test("throws on non-cashu string", () => {
    expect(() => decodeStamp("notacashutoken")).toThrow("Invalid Cashu token");
  });

  test("throws on token with more than 256 proofs", () => {
    const token = getEncodedTokenV4({ mint: TEST_MINT, proofs: makeProofs(257), unit: "usd" });
    expect(() => decodeStamp(token)).toThrow(/too many proofs/i);
  });

  test("accepts token with exactly 256 proofs", () => {
    const token = getEncodedTokenV4({ mint: TEST_MINT, proofs: makeProofs(256), unit: "usd" });
    expect(() => decodeStamp(token)).not.toThrow();
  });
});

describe("decodeStampWithDiagnostics", () => {
  test("returns null stamp with error for empty token", () => {
    const result = decodeStampWithDiagnostics("");
    expect(result.stamp).toBeNull();
    expect(result.diagnostics.error).toBe("Empty token");
    expect(result.diagnostics.decodeTimeMs).toBeGreaterThanOrEqual(0);
  });

  test("returns null stamp with error for invalid V4 token", () => {
    const result = decodeStampWithDiagnostics("cashuBAAAAAAAA");
    expect(result.stamp).toBeNull();
    expect(result.diagnostics.tokenVersion).toBe("V4");
    expect(result.diagnostics.error).toBeDefined();
  });

  test("returns null stamp with error for invalid V3 token", () => {
    const result = decodeStampWithDiagnostics("cashuAinvalidbase64data");
    expect(result.stamp).toBeNull();
    expect(result.diagnostics.error).toBeDefined();
  });

  test("captures CBOR structure on V4 decode failure when DEBUG_DECODE is true", () => {
    setDebugDecode(true);
    try {
      const result = decodeStampWithDiagnostics("cashuBAAAAAAAA");
      expect(result.stamp).toBeNull();
      expect(result.diagnostics.tokenVersion).toBe("V4");
      // DEBUG_DECODE enables CBOR structure extraction
      expect(result.diagnostics.rawCborStructure).toBeDefined();
    } finally {
      setDebugDecode(false);
    }
  });

  test("does not extract CBOR structure for V3 tokens even with DEBUG_DECODE", () => {
    setDebugDecode(true);
    try {
      const result = decodeStampWithDiagnostics("cashuAinvalid");
      expect(result.stamp).toBeNull();
      // V3 tokens don't trigger CBOR extraction
      expect(result.diagnostics.rawCborStructure).toBeUndefined();
    } finally {
      setDebugDecode(false);
    }
  });
});

// Missing mint / no proofs tests are in decode-mock.test.ts
// (requires vi.mock at module level, separate from other tests)

describe("setDebugDecode", () => {
  afterEach(() => {
    setDebugDecode(false);
  });

  test("sets DEBUG_DECODE to true", () => {
    setDebugDecode(true);
    // Verify by importing again — but we can also just check the flag
    expect(DEBUG_DECODE).toBe(true);
  });

  test("sets DEBUG_DECODE back to false", () => {
    setDebugDecode(true);
    setDebugDecode(false);
    expect(DEBUG_DECODE).toBe(false);
  });
});
