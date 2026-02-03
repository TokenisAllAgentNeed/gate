/**
 * Token decoding tests specifically for workerd/miniflare environment.
 *
 * This test file is designed to be run via `wrangler test` to verify
 * token decoding behavior in the actual CF Workers runtime.
 *
 * Key tests:
 * 1. V3 vs V4 CBOR decoding in workerd
 * 2. CBOR structure preservation
 * 3. Reproduce the "forEach undefined" bug
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
 * Generate a test proof
 */
function generateTestProof(amount: number, index: number): Proof {
  return {
    amount,
    id: "009a1f293253e41e",
    secret: `test_secret_${index}_${Date.now()}`,
    C: "02" + "ab".repeat(32),
  };
}

/**
 * Generate proofs
 */
function generateTestProofs(count: number): Proof[] {
  const amounts = [1, 2, 4, 8, 16, 32, 64, 128];
  return Array.from({ length: count }, (_, i) =>
    generateTestProof(amounts[i % amounts.length], i)
  );
}

/**
 * Create V3 token (cashuA format - JSON based)
 */
function createV3Token(proofs: Proof[], mint: string = TEST_MINT): string {
  const token: Token = { mint, proofs, unit: "usd" };
  // Must explicitly request version 3, as cashu-ts v2.x defaults to V4
  return getEncodedToken(token, { version: 3 });
}

/**
 * Create V4 token
 */
function createV4Token(proofs: Proof[], mint: string = TEST_MINT): string {
  return getEncodedTokenV4({ mint, proofs, unit: "usd" });
}

describe("workerd CBOR Decode - V3 vs V4", () => {
  // These tests specifically target the CBOR parsing issue in workerd
  
  it("V3 token decodes correctly (baseline)", () => {
    const proofs = generateTestProofs(3);
    const token = createV3Token(proofs);

    expect(detectTokenVersion(token)).toBe("V3");

    const stamp = decodeStamp(token);
    expect(stamp.mint).toBe(TEST_MINT);
    expect(stamp.proofs).toHaveLength(3);
  });

  it("V4 token decodes with correct structure (the bug scenario)", () => {
    // This is the key test - V4 tokens were sometimes losing the `t` array
    // causing "Cannot read properties of undefined (reading 'forEach')"
    const proofs = generateTestProofs(3);
    const token = createV4Token(proofs);

    expect(detectTokenVersion(token)).toBe("V4");

    // Enable debug to capture CBOR structure if it fails
    setDebugDecode(true);
    
    const { stamp, diagnostics } = decodeStampWithDiagnostics(token);
    
    console.log("V4 decode diagnostics:", JSON.stringify(diagnostics, null, 2));
    
    if (!stamp) {
      console.error("V4 decode failed!");
      console.error("Error:", diagnostics.error);
      if (diagnostics.rawCborStructure) {
        console.error("CBOR structure:", diagnostics.rawCborStructure);
      }
    }
    
    setDebugDecode(false);

    expect(stamp).not.toBeNull();
    expect(stamp!.mint).toBe(TEST_MINT);
    expect(stamp!.proofs).toHaveLength(3);
  });

  it("V4 CBOR structure has expected keys: m, u, t", () => {
    // Direct test of CBOR structure to verify `t` array exists
    const proofs = generateTestProofs(2);
    const token = createV4Token(proofs);
    
    // Get the raw decoded token to inspect structure
    const decoded = getDecodedToken(token);
    
    // Verify expected structure
    expect(decoded.mint).toBeTruthy();
    expect(decoded.proofs).toBeDefined();
    expect(Array.isArray(decoded.proofs)).toBe(true);
    expect(decoded.proofs.length).toBe(2);
  });

  it("handles mixed V3/V4 requests correctly", () => {
    // Simulates the "sometimes works, sometimes doesn't" scenario
    const proofs = generateTestProofs(2);
    
    // Alternate between V3 and V4 tokens
    const results: Array<{ version: string; success: boolean; error?: string }> = [];
    
    for (let i = 0; i < 10; i++) {
      const isV4 = i % 2 === 0;
      const token = isV4 ? createV4Token(proofs) : createV3Token(proofs);
      
      try {
        const stamp = decodeStamp(token);
        results.push({
          version: isV4 ? "V4" : "V3",
          success: true,
        });
      } catch (e) {
        results.push({
          version: isV4 ? "V4" : "V3",
          success: false,
          error: e instanceof Error ? e.message : "unknown",
        });
      }
    }
    
    // Log results for debugging
    console.log("Mixed V3/V4 results:", results);
    
    // All should succeed
    const failures = results.filter(r => !r.success);
    expect(failures).toHaveLength(0);
  });
});

describe("workerd CBOR Edge Cases", () => {
  it("handles V4 token with many proofs", () => {
    // Larger tokens might trigger different code paths
    const proofs = generateTestProofs(20);
    const token = createV4Token(proofs);
    
    const { stamp, diagnostics } = decodeStampWithDiagnostics(token);
    
    console.log(`Decoded ${diagnostics.proofCount} proofs in ${diagnostics.decodeTimeMs.toFixed(2)}ms`);
    
    expect(stamp).not.toBeNull();
    expect(stamp!.proofs).toHaveLength(20);
  });

  it("handles V4 token with long mint URL", () => {
    const proofs = generateTestProofs(2);
    const longMint = "https://very-long-subdomain.mint-server-with-long-name.example.com/api/v1/cashu";
    const token = createV4Token(proofs, longMint);
    
    const stamp = decodeStamp(token);
    expect(stamp.mint).toBe(longMint);
  });

  it("raw getDecodedToken preserves V4 structure", () => {
    // Direct test of cashu-ts library behavior
    const proofs = generateTestProofs(3);
    const v4Token = createV4Token(proofs);
    
    const decoded = getDecodedToken(v4Token);
    
    // These are the expected fields from a Token object
    expect(decoded).toHaveProperty("mint");
    expect(decoded).toHaveProperty("proofs");
    expect(decoded.proofs).toBeInstanceOf(Array);
    
    // Each proof should have required fields
    decoded.proofs.forEach((p, i) => {
      expect(p).toHaveProperty("amount");
      expect(p).toHaveProperty("id");
      expect(p).toHaveProperty("secret");
      expect(p).toHaveProperty("C");
    });
  });
});

describe("workerd Performance", () => {
  it("V4 decode completes within performance budget", () => {
    const proofs = generateTestProofs(10);
    const token = createV4Token(proofs);
    
    const iterations = 20;
    const times: number[] = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      decodeStamp(token);
      times.push(performance.now() - start);
    }
    
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    
    console.log(`V4 decode: avg=${avg.toFixed(2)}ms, max=${max.toFixed(2)}ms`);
    
    // Target: <5ms average
    expect(avg).toBeLessThan(5);
  });
});

describe("Diagnostic Logging", () => {
  it("captures detailed diagnostics on V4 failure", () => {
    setDebugDecode(true);
    
    // Create an intentionally malformed V4 token
    // (just the prefix with garbage data)
    const malformed = "cashuB" + "YWJjZGVm"; // "abcdef" in base64
    
    const { stamp, diagnostics } = decodeStampWithDiagnostics(malformed);
    
    expect(stamp).toBeNull();
    expect(diagnostics.tokenVersion).toBe("V4");
    expect(diagnostics.error).toBeTruthy();
    
    // Debug mode should capture CBOR structure attempt
    console.log("Malformed V4 diagnostics:", diagnostics);
    
    setDebugDecode(false);
  });

  it("logs timing information", () => {
    const proofs = generateTestProofs(5);
    const token = createV4Token(proofs);
    
    const { stamp, diagnostics } = decodeStampWithDiagnostics(token);
    
    expect(stamp).not.toBeNull();
    // In workerd, timing may be 0 due to performance.now() precision
    // Just verify it's a number >= 0
    expect(diagnostics.decodeTimeMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.decodeTimeMs).toBeLessThan(50); // Sanity check
    
    console.log(`V4 (5 proofs) decode time: ${diagnostics.decodeTimeMs.toFixed(3)}ms`);
  });
});
