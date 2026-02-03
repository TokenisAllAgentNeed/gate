import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  storeProofs,
  type StoredProof,
} from "../ecash-store.js";
import { createMockKV } from "./helpers.js";

function makeProofs(amounts: number[]): StoredProof[] {
  return amounts.map((amount, i) => ({
    amount,
    id: "009a1f293253e41e",
    secret: `secret_${i}`,
    C: "02" + "ab".repeat(32),
  }));
}

/**
 * Build a minimal Hono app with just the gate endpoints for isolated testing.
 * We import the real ecash-store functions and wire them up the same way worker.ts does.
 */
async function buildGateApp(kv: KVNamespace) {
  const {
    getBalance,
    listAllProofs,
    deleteKeys,
  } = await import("../ecash-store.js");

  type Bindings = { ECASH_STORE?: KVNamespace; MINT_URL?: string; GATE_WALLET_ADDRESS?: string };
  const app = new Hono<{ Bindings: Bindings }>();

  app.get("/v1/gate/balance", async (c) => {
    const store = c.env.ECASH_STORE;
    if (!store) return c.json({ error: "ECASH_STORE KV not configured" }, 500);
    const balance = await getBalance(store);
    return c.json({ balance_units: balance, unit: "usd" });
  });

  // Simplified melt for testing — we mock fetch inside tests
  app.post("/v1/gate/melt", async (c) => {
    const store = c.env.ECASH_STORE;
    if (!store) return c.json({ error: "ECASH_STORE KV not configured" }, 500);
    const mintUrl = c.env.MINT_URL ?? "https://mint.token2chat.com";
    const address = c.env.GATE_WALLET_ADDRESS ?? "0xcccccccccccccccccccccccccccccccccccccccc";

    const entries = await listAllProofs(store);
    if (entries.length === 0) {
      return c.json({ error: "No proofs to melt" }, 400);
    }

    const allProofs = entries.flatMap((e) => e.proofs);
    const totalSats = allProofs.reduce((s, p) => s + p.amount, 0);

    // Request melt quote
    const quoteRes = await fetch(`${mintUrl}/v1/melt/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: totalSats, address, chain: "base" }),
    });
    if (!quoteRes.ok) {
      const err = await quoteRes.text();
      return c.json({ error: `Melt quote failed: ${err}` }, 502);
    }
    const quote = (await quoteRes.json()) as any;

    // Submit melt
    const meltRes = await fetch(`${mintUrl}/v1/melt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: quote.quote, inputs: allProofs }),
    });
    if (!meltRes.ok) {
      const err = await meltRes.text();
      return c.json({ error: `Melt failed: ${err}` }, 502);
    }
    const meltResult = (await meltRes.json()) as any;

    if (meltResult.paid) {
      await deleteKeys(store, entries.map((e) => e.key));
    }

    return c.json({
      melted: meltResult.paid,
      amount_units: totalSats,
      tx_hash: meltResult.tx_hash ?? null,
      address,
    });
  });

  return app;
}

describe("GET /v1/gate/balance", () => {
  it("should return 0 when no proofs stored", async () => {
    const kv = createMockKV();
    const app = await buildGateApp(kv);
    const res = await app.request("/v1/gate/balance", {}, { ECASH_STORE: kv });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance_units).toBe(0);
    expect(body.unit).toBe("usd");
  });

  it("should return total balance across multiple entries", async () => {
    const kv = createMockKV();
    await storeProofs(kv, "https://mint.example.com", makeProofs([100, 200]));
    await storeProofs(kv, "https://mint.example.com", makeProofs([500]));

    const app = await buildGateApp(kv);
    const res = await app.request("/v1/gate/balance", {}, { ECASH_STORE: kv });
    const body = await res.json();
    expect(body.balance_units).toBe(800);
  });
});

describe("POST /v1/gate/melt", () => {
  it("should return 400 when no proofs to melt", async () => {
    const kv = createMockKV();
    const app = await buildGateApp(kv);
    const res = await app.request(
      "/v1/gate/melt",
      { method: "POST" },
      { ECASH_STORE: kv },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No proofs/);
  });

  it("should melt proofs and clear KV on success", async () => {
    const kv = createMockKV();
    await storeProofs(kv, "https://mint.token2chat.com", makeProofs([100, 200]));

    // Mock global fetch for mint API calls
    const originalFetch = globalThis.fetch;
    let fetchCalls: { url: string; body: any }[] = [];
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const body = init?.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body });

      if (url.includes("/v1/melt/quote")) {
        return new Response(
          JSON.stringify({ quote: "q-123", amount_sats: 300, fee_sats: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1/melt") && !url.includes("quote")) {
        return new Response(
          JSON.stringify({ paid: true, tx_hash: "0xabc123" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    try {
      const app = await buildGateApp(kv);
      const res = await app.request(
        "/v1/gate/melt",
        { method: "POST" },
        {
          ECASH_STORE: kv,
          MINT_URL: "https://mint.token2chat.com",
          GATE_WALLET_ADDRESS: "0xcccccccccccccccccccccccccccccccccccccccc",
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.melted).toBe(true);
      expect(body.amount_units).toBe(300);
      expect(body.tx_hash).toBe("0xabc123");
      expect(body.address).toBe("0xcccccccccccccccccccccccccccccccccccccccc");

      // Verify melt quote was called with correct params
      expect(fetchCalls[0].url).toContain("/v1/melt/quote");
      expect(fetchCalls[0].body.amount).toBe(300);
      expect(fetchCalls[0].body.address).toBe("0xcccccccccccccccccccccccccccccccccccccccc");

      // Verify proofs were sent to melt
      expect(fetchCalls[1].url).toContain("/v1/melt");
      expect(fetchCalls[1].body.inputs).toHaveLength(2);

      // Verify KV was cleared
      const { getBalance: gb } = await import("../ecash-store.js");
      expect(await gb(kv)).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should return 502 when melt quote fails", async () => {
    const kv = createMockKV();
    await storeProofs(kv, "https://mint.token2chat.com", makeProofs([100]));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response("Mint down", { status: 500 });
    }) as any;

    try {
      const app = await buildGateApp(kv);
      const res = await app.request(
        "/v1/gate/melt",
        { method: "POST" },
        { ECASH_STORE: kv },
      );
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toMatch(/Melt quote failed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
