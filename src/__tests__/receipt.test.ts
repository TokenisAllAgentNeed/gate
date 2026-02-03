/**
 * Unit tests for lib/receipt.ts — createReceipt().
 */
import { describe, it, expect } from "vitest";
import { createReceipt } from "../lib/receipt.js";
import type { Stamp } from "../lib/types.js";
import type { Proof, Token } from "@cashu/cashu-ts";

// ── Helpers ──────────────────────────────────────────────────────

function makeProof(amount: number, secret?: string): Proof {
  return {
    amount,
    id: "009a1f293253e41e",
    secret: secret ?? `secret_${Math.random().toString(36).slice(2)}`,
    C: "02" + "ab".repeat(32),
  } as Proof;
}

function makeStamp(amounts: number[], secrets?: string[]): Stamp {
  const proofs = amounts.map((a, i) => makeProof(a, secrets?.[i]));
  return {
    raw: "cashuBtesttoken",
    token: { mint: "https://mint.test.com", proofs } as unknown as Token,
    mint: "https://mint.test.com",
    amount: amounts.reduce((s, a) => s + a, 0),
    proofs,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("createReceipt", () => {
  it("returns a valid Receipt with all required fields", async () => {
    const stamp = makeStamp([100, 200]);
    const receipt = await createReceipt(stamp, "gpt-4o", 300);

    expect(receipt.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(receipt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(receipt.amount).toBe(300);
    expect(receipt.unit).toBe("usd");
    expect(receipt.model).toBe("gpt-4o");
    expect(receipt.token_hash).toHaveLength(16); // truncated hex
    expect(receipt.token_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("uses the provided amount, not the stamp total", async () => {
    const stamp = makeStamp([500]);
    const receipt = await createReceipt(stamp, "claude-sonnet-4", 200);

    // Stamp has 500 but receipt should show 200 (actual price charged)
    expect(receipt.amount).toBe(200);
  });

  it("generates unique IDs for different calls", async () => {
    const stamp = makeStamp([100]);
    const r1 = await createReceipt(stamp, "gpt-4o", 100);
    const r2 = await createReceipt(stamp, "gpt-4o", 100);

    expect(r1.id).not.toBe(r2.id);
  });

  it("produces deterministic hash for same proof secrets", async () => {
    const stamp1 = makeStamp([100], ["fixed_secret_1"]);
    const stamp2 = makeStamp([100], ["fixed_secret_1"]);

    const r1 = await createReceipt(stamp1, "gpt-4o", 100);
    const r2 = await createReceipt(stamp2, "gpt-4o", 100);

    expect(r1.token_hash).toBe(r2.token_hash);
  });

  it("produces different hashes for different secrets", async () => {
    const stamp1 = makeStamp([100], ["secret_a"]);
    const stamp2 = makeStamp([100], ["secret_b"]);

    const r1 = await createReceipt(stamp1, "gpt-4o", 100);
    const r2 = await createReceipt(stamp2, "gpt-4o", 100);

    expect(r1.token_hash).not.toBe(r2.token_hash);
  });

  it("handles single proof", async () => {
    const stamp = makeStamp([42]);
    const receipt = await createReceipt(stamp, "test-model", 42);

    expect(receipt.amount).toBe(42);
    expect(receipt.token_hash).toHaveLength(16);
  });

  it("concatenates multiple proof secrets with | separator", async () => {
    // Two stamps with same secrets but different order should produce different hashes
    const stamp1 = makeStamp([100, 200], ["alpha", "beta"]);
    const stamp2 = makeStamp([200, 100], ["beta", "alpha"]);

    const r1 = await createReceipt(stamp1, "m", 300);
    const r2 = await createReceipt(stamp2, "m", 300);

    expect(r1.token_hash).not.toBe(r2.token_hash);
  });

  it("handles proof with non-string secret (object)", async () => {
    const stamp = makeStamp([100]);
    // Some Cashu proofs have object secrets (P2PK)
    (stamp.proofs[0] as any).secret = ["P2PK", { data: "pubkey123" }];

    const receipt = await createReceipt(stamp, "gpt-4o", 100);

    expect(receipt.token_hash).toHaveLength(16);
    expect(receipt.token_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles zero amount", async () => {
    const stamp = makeStamp([100]);
    const receipt = await createReceipt(stamp, "free-model", 0);

    expect(receipt.amount).toBe(0);
    expect(receipt.unit).toBe("usd");
  });
});
