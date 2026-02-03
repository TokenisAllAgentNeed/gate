/**
 * Performance and compatibility tests for token decoding.
 *
 * Tests cover:
 * 1. Decode latency for V3 (cashuA) and V4 (cashuB) tokens
 * 2. Performance with varying proof counts (1, 10, 50, 100)
 * 3. V3/V4 format compatibility
 *
 * Performance targets:
 * - decode <5ms for typical tokens
 * - verify <10ms/proof (when verification is added)
 * - full request cycle <30ms
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  getEncodedToken,
  getEncodedTokenV4,
  getDecodedToken,
  type Proof,
  type Token,
} from "@cashu/cashu-ts";
import {
  decodeStamp,
  decodeStampWithDiagnostics,
  detectTokenVersion,
  setDebugDecode,
} from "../lib/decode.js";

const TEST_MINT = "https://mint.example.com";

/**
 * Generate a valid-looking proof for testing.
 * Note: These are structurally valid but not cryptographically valid proofs.
 */
function generateTestProof(amount: number, index: number): Proof {
  return {
    amount,
    id: "009a1f293253e41e",
    secret: `test_secret_${index}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    C: "02" + "ab".repeat(32), // 33-byte compressed pubkey format
  };
}

/**
 * Generate multiple proofs with specified amounts.
 */
function generateTestProofs(count: number): Proof[] {
  const amounts = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
  return Array.from({ length: count }, (_, i) =>
    generateTestProof(amounts[i % amounts.length], i)
  );
}

/**
 * Create a V3 token (cashuA format - JSON based)
 */
function createV3Token(proofs: Proof[], mint: string = TEST_MINT): string {
  const token: Token = {
    mint,
    proofs,
    unit: "usd",
  };
  // Must explicitly request version 3, as cashu-ts v2.x defaults to V4
  return getEncodedToken(token, { version: 3 });
}

/**
 * Create a V4 token (cashuB format - CBOR based)
 */
function createV4Token(proofs: Proof[], mint: string = TEST_MINT): string {
  return getEncodedTokenV4({
    mint,
    proofs,
    unit: "usd",
  });
}

/**
 * Measure execution time of a function
 */
async function measureTime<T>(fn: () => T | Promise<T>): Promise<{ result: T; timeMs: number }> {
  const start = performance.now();
  const result = await fn();
  const timeMs = performance.now() - start;
  return { result, timeMs };
}

/**
 * Run a function multiple times and return timing statistics
 */
async function benchmark<T>(
  fn: () => T | Promise<T>,
  iterations: number = 100
): Promise<{
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}> {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const { timeMs } = await measureTime(fn);
    times.push(timeMs);
  }

  times.sort((a, b) => a - b);

  return {
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    median: times[Math.floor(times.length / 2)],
    p95: times[Math.floor(times.length * 0.95)],
    min: times[0],
    max: times[times.length - 1],
  };
}

describe("Token Version Detection", () => {
  it("detects V3 (cashuA) tokens", () => {
    const proofs = generateTestProofs(1);
    const token = createV3Token(proofs);

    expect(token.startsWith("cashuA")).toBe(true);
    expect(detectTokenVersion(token)).toBe("V3");
  });

  it("detects V4 (cashuB) tokens", () => {
    const proofs = generateTestProofs(1);
    const token = createV4Token(proofs);

    expect(token.startsWith("cashuB")).toBe(true);
    expect(detectTokenVersion(token)).toBe("V4");
  });

  it("returns unknown for invalid tokens", () => {
    expect(detectTokenVersion("invalid")).toBe("unknown");
    expect(detectTokenVersion("cashuC...")).toBe("unknown");
    expect(detectTokenVersion("")).toBe("unknown");
  });
});

describe("V3/V4 Decode Compatibility", () => {
  const proofCounts = [1, 5, 10];

  describe("V3 (cashuA) tokens", () => {
    proofCounts.forEach((count) => {
      it(`decodes V3 token with ${count} proofs`, () => {
        const proofs = generateTestProofs(count);
        const token = createV3Token(proofs);

        const stamp = decodeStamp(token);

        expect(stamp.mint).toBe(TEST_MINT);
        expect(stamp.proofs).toHaveLength(count);
        expect(stamp.amount).toBe(proofs.reduce((sum, p) => sum + p.amount, 0));
      });
    });

    it("decodes V3 token with memo", () => {
      const proofs = generateTestProofs(1);
      const token: Token = {
        mint: TEST_MINT,
        proofs,
        unit: "usd",
        memo: "test memo",
      };
      const encoded = getEncodedToken(token);

      const decoded = getDecodedToken(encoded);
      expect(decoded.memo).toBe("test memo");
    });
  });

  describe("V4 (cashuB) tokens", () => {
    proofCounts.forEach((count) => {
      it(`decodes V4 token with ${count} proofs`, () => {
        const proofs = generateTestProofs(count);
        const token = createV4Token(proofs);

        const stamp = decodeStamp(token);

        expect(stamp.mint).toBe(TEST_MINT);
        expect(stamp.proofs).toHaveLength(count);
        expect(stamp.amount).toBe(proofs.reduce((sum, p) => sum + p.amount, 0));
      });
    });

    it("preserves proof structure in V4", () => {
      const proofs = generateTestProofs(3);
      const token = createV4Token(proofs);

      const stamp = decodeStamp(token);

      stamp.proofs.forEach((p, i) => {
        expect(p.amount).toBe(proofs[i].amount);
        expect(p.id).toBe(proofs[i].id);
        // Secret and C should be preserved
        expect(p.secret).toBeTruthy();
        expect(p.C).toBeTruthy();
      });
    });
  });

  describe("Cross-format equivalence", () => {
    it("V3 and V4 decode to equivalent stamps", () => {
      const proofs = generateTestProofs(5);

      const v3Token = createV3Token(proofs);
      const v4Token = createV4Token(proofs);

      const v3Stamp = decodeStamp(v3Token);
      const v4Stamp = decodeStamp(v4Token);

      expect(v3Stamp.mint).toBe(v4Stamp.mint);
      expect(v3Stamp.amount).toBe(v4Stamp.amount);
      expect(v3Stamp.proofs.length).toBe(v4Stamp.proofs.length);

      // Proofs should have same amounts
      const v3Amounts = v3Stamp.proofs.map((p) => p.amount).sort((a, b) => a - b);
      const v4Amounts = v4Stamp.proofs.map((p) => p.amount).sort((a, b) => a - b);
      expect(v3Amounts).toEqual(v4Amounts);
    });
  });
});

describe("Decode Performance", () => {
  // Warm up JIT
  beforeAll(() => {
    const warmupProofs = generateTestProofs(10);
    const warmupV3 = createV3Token(warmupProofs);
    const warmupV4 = createV4Token(warmupProofs);
    for (let i = 0; i < 10; i++) {
      decodeStamp(warmupV3);
      decodeStamp(warmupV4);
    }
  });

  describe("V3 decode latency", () => {
    const testCases = [
      { count: 1, maxMs: 5 },
      { count: 10, maxMs: 5 },
      { count: 50, maxMs: 10 },
      { count: 100, maxMs: 15 },
    ];

    testCases.forEach(({ count, maxMs }) => {
      it(`decodes ${count} proofs in <${maxMs}ms (p95)`, async () => {
        const proofs = generateTestProofs(count);
        const token = createV3Token(proofs);

        const stats = await benchmark(() => decodeStamp(token), 50);

        console.log(`V3 ${count} proofs: mean=${stats.mean.toFixed(2)}ms, p95=${stats.p95.toFixed(2)}ms`);

        expect(stats.p95).toBeLessThan(maxMs);
      });
    });
  });

  describe("V4 decode latency", () => {
    const testCases = [
      { count: 1, maxMs: 5 },
      { count: 10, maxMs: 5 },
      { count: 50, maxMs: 10 },
      { count: 100, maxMs: 15 },
    ];

    testCases.forEach(({ count, maxMs }) => {
      it(`decodes ${count} proofs in <${maxMs}ms (p95)`, async () => {
        const proofs = generateTestProofs(count);
        const token = createV4Token(proofs);

        const stats = await benchmark(() => decodeStamp(token), 50);

        console.log(`V4 ${count} proofs: mean=${stats.mean.toFixed(2)}ms, p95=${stats.p95.toFixed(2)}ms`);

        expect(stats.p95).toBeLessThan(maxMs);
      });
    });
  });

  describe("Decode with diagnostics overhead", () => {
    it("diagnostics adds <1ms overhead", async () => {
      const proofs = generateTestProofs(10);
      const token = createV4Token(proofs);

      const regularStats = await benchmark(() => decodeStamp(token), 50);
      const diagStats = await benchmark(() => decodeStampWithDiagnostics(token), 50);

      const overhead = diagStats.mean - regularStats.mean;
      console.log(`Diagnostics overhead: ${overhead.toFixed(2)}ms`);

      expect(overhead).toBeLessThan(1);
    });
  });
});

describe("Diagnostics Output", () => {
  it("returns correct diagnostics for V3 token", () => {
    const proofs = generateTestProofs(3);
    const token = createV3Token(proofs);

    const { stamp, diagnostics } = decodeStampWithDiagnostics(token);

    expect(stamp).not.toBeNull();
    expect(diagnostics.tokenVersion).toBe("V3");
    expect(diagnostics.proofCount).toBe(3);
    expect(diagnostics.decodeTimeMs).toBeGreaterThan(0);
    expect(diagnostics.error).toBeUndefined();
  });

  it("returns correct diagnostics for V4 token", () => {
    const proofs = generateTestProofs(5);
    const token = createV4Token(proofs);

    const { stamp, diagnostics } = decodeStampWithDiagnostics(token);

    expect(stamp).not.toBeNull();
    expect(diagnostics.tokenVersion).toBe("V4");
    expect(diagnostics.proofCount).toBe(5);
    expect(diagnostics.decodeTimeMs).toBeGreaterThan(0);
    expect(diagnostics.error).toBeUndefined();
  });

  it("captures error diagnostics for invalid token", () => {
    const { stamp, diagnostics } = decodeStampWithDiagnostics("cashuBinvalid");

    expect(stamp).toBeNull();
    expect(diagnostics.tokenVersion).toBe("V4");
    expect(diagnostics.error).toBeTruthy();
  });

  it("captures error diagnostics for empty token", () => {
    const { stamp, diagnostics } = decodeStampWithDiagnostics("");

    expect(stamp).toBeNull();
    expect(diagnostics.error).toBe("Empty token");
  });

  it("enables debug mode for verbose CBOR logging", () => {
    setDebugDecode(true);

    const { stamp, diagnostics } = decodeStampWithDiagnostics("cashuBinvalid");

    expect(stamp).toBeNull();
    // Debug mode should attempt to extract CBOR structure
    expect(diagnostics.rawCborStructure).toBeDefined();

    setDebugDecode(false);
  });
});

describe("Error Handling", () => {
  it("rejects empty token", () => {
    expect(() => decodeStamp("")).toThrow("Empty token");
    expect(() => decodeStamp("   ")).toThrow("Empty token");
  });

  it("rejects malformed V3 token", () => {
    expect(() => decodeStamp("cashuAnot_valid_base64")).toThrow("Invalid Cashu token");
  });

  it("rejects malformed V4 token", () => {
    expect(() => decodeStamp("cashuBnot_valid_cbor")).toThrow("Invalid Cashu token");
  });

  it("rejects unknown token version", () => {
    expect(() => decodeStamp("cashuCwhatever")).toThrow();
  });
});
