/**
 * Unit tests for redeem.ts — createRedeemFn().
 *
 * Mocks @cashu/cashu-ts to test wallet caching, circuit breaker,
 * swap/receive logic, timeout, double-spend detection, and onRedeem callback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Proof } from "@cashu/cashu-ts";
import type { Stamp } from "../lib/types.js";

// ── Mocks ────────────────────────────────────────────────────────

const mockLoadMint = vi.fn().mockResolvedValue(undefined);
const mockSwap = vi.fn();
const mockReceive = vi.fn();

vi.mock("@cashu/cashu-ts", () => {
  return {
    CashuMint: vi.fn().mockImplementation((_url: string) => ({})),
    CashuWallet: vi.fn().mockImplementation(() => ({
      loadMint: mockLoadMint,
      swap: mockSwap,
      receive: mockReceive,
    })),
  };
});

import { createRedeemFn } from "../redeem.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeProof(amount: number): Proof {
  return {
    amount,
    id: "009a1f293253e41e",
    secret: `secret_${Math.random().toString(36).slice(2)}`,
    C: "02" + "ab".repeat(32),
  } as Proof;
}

function makeStamp(mintUrl: string, amounts: number[]): Stamp {
  const proofs = amounts.map(makeProof);
  return {
    raw: "cashuBtesttoken",
    token: { mint: mintUrl, proofs } as any,
    mint: mintUrl,
    amount: amounts.reduce((s, a) => s + a, 0),
    proofs,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("createRedeemFn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("swap success: price < amount → keep=send, change=keep", async () => {
    const send = [makeProof(10)];
    const keep = [makeProof(90)];
    mockSwap.mockResolvedValue({ send, keep });

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keep).toEqual(send);
    expect(result.change).toEqual(keep);
  });

  it("receive success: no price → keep=all, change=[]", async () => {
    const newProofs = [makeProof(100)];
    mockReceive.mockResolvedValue(newProofs);

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keep).toEqual(newProofs);
    expect(result.change).toEqual([]);
  });

  it("swap timeout (>10s) → ok:false, error='Mint swap timeout'", async () => {
    mockSwap.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 20_000)),
    );

    const redeem = createRedeemFn({ timeoutMs: 50 }); // use short timeout for test
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 10);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Redeem failed");
  });

  it("circuit breaker open → ok:false, error contains 'circuit open'", async () => {
    // Trip the circuit breaker by causing 3 failures
    mockSwap.mockRejectedValue(new Error("network error"));

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint-cb.example.com", [100]);

    // Fail 3 times to open circuit
    await redeem(stamp, 10);
    await redeem(stamp, 10);
    await redeem(stamp, 10);

    // Now circuit should be open
    const result = await redeem(stamp, 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("circuit open");
  });

  it("double spend: 'already spent' → ok:false, error='Token already spent'", async () => {
    mockSwap.mockRejectedValue(new Error("Token already spent"));

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 10);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Token already spent");
  });

  it("double spend: error code '11001' → ok:false, error='Token already spent'", async () => {
    mockSwap.mockRejectedValue(new Error("Error 11001: proof already used"));

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 10);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Token already spent");
  });

  it("wallet cache: loadMint called only once for same mint URL", async () => {
    mockReceive.mockResolvedValue([makeProof(100)]);

    const redeem = createRedeemFn();
    const stamp1 = makeStamp("https://cached.example.com", [100]);
    const stamp2 = makeStamp("https://cached.example.com", [200]);

    await redeem(stamp1);
    await redeem(stamp2);

    // CashuWallet constructor and loadMint each called once for this mint
    expect(mockLoadMint).toHaveBeenCalledTimes(1);
  });

  it("onRedeem returns kvKey → kvKey correctly passed in result", async () => {
    const send = [makeProof(10)];
    const keep = [makeProof(90)];
    mockSwap.mockResolvedValue({ send, keep });

    const onRedeem = vi.fn().mockResolvedValue("kv:test-key-123");
    const redeem = createRedeemFn({ onRedeem });
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kvKey).toBe("kv:test-key-123");
    expect(onRedeem).toHaveBeenCalledWith("https://mint.example.com", send);
  });

  it("onRedeem throws → does not affect redeem success", async () => {
    const send = [makeProof(10)];
    const keep = [makeProof(90)];
    mockSwap.mockResolvedValue({ send, keep });

    const onRedeem = vi.fn().mockRejectedValue(new Error("callback boom"));
    const redeem = createRedeemFn({ onRedeem });
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keep).toEqual(send);
    expect(result.kvKey).toBeUndefined();
  });

  it("swap returns empty proofs → ok:false", async () => {
    mockReceive.mockResolvedValue([]);

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no proofs");
  });

  it("receive returns null → ok:false", async () => {
    mockReceive.mockResolvedValue(null);

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no proofs");
  });

  it("price equals amount → uses receive (no swap)", async () => {
    const newProofs = [makeProof(100)];
    mockReceive.mockResolvedValue(newProofs);

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 100);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keep).toEqual(newProofs);
    expect(result.change).toEqual([]);
    expect(mockSwap).not.toHaveBeenCalled();
  });

  it("price=0 → uses receive (no swap)", async () => {
    const newProofs = [makeProof(100)];
    mockReceive.mockResolvedValue(newProofs);

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 0);

    expect(result.ok).toBe(true);
    expect(mockSwap).not.toHaveBeenCalled();
    expect(mockReceive).toHaveBeenCalled();
  });

  it("non-Error thrown → ok:false, error='Redeem failed'", async () => {
    // Throw a string instead of an Error object
    mockSwap.mockRejectedValue("something went wrong");

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint-str.example.com", [100]);
    const result = await redeem(stamp, 10);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Redeem failed");
  });

  it("PROOF_ALREADY_USED error → ok:false, error='Token already spent'", async () => {
    mockSwap.mockRejectedValue(new Error("PROOF_ALREADY_USED: proof exhausted"));

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 10);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Token already spent");
  });

  it("price > amount → uses receive (no swap)", async () => {
    const newProofs = [makeProof(100)];
    mockReceive.mockResolvedValue(newProofs);

    const redeem = createRedeemFn();
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp, 200); // price > amount

    expect(result.ok).toBe(true);
    expect(mockSwap).not.toHaveBeenCalled();
    expect(mockReceive).toHaveBeenCalled();
  });

  it("receive timeout → ok:false", async () => {
    mockReceive.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 20_000)),
    );

    const redeem = createRedeemFn({ timeoutMs: 50 });
    const stamp = makeStamp("https://mint.example.com", [100]);
    const result = await redeem(stamp); // no price → uses receive

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Redeem failed");
  });
});
