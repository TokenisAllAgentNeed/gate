/**
 * Component tests — full request flow through the Gate app.
 *
 * Creates a real Gate app with mock upstream + mock redeem, and tests
 * the end-to-end flow from HTTP request to response.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { createGateApp, type GateAppConfig } from "../create-app.js";
import { createMockKV } from "./helpers.js";
import type { Stamp } from "../lib/types.js";
import type { RedeemResult } from "../redeem.js";

// ── Constants ────────────────────────────────────────────────

const TRUSTED_MINT = "https://mint.component-test.local";
const UNTRUSTED_MINT = "https://untrusted-mint.example.com";
const ADMIN_TOKEN = "component-test-admin";

// ── Helpers ──────────────────────────────────────────────────

function makeProofs(amounts: number[], mint = TRUSTED_MINT): Proof[] {
  return amounts.map((a, i) => ({
    amount: a,
    id: "009a1f293253e41e",
    secret: `secret_${a}_${i}_${Math.random().toString(36).slice(2, 8)}`,
    C: "02" + "ab".repeat(32),
  }));
}

function makeToken(amounts: number[], mint = TRUSTED_MINT): string {
  return getEncodedTokenV4({
    mint,
    proofs: makeProofs(amounts, mint),
    unit: "usd",
  });
}

/**
 * Mock redeem that always succeeds.
 * Splits proofs into keep (price amount) and change (remainder).
 */
function createMockRedeem() {
  const calls: { stamp: Stamp; price?: number }[] = [];

  async function redeemFn(stamp: Stamp, price?: number): Promise<RedeemResult> {
    calls.push({ stamp, price });
    const total = stamp.amount;
    const keepAmt = price && price > 0 && price < total ? price : total;
    const changeAmt = total - keepAmt;

    const freshProofs = (amount: number): Proof[] => {
      if (amount <= 0) return [];
      return [{
        amount,
        id: "009a1f293253e41e",
        secret: `new_${amount}_${Math.random().toString(36).slice(2, 8)}`,
        C: "02" + "cd".repeat(32),
      }];
    };

    return {
      ok: true,
      keep: freshProofs(keepAmt),
      change: changeAmt > 0 ? freshProofs(changeAmt) : [],
    };
  }

  return { redeemFn, calls };
}

// ── Mock fetch (upstream LLM) ────────────────────────────────

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

function mockUpstreamJson(body: object, status = 200) {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockUpstreamStream(chunks: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  mockFetch.mockResolvedValueOnce(
    new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  );
}

// ── App factory ──────────────────────────────────────────────

function createTestApp(overrides: Partial<GateAppConfig> = {}) {
  const { redeemFn, calls } = createMockRedeem();
  const config: GateAppConfig = {
    trustedMints: [TRUSTED_MINT],
    upstreams: [
      { match: "*", baseUrl: "https://upstream.test", apiKey: "test-key" },
    ],
    // Use per_request pricing for simplicity in component tests
    pricing: [
      { model: "*", mode: "per_request" as const, per_request: 100 },
    ],
    kvStore: createMockKV(),
    adminToken: ADMIN_TOKEN,
    walletAddress: "0xcomponenttestwallet",
    redeemFn,
    ...overrides,
  };

  const app = createGateApp(config);
  return { app, redeemCalls: calls };
}

function postChat(
  app: ReturnType<typeof createGateApp>,
  opts: {
    token?: string;
    model?: string;
    stream?: boolean;
    messages?: Array<{ role: string; content: string }>;
  }
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
        model: opts.model ?? "gpt-4o-mini",
        messages: opts.messages ?? [{ role: "user", content: "Hello" }],
        ...(opts.stream ? { stream: true } : {}),
      }),
    })
  );
}

// ── Tests ────────────────────────────────────────────────────

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("component: valid ecash → upstream → response + receipt", () => {
  test("returns upstream response with receipt header", async () => {
    const { app, redeemCalls } = createTestApp();

    mockUpstreamJson({
      id: "chatcmpl-123",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "Hello from LLM!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const token = makeToken([128]); // 128 > 100 (price) → change expected
    const res = await postChat(app, { token, model: "gpt-4o-mini" });

    // Should return 200 with upstream body
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices[0].message.content).toBe("Hello from LLM!");

    // Should include receipt header
    const receipt = res.headers.get("X-Cashu-Receipt");
    expect(receipt).toBeTruthy();
    const parsed = JSON.parse(receipt!);
    expect(parsed.model).toBe("gpt-4o-mini");
    expect(parsed.amount).toBeDefined();
    expect(parsed.id).toBeDefined();
    expect(parsed.timestamp).toBeDefined();

    // Should include change header (128 - 100 = 28 change)
    const change = res.headers.get("X-Cashu-Change");
    expect(change).toBeTruthy();
    expect(change!).toMatch(/^cashuB/);

    // Redeem was called
    expect(redeemCalls).toHaveLength(1);
    expect(redeemCalls[0].stamp.mint).toBe(TRUSTED_MINT);
    expect(redeemCalls[0].stamp.amount).toBe(128);
  });

  test("no change header when exact payment", async () => {
    const { app } = createTestApp();

    mockUpstreamJson({
      choices: [{ message: { content: "ok" } }],
    });

    const token = makeToken([64, 32, 4]); // 100 exact
    const res = await postChat(app, { token });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cashu-Receipt")).toBeTruthy();
    expect(res.headers.get("X-Cashu-Change")).toBeNull();
  });
});

describe("component: insufficient ecash → 402", () => {
  test("returns 402 with X-Cashu-Price for insufficient token", async () => {
    const { app } = createTestApp();

    const token = makeToken([4]); // 4 < 100 (price)
    const res = await postChat(app, { token, model: "gpt-4o-mini" });

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe("insufficient_payment");
    expect(body.error.required).toBeDefined();
    expect(body.error.provided).toBeDefined();

    // Should include pricing header
    const price = res.headers.get("X-Cashu-Price");
    expect(price).toBeTruthy();
  });

  test("returns 402 when no X-Cashu header at all", async () => {
    const { app } = createTestApp();

    const res = await postChat(app, { model: "gpt-4o-mini" });

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe("payment_required");
    expect(body.error.pricing_url).toBe("/v1/pricing");
  });
});

describe("component: invalid mint → rejection", () => {
  test("rejects token from untrusted mint", async () => {
    const { app } = createTestApp();

    const token = makeToken([256], UNTRUSTED_MINT);
    const res = await postChat(app, { token, model: "gpt-4o-mini" });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe("untrusted_mint");
    expect(body.error.message).toContain(UNTRUSTED_MINT);
  });
});

describe("component: streaming request → cashu-change SSE event", () => {
  test("streams response and emits cashu-change event", async () => {
    const { app } = createTestApp();

    mockUpstreamStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const token = makeToken([256]); // 256 > 100 → change expected
    const res = await postChat(app, { token, model: "gpt-4o-mini", stream: true });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("X-Cashu-Receipt")).toBeTruthy();

    const text = await res.text();

    // Should contain the upstream SSE data
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).toContain("[DONE]");

    // Should contain the cashu-change SSE event
    expect(text).toContain("event: cashu-change");
    expect(text).toContain("cashuB");
  });

  test("no cashu-change event when exact payment", async () => {
    const { app } = createTestApp();

    mockUpstreamStream([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const token = makeToken([64, 32, 4]); // 100 exact
    const res = await postChat(app, { token, stream: true });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("event: cashu-change");
  });
});

describe("component: upstream error → refund", () => {
  test("returns refund token when upstream fails", async () => {
    const { app } = createTestApp();

    mockFetch.mockResolvedValueOnce(
      new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const token = makeToken([256]);
    const res = await postChat(app, { token, model: "gpt-4o-mini" });

    // Upstream error results in error response with refund
    // Status is the upstream's original error code (500)
    expect(res.status).toBeGreaterThanOrEqual(400);
    const refund = res.headers.get("X-Cashu-Refund");
    expect(refund).toBeTruthy();
    expect(refund!).toMatch(/^cashuB/);

    const body = await res.json() as any;
    expect(body.error.code).toBe("upstream_error");
  });
});

describe("component: end-to-end with per_token pricing", () => {
  test("handles per_token pricing correctly", async () => {
    const { app } = createTestApp({
      pricing: [
        {
          model: "*",
          mode: "per_token" as const,
          input_per_million: 15000,    // $0.15/1M = 15000 units/1M
          output_per_million: 60000,   // $0.60/1M = 60000 units/1M
        },
      ],
    });

    mockUpstreamJson({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    // Large enough token to cover estimated max cost
    const token = makeToken([1024, 512, 256, 128]); // 1920 units
    const res = await postChat(app, { token, model: "gpt-4o-mini" });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cashu-Receipt")).toBeTruthy();
  });
});

describe("component: version header on all responses", () => {
  test("includes X-Gate-Version on success", async () => {
    const { app } = createTestApp();

    mockUpstreamJson({
      choices: [{ message: { content: "ok" } }],
    });

    const token = makeToken([128]);
    const res = await postChat(app, { token });

    expect(res.headers.get("X-Gate-Version")).toBeTruthy();
  });

  test("includes X-Gate-Version on error", async () => {
    const { app } = createTestApp();

    const res = await postChat(app, {}); // no token → 402

    expect(res.status).toBe(402);
    expect(res.headers.get("X-Gate-Version")).toBeTruthy();
  });
});
