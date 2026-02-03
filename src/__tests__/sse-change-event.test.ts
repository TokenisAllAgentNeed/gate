/**
 * Tests for SSE streaming change event (Change 2).
 *
 * Instead of sending X-Cashu-Change in initial HTTP headers for streaming,
 * the gate should:
 *   1. NOT include X-Cashu-Change in the initial SSE headers
 *   2. Parse `usage` from the final SSE chunk (before [DONE])
 *   3. Calculate actual price from real token counts
 *   4. Emit `event: cashu-change` SSE event after [DONE] with the change token
 *   5. Fallback: if no usage data, send all change via SSE event anyway
 *
 * Non-streaming requests should continue to use X-Cashu-Change header.
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

function createMockRedeem() {
  const calls: Array<{ stamp: Stamp; price?: number }> = [];

  async function redeemFn(stamp: Stamp, price?: number): Promise<RedeemResult> {
    calls.push({ stamp, price });
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
  opts: { token?: string; model?: string; stream?: boolean; max_tokens?: number }
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
        ...(opts.max_tokens ? { max_tokens: opts.max_tokens } : {}),
      }),
    })
  );
}

/** Create a mock SSE stream with optional usage in the last data chunk */
function createSSEStream(opts: {
  chunks?: string[];
  usage?: { prompt_tokens: number; completion_tokens: number };
} = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const contentChunks = opts.chunks ?? [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
  ];

  // Final chunk with usage data (like OpenAI/OpenRouter streams)
  const finalChunk = opts.usage
    ? `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":${opts.usage.prompt_tokens},"completion_tokens":${opts.usage.completion_tokens}}}\n\n`
    : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';

  return new ReadableStream({
    start(controller) {
      for (const chunk of contentChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.enqueue(encoder.encode(finalChunk));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** Parse SSE text to find our custom cashu-change event */
function parseCashuChangeEvent(text: string): string | null {
  // Look for: event: cashu-change\ndata: <token>\n\n
  const match = text.match(/event: cashu-change\ndata: (.+)\n/);
  return match ? match[1] : null;
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

describe("SSE streaming change event", () => {
  describe("streaming with overpayment", () => {
    it("should NOT include X-Cashu-Change in initial HTTP headers", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(createSSEStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

      const token = makeToken([256, 64]); // 320, price 200 → 120 change
      const res = await postCompletions(app, {
        token,
        model: "test-model",
        stream: true,
      });

      expect(res.status).toBe(200);
      // X-Cashu-Change should NOT be in initial headers for streaming
      expect(res.headers.get("X-Cashu-Change")).toBeNull();
    });

    it("should emit event: cashu-change SSE event after [DONE]", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(createSSEStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

      const token = makeToken([256, 64]); // 320, price 200 → 120 change
      const res = await postCompletions(app, {
        token,
        model: "test-model",
        stream: true,
      });

      const text = await res.text();

      // Should contain original SSE data
      expect(text).toContain('"content":"Hello"');
      expect(text).toContain("[DONE]");

      // Should contain cashu-change event after [DONE]
      const changeToken = parseCashuChangeEvent(text);
      expect(changeToken).toBeTruthy();
      expect(changeToken).toMatch(/^cashuB/);
    });
  });

  describe("streaming with exact payment", () => {
    it("should NOT emit cashu-change event when no change", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(createSSEStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

      const token = makeToken([128, 64, 8]); // 200 exact
      const res = await postCompletions(app, {
        token,
        model: "test-model",
        stream: true,
      });

      const text = await res.text();
      expect(text).toContain("[DONE]");

      // No change → no cashu-change event
      const changeToken = parseCashuChangeEvent(text);
      expect(changeToken).toBeNull();
    });
  });

  describe("non-streaming still uses header", () => {
    it("should keep X-Cashu-Change in headers for non-streaming", async () => {
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
      // Non-streaming: change should still be in header
      expect(res.headers.get("X-Cashu-Change")).toBeTruthy();
    });
  });

  describe("streaming receipt header", () => {
    it("should still include X-Cashu-Receipt in initial headers", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(createSSEStream(), {
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
    });
  });

  describe("cashu-change event format", () => {
    it("should use proper SSE event format with event name and data", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(createSSEStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

      const token = makeToken([256, 64]); // 320, price 200 → 120 change
      const res = await postCompletions(app, {
        token,
        model: "test-model",
        stream: true,
      });

      const text = await res.text();

      // Verify the exact SSE format: event: cashu-change\ndata: <token>\n\n
      expect(text).toMatch(/event: cashu-change\ndata: cashuB\S+\n\n/);
    });

    it("cashu-change event should appear after [DONE]", async () => {
      const { redeemFn } = createMockRedeem();
      const app = createGateApp(makeConfig({ redeemFn }));

      mockFetchFn.mockResolvedValueOnce(
        new Response(createSSEStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      );

      const token = makeToken([256, 64]); // 320, price 200 → 120 change
      const res = await postCompletions(app, {
        token,
        model: "test-model",
        stream: true,
      });

      const text = await res.text();
      const doneIdx = text.indexOf("[DONE]");
      const changeIdx = text.indexOf("event: cashu-change");

      expect(doneIdx).toBeGreaterThan(-1);
      expect(changeIdx).toBeGreaterThan(-1);
      expect(changeIdx).toBeGreaterThan(doneIdx);
    });
  });
});
