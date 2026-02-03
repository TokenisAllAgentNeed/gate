/**
 * Error path tests for melt.ts — meltProofs() error handling.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  storeProofs,
  listAllProofs,
  getBalance,
  type StoredProof,
} from "../ecash-store.js";
import { meltProofs } from "../melt.js";
import { createMockKV } from "./helpers.js";

const MINT_URL = "https://melt-err-mint.example";
const WALLET_ADDRESS = "0xmeltErrorTest";

function makeProofs(amounts: number[]): StoredProof[] {
  return amounts.map((amount, i) => ({
    amount,
    id: "009a1f293253e41e",
    secret: `secret_${i}_${Math.random().toString(36).slice(2)}`,
    C: "02" + "ab".repeat(32),
  }));
}

describe("meltProofs error paths", () => {
  let kv: KVNamespace;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    kv = createMockKV();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 400 when KV has no proofs", async () => {
    // Empty KV — no proofs stored
    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/no proofs/i);
    }
  });

  it("returns 400 when proofs have zero total balance", async () => {
    // Store proofs with zero amount
    await storeProofs(kv, MINT_URL, makeProofs([0, 0, 0]));

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/no balance/i);
    }
  });

  it("returns 502 when melt quote request fails", async () => {
    await storeProofs(kv, MINT_URL, makeProofs([100, 200]));

    globalThis.fetch = async (input: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/melt/quote")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return originalFetch(input);
    };

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toMatch(/quote failed/i);
    }

    // Original proofs should still be in KV (no deletion on failure)
    const balance = await getBalance(kv);
    expect(balance).toBe(300);
  });

  it("returns 502 when melt transfer request fails", async () => {
    await storeProofs(kv, MINT_URL, makeProofs([100, 200]));

    globalThis.fetch = async (input: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/melt/quote")) {
        return new Response(
          JSON.stringify({ quote: "q-err", amount_sats: 300, fee_sats: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1/melt") && !url.includes("quote")) {
        return new Response("Gateway Timeout", { status: 504 });
      }
      return originalFetch(input);
    };

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toMatch(/transfer failed/i);
    }

    // Original proofs should still be in KV
    const balance = await getBalance(kv);
    expect(balance).toBe(300);
  });

  it("preserves change proofs when melt succeeds with change", async () => {
    await storeProofs(kv, MINT_URL, makeProofs([256]));

    const changeProofs = [
      { amount: 32, id: "009a1f293253e41e", C: "02" + "cc".repeat(32), secret: "change_1" },
    ];

    globalThis.fetch = async (input: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/melt/quote")) {
        return new Response(
          JSON.stringify({ quote: "q-change", amount_sats: 224, fee_sats: 32 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1/melt") && !url.includes("quote")) {
        return new Response(
          JSON.stringify({ paid: true, tx_hash: "0xchange", change: changeProofs }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.change_units).toBe(32);

    // After melt: only change proofs remain
    const remaining = await listAllProofs(kv);
    expect(remaining.length).toBe(1);
    const balance = await getBalance(kv);
    expect(balance).toBe(32);
  });

  it("handles melt result with paid=false — no KV changes", async () => {
    await storeProofs(kv, MINT_URL, makeProofs([100]));

    globalThis.fetch = async (input: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/melt/quote")) {
        return new Response(
          JSON.stringify({ quote: "q-unpaid", amount_sats: 100, fee_sats: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1/melt") && !url.includes("quote")) {
        return new Response(
          JSON.stringify({ paid: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.melted).toBe(false);

    // Proofs unchanged
    const balance = await getBalance(kv);
    expect(balance).toBe(100);
  });

  it("returns correct fields on successful melt without change", async () => {
    await storeProofs(kv, MINT_URL, makeProofs([64, 32]));

    globalThis.fetch = async (input: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/melt/quote")) {
        return new Response(
          JSON.stringify({ quote: "q-full", amount_sats: 96, fee_sats: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1/melt") && !url.includes("quote")) {
        return new Response(
          JSON.stringify({ paid: true, tx_hash: "0xfull" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    const result = await meltProofs({ kv, mintUrl: MINT_URL, walletAddress: WALLET_ADDRESS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.melted).toBe(true);
    expect(result.amount_units).toBe(96);
    expect(result.tx_hash).toBe("0xfull");
    expect(result.address).toBe(WALLET_ADDRESS);
    expect(result.change_units).toBe(0);

    // KV fully cleared
    const balance = await getBalance(kv);
    expect(balance).toBe(0);
  });
});
