/**
 * Bug 1: Refund path dirty proofs
 *
 * When upstream fails, the handler refunds keep+change proofs to the user.
 * But onRedeem has already stored keep proofs in KV. After refund, the user
 * spends those proofs, but KV still has them → dirty/phantom balance.
 *
 * Fix: On refund, delete the stored keep proofs from KV.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { decodeStamp } from "../lib/index.js";
import type { Stamp } from "../lib/types.js";
import type { RedeemResult } from "../redeem.js";
import { createGateApp, type GateAppConfig } from "../create-app.js";
import { listAllProofs, getBalance } from "../ecash-store.js";
import { createMockKV } from "./helpers.js";

const MINT_URL = "https://refund-test-mint.example";
const PRICE = 200;
const ADMIN_TOKEN = "test-admin-token";
const WALLET_ADDRESS = "0xdeadbeef";

function makeFakeToken(amount: number): string {
  return getEncodedTokenV4({
    mint: MINT_URL,
    proofs: [
      {
        amount,
        id: "009a1f293253e41e",
        secret: `secret_${Math.random().toString(36).slice(2)}`,
        C: "02" + "ab".repeat(32),
      },
    ],
    unit: "usd",
  });
}

function mockProofs(amount: number): Proof[] {
  const proofs: Proof[] = [];
  let remaining = amount;
  for (let bit = 1 << 20; bit >= 1; bit >>= 1) {
    if (remaining >= bit) {
      proofs.push({
        amount: bit,
        id: "009a1f293253e41e",
        secret: `mock_${bit}_${Math.random().toString(36).slice(2)}`,
        C: "02" + "cd".repeat(32),
      });
      remaining -= bit;
    }
  }
  return proofs;
}

/**
 * Create a redeemFn that stores keep proofs in the given KV via storeProofs
 * (mimicking the real onRedeem behavior), then returns kvKey.
 */
function createKVRedeemFn(kv: KVNamespace) {
  return async (stamp: Stamp, price?: number): Promise<RedeemResult> => {
    const keepAmount = price && price > 0 && price < stamp.amount ? price : stamp.amount;
    const changeAmount = stamp.amount - keepAmount;
    const keep = mockProofs(keepAmount);
    const change = changeAmount > 0 ? mockProofs(changeAmount) : [];

    // Simulate onRedeem: store keep proofs in KV (just like the real code)
    const { storeProofs } = await import("../ecash-store.js");
    const kvKey = await storeProofs(kv, stamp.mint, keep);

    return { ok: true, keep, change, kvKey };
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("Bug 1: Refund path should clean up stored keep proofs", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("upstream error → X-Cashu-Refund exists AND KV keep proofs are deleted", async () => {
    const app = createGateApp({
      trustedMints: [MINT_URL],
      upstreams: [
        {
          match: "*",
          baseUrl: "http://fake-upstream.test",
          apiKey: "fake-key",
        },
      ],
      pricing: [{ model: "*", mode: "per_request" as const, per_request: PRICE }],
      kvStore: kv,
      adminToken: ADMIN_TOKEN,
      walletAddress: WALLET_ADDRESS,
      redeemFn: createKVRedeemFn(kv),
    });

    // Verify KV is initially empty
    expect(await getBalance(kv)).toBe(0);

    const token = makeFakeToken(300); // overpay by 100

    // Mock global fetch to simulate upstream failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("fake-upstream.test")) {
        return new Response(
          JSON.stringify({ error: { message: "Internal Server Error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    };

    try {
      const res = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cashu": token,
          },
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "Hello" }],
          }),
        }),
      );

      // Should get an error response with refund
      expect(res.status).toBeGreaterThanOrEqual(400);
      const refundHeader = res.headers.get("X-Cashu-Refund");
      expect(refundHeader).toBeTruthy();

      // Refund should contain all proofs (keep + change = 300)
      const refundStamp = decodeStamp(refundHeader!);
      expect(refundStamp.amount).toBe(300);

      // KEY ASSERTION: KV should be empty after refund
      // The keep proofs that were stored during onRedeem should be deleted
      const balance = await getBalance(kv);
      expect(balance).toBe(0);

      const entries = await listAllProofs(kv);
      expect(entries).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("upstream success → KV keep proofs should remain (not deleted)", async () => {
    const app = createGateApp({
      trustedMints: [MINT_URL],
      upstreams: [
        {
          match: "*",
          baseUrl: "http://fake-upstream-ok.test",
          apiKey: "fake-key",
        },
      ],
      pricing: [{ model: "*", mode: "per_request" as const, per_request: PRICE }],
      kvStore: kv,
      adminToken: ADMIN_TOKEN,
      walletAddress: WALLET_ADDRESS,
      redeemFn: createKVRedeemFn(kv),
    });

    const token = makeFakeToken(200);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("fake-upstream-ok.test")) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-ok",
            choices: [{ message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    };

    try {
      const res = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cashu": token,
          },
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "Hello" }],
          }),
        }),
      );

      expect(res.status).toBe(200);

      // KV should still have the keep proofs (200 sats)
      const balance = await getBalance(kv);
      expect(balance).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
