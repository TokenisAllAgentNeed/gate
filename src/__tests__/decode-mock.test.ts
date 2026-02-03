/**
 * Tests for lib/decode.ts — missing mint and no proofs paths.
 *
 * Uses vi.mock to override getDecodedToken at module level,
 * which is required for ES module imports.
 */
import { describe, test, expect, vi } from "vitest";

const mockGetDecodedToken = vi.fn();

vi.mock("@cashu/cashu-ts", () => ({
  getDecodedToken: (...args: any[]) => mockGetDecodedToken(...args),
}));

// Import after mocks
import { decodeStamp, decodeStampWithDiagnostics } from "../lib/decode.js";

describe("decodeStampWithDiagnostics — missing mint", () => {
  test("reports missing mint URL when token decodes but has no mint", () => {
    mockGetDecodedToken.mockReturnValue({
      mint: "",
      proofs: [{ amount: 100, id: "test", secret: "s", C: "c" }],
    });

    const result = decodeStampWithDiagnostics("cashuBfaketoken");
    expect(result.stamp).toBeNull();
    expect(result.diagnostics.error).toBe("Missing mint URL");
    expect(result.diagnostics.proofCount).toBe(1);
  });
});

describe("decodeStampWithDiagnostics — no proofs", () => {
  test("reports no proofs when token decodes but has empty proofs", () => {
    mockGetDecodedToken.mockReturnValue({
      mint: "https://mint.test",
      proofs: [],
    });

    const result = decodeStampWithDiagnostics("cashuBfaketoken");
    expect(result.stamp).toBeNull();
    expect(result.diagnostics.error).toBe("No proofs");
    expect(result.diagnostics.proofCount).toBe(0);
  });

  test("reports no proofs when proofs is undefined", () => {
    mockGetDecodedToken.mockReturnValue({
      mint: "https://mint.test",
      proofs: undefined,
    });

    const result = decodeStampWithDiagnostics("cashuBfaketoken");
    expect(result.stamp).toBeNull();
    expect(result.diagnostics.error).toBe("No proofs");
  });
});

describe("decodeStamp — missing mint and no proofs", () => {
  test("throws on missing mint URL", () => {
    mockGetDecodedToken.mockReturnValue({
      mint: "",
      proofs: [{ amount: 100, id: "test", secret: "s", C: "c" }],
    });

    expect(() => decodeStamp("cashuBfaketoken")).toThrow("missing mint URL");
  });

  test("throws on no proofs", () => {
    mockGetDecodedToken.mockReturnValue({
      mint: "https://mint.test",
      proofs: [],
    });

    expect(() => decodeStamp("cashuBfaketoken")).toThrow("no proofs");
  });
});
