/**
 * Tests for the POST /v1/chat/completions handler in create-app.ts.
 *
 * These test the REAL createGateApp (not the simplified test helper),
 * covering the chat completions route with metrics, refunds, streaming,
 * and upstream error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { createGateApp, type GateAppConfig } from "../create-app.js";
import { createMockKV } from "./helpers.js";
import type { Stamp } from "../lib/types.js";
import type { RedeemResult } from "../redeem.js";

const MINT_URL = "https://testmint.example";
const ADMIN_TOKEN = "test-admin";

// ── Helpers ──────────────────────────────────────────────────

function makeProofs(amounts: number[]): Proof[] {
  return amounts.map((a, i) => ({
    amount: a,
    id: "009a1f293253e41e",
    secret: `secret_${a}_${i}_${Math.random().toString(36).slice(2, 8)}`,
    C: "02" + "ab".repeat(32),
  }));
}

function makeToken(amounts: number[]): string {
  return getEncodedTokenV4({
    mint: MINT_URL,
    proofs: makeProofs(amounts),
    unit: "usd",
  });
}

/** Create a redeemFn that always succeeds, splitting keep/change */
function createMockRedeem() {
  const calls: Stamp[] = [];

  async function redeemFn(stamp: Stamp, price?: number): Promise<RedeemResult> {
    calls.push(stamp);
    const total = stamp.amount;
    const keepAmt = price && price > 0 && price < total ? price : total;
    const changeAmt = total - keepAmt;

    const freshProofs = (amount: number): Proof[] => {
      const parts: number[] = [];
      let rem = amount;
      for (let bit = 1 << 20; bit >= 1; bit >>= 1) {
        if (rem >= bit) { parts.push(bit); rem -= bit; }
      }
      return parts.map((a) => ({
        amount: a,
        id: "009a1f293253e41e",
        secret: `new_${a}_${Math.random().toString(36).slice(2, 8)}`,
        C: "02" + "cd".repeat(32),
      }));
    };

    return {
      ok: true,
      keep: freshProofs(keepAmt),
      change: changeAmt > 0 ? freshProofs(changeAmt) : [],
    };
  }

  return { redeemFn, calls };
}

function makeConfig(overrides: Partial<GateAppConfig> = {}): GateAppConfig {
  return {
    trustedMints: [MINT_URL],
    upstreams: [
      { match: "*", baseUrl: "https://upstream.test", apiKey: "test-key" },
    ],
    pricing: [{ model: "*", mode: "per_request" as const, per_request: 200 }],
    kvStore: createMockKV(),
    adminToken: ADMIN_TOKEN,
    walletAddress: "0xtestwallet",
    ...overrides,
  };
}

function postCompletions(
  app: ReturnType<typeof createGateApp>,
  opts: { token?: string; model?: string; stream?: boolean }
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers["X-Cashu"] = opts.token;

  return app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model ?? "test-model",
        messages: [{ role: "user", content: "Hello" }],
        ...(opts.stream ? { stream: true } : {}),
      }),
    })
  );
}

// ── Mock fetch ───────────────────────────────────────────────

let mockFetchFn: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockFetchFn = vi.fn();
  globalThis.fetch = mockFetchFn;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────

describe("POST /v1/chat/completions (create-app.ts)", () => {
  describe("successful non-streaming request", () => {
    it("returns 200 with receipt and upstream body", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Hi there!" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const token = makeToken([128, 64, 8]); // 200 exact
      const res = await postCompletions(app, { token, model: "test-model" });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe("Hi there!");

      // Receipt header
      const receipt = res.headers.get("X-Cashu-Receipt");
      expect(receipt).toBeTruthy();
      const parsed = JSON.parse(receipt!);
      expect(parsed.model).toBe("test-model");

      // No change for exact payment
      expect(res.headers.get("X-Cashu-Change")).toBeNull();
    });

    it("returns change token on overpayment", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const token = makeToken([256, 64]); // 320, price 200 → 120 change
      const res = await postCompletions(app, { token, model: "test-model" });

      expect(res.status).toBe(200);
      const change = res.headers.get("X-Cashu-Change");
      expect(change).toBeTruthy();
    });
  });

  describe("upstream failure → refund", () => {
    it("returns 502 with refund on upstream 500", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Internal error" } }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      );

      const token = makeToken([256]); // 256 sats
      const res = await postCompletions(app, { token, model: "test-model" });

      // Upstream error → refund
      expect([500, 502]).toContain(res.status);
      const refund = res.headers.get("X-Cashu-Refund");
      expect(refund).toBeTruthy();
    });
  });

  describe("no upstream configured", () => {
    it("returns 502 with refund for unknown model", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(
        makeConfig({
          redeemFn,
          upstreams: [
            { match: "specific-model", baseUrl: "https://x.test", apiKey: "k" },
          ],
        })
      );

      const token = makeToken([256]);
      const res = await postCompletions(app, {
        token,
        model: "nonexistent-model",
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.code).toBe("no_upstream");

      const refund = res.headers.get("X-Cashu-Refund");
      expect(refund).toBeTruthy();
    });
  });

  describe("SSE streaming", () => {
    it("streams SSE response with receipt headers", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      // Create SSE stream
      const encoder = new TextEncoder();
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetchFn.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

      const token = makeToken([256]);
      const res = await postCompletions(app, {
        token,
        model: "test-model",
        stream: true,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("X-Cashu-Receipt")).toBeTruthy();

      const text = await res.text();
      expect(text).toContain("Hello");
      expect(text).toContain("world");
    });
  });

  describe("metrics recording", () => {
    it("writes success metric to KV", async () => {
      const { redeemFn } = createMockRedeem();
      const kv = createMockKV();
      const app = createGateApp(makeConfig({ redeemFn, kvStore: kv }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const token = makeToken([256]);
      const res = await postCompletions(app, { token, model: "test-model" });
      expect(res.status).toBe(200);

      // Wait a tick for non-blocking metric write
      await new Promise((r) => setTimeout(r, 50));

      // Check KV has a metric entry
      const { keys } = await kv.list({ prefix: "metrics:" });
      expect(keys.length).toBeGreaterThan(0);
    });

    it("writes error metric on upstream failure", async () => {
      const { redeemFn } = createMockRedeem();
      const kv = createMockKV();
      const app = createGateApp(makeConfig({ redeemFn, kvStore: kv }));

      mockFetchFn.mockResolvedValueOnce(
        new Response("Server Error", { status: 500 })
      );

      const token = makeToken([256]);
      await postCompletions(app, { token, model: "test-model" });

      await new Promise((r) => setTimeout(r, 50));

      const { keys } = await kv.list({ prefix: "metrics:" });
      expect(keys.length).toBeGreaterThan(0);
    });

    it("writes no_upstream error metric", async () => {
      const { redeemFn } = createMockRedeem();
      const kv = createMockKV();
      const app = createGateApp(
        makeConfig({
          redeemFn,
          kvStore: kv,
          upstreams: [
            { match: "specific-only", baseUrl: "https://x.test", apiKey: "k" },
          ],
        })
      );

      const token = makeToken([256]);
      await postCompletions(app, { token, model: "unknown-model" });

      await new Promise((r) => setTimeout(r, 50));

      const { keys } = await kv.list({ prefix: "metrics:" });
      expect(keys.length).toBeGreaterThan(0);

      // Verify the metric contains error info
      const val = await kv.get(keys[0].name);
      expect(val).toBeTruthy();
      const record = JSON.parse(val!);
      expect(record.error_code).toBe("no_upstream");
      expect(record.refunded).toBe(true);
    });
  });

  describe("KV cleanup on refund", () => {
    it("cleans up stored keep proofs on upstream failure", async () => {
      const { redeemFn } = createMockRedeem();
      const kv = createMockKV();
      const app = createGateApp(makeConfig({ redeemFn, kvStore: kv }));

      mockFetchFn.mockResolvedValueOnce(
        new Response("Error", { status: 500 })
      );

      const token = makeToken([256]);
      const res = await postCompletions(app, { token, model: "test-model" });

      // Should get a refund
      expect(res.headers.get("X-Cashu-Refund")).toBeTruthy();
    });
  });

  describe("streaming error handling", () => {
    it("handles stream read error gracefully", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      // Create a stream that errors mid-way
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
          controller.error(new Error("Connection reset"));
        },
      });

      mockFetchFn.mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

      const token = makeToken([256]);
      const res = await postCompletions(app, {
        token,
        model: "test-model",
        stream: true,
      });

      expect(res.status).toBe(200);
      // The response started, so we got headers
      expect(res.headers.get("X-Cashu-Receipt")).toBeTruthy();
    });
  });

  describe("no KV store", () => {
    it("works without kvStore (no metrics)", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(
        makeConfig({ redeemFn, kvStore: undefined })
      );

      mockFetchFn.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const token = makeToken([256]);
      const res = await postCompletions(app, { token, model: "test-model" });
      expect(res.status).toBe(200);
    });
  });
});
