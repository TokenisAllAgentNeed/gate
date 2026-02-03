/**
 * Bug 2: melt.ts on-chain melt doesn't handle change proofs
 *
 * The /v1/melt response may contain a `change` field with overpayment proofs.
 * Currently meltProofs() ignores this, losing those proofs.
 *
 * Fix: Parse change from response, store to KV before deleting old keys,
 * and include change_sats in the return value.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  storeProofs,
  listAllProofs,
  getBalance,
  type StoredProof,
} from "../ecash-store.js";
import { meltProofs } from "../melt.js";
import { createMockKV } from "./helpers.js";

const MINT_URL = "https://melt-test-mint.example";
const WALLET_ADDRESS = "0xmelttest";

function makeProofs(amounts: number[]): StoredProof[] {
  return amounts.map((amount, i) => ({
    amount,
    id: "009a1f293253e41e",
    secret: `secret_${i}_${Math.random().toString(36).slice(2)}`,
    C: "02" + "ab".repeat(32),
  }));
}

// ── Tests ─────────────────────────────────────────────────────

describe("Bug 2: melt.ts should handle change proofs from /v1/melt response", () => {
  let kv: KVNamespace;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    kv = createMockKV();
    originalFetch = globalThis.fetch;
    // Pre-store some proofs to be melted
    await storeProofs(kv, MINT_URL, makeProofs([100, 200, 64]));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("melt with change → change proofs stored in KV, old proofs deleted", async () => {
    const changeProofs = [
      { amount: 16, id: "009a1f293253e41e", C: "02" + "ee".repeat(32), secret: "change_secret_1" },
      { amount: 8, id: "009a1f293253e41e", C: "02" + "ff".repeat(32), secret: "change_secret_2" },
    ];

    // Mock fetch to return successful melt quote + melt with change
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/v1/melt/quote")) {
        return new Response(
          JSON.stringify({ quote: "quote-123", amount_sats: 340, fee_sats: 24 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/v1/melt") && !url.includes("quote")) {
        return new Response(
          JSON.stringify({ paid: true, tx_hash: "0xabc123", change: changeProofs }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return originalFetch(input, init);
    };

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.melted).toBe(true);
    expect(result.tx_hash).toBe("0xabc123");

    // Change sats should be reported
    expect(result.change_units).toBe(24); // 16 + 8

    // KV should have the change proofs stored (old ones deleted)
    const entries = await listAllProofs(kv);
    expect(entries.length).toBe(1); // one entry for change proofs

    const balance = await getBalance(kv);
    expect(balance).toBe(24); // only change proofs remain
  });

  it("melt without change → normal behavior, KV cleared", async () => {
    // Mock fetch: no change field in response
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/v1/melt/quote")) {
        return new Response(
          JSON.stringify({ quote: "quote-456", amount_sats: 364, fee_sats: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/v1/melt") && !url.includes("quote")) {
        return new Response(
          JSON.stringify({ paid: true, tx_hash: "0xdef456" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return originalFetch(input, init);
    };

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.melted).toBe(true);
    expect(result.change_units).toBe(0);

    // KV should be fully cleared (no change proofs to store)
    const entries = await listAllProofs(kv);
    expect(entries.length).toBe(0);

    const balance = await getBalance(kv);
    expect(balance).toBe(0);
  });

  it("melt not paid → KV unchanged (no deletion)", async () => {
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/v1/melt/quote")) {
        return new Response(
          JSON.stringify({ quote: "quote-789", amount_sats: 364, fee_sats: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/v1/melt") && !url.includes("quote")) {
        return new Response(
          JSON.stringify({ paid: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return originalFetch(input, init);
    };

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.melted).toBe(false);

    // KV should still have original proofs (nothing deleted)
    const balance = await getBalance(kv);
    expect(balance).toBe(364); // 100 + 200 + 64
  });
});
