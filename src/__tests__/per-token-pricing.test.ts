/**
 * Integration tests for per-token pricing mode.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { stampGate } from "../middleware.js";
import type { StampGateOptions } from "../middleware.js";
import { getEncodedTokenV4 } from "@cashu/cashu-ts";
import type { Proof } from "@cashu/cashu-ts";
import type { Stamp, PricingRule } from "../lib/index.js";

const TRUSTED_MINT = "https://mint.example.com";

function makeTestToken(opts: { mint?: string; amount?: number } = {}): string {
  const mint = opts.mint ?? TRUSTED_MINT;
  const amount = opts.amount ?? 200;
  return getEncodedTokenV4({
    mint,
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

const MOCK_KEEP: Proof[] = [
  { amount: 10, id: "009a1f293253e41e", secret: "keep_secret", C: "02" + "cd".repeat(32) },
];

const MOCK_CHANGE: Proof[] = [
  { amount: 190, id: "009a1f293253e41e", secret: "change_secret", C: "02" + "ef".repeat(32) },
];

function createPerTokenApp(overrides: Partial<StampGateOptions> = {}) {
  const redeemFn = vi.fn(async (_stamp: Stamp, price?: number) => {
    // Simulate split: keep = price amount, change = remainder
    return {
      ok: true as const,
      keep: price ? [{ ...MOCK_KEEP[0], amount: price }] : MOCK_KEEP,
      change: MOCK_CHANGE,
    };
  });
  
  // Per-token pricing rules
  const pricing: PricingRule[] = [
    // gpt-4o-mini: $0.15/1M input, $0.60/1M output = 15000/60000 units/1M
    { model: "gpt-4o-mini", mode: "per_token", input_per_million: 15000, output_per_million: 60000 },
    // claude-opus: $15/1M input, $75/1M output = 1500000/7500000 units/1M
    { model: "claude-opus-4", mode: "per_token", input_per_million: 1500000, output_per_million: 7500000 },
    // Wildcard
    { model: "*", mode: "per_token", input_per_million: 100000, output_per_million: 500000 },
  ];
  
  const opts: StampGateOptions = {
    trustedMints: [TRUSTED_MINT],
    pricing,
    redeemFn,
    ...overrides,
  };

  const app = new Hono();
  app.post("/v1/chat/completions", stampGate(opts), (c) => {
    const stamp = c.get("stamp") as Stamp;
    const rule = c.get("pricingRule") as PricingRule;
    const estimatedPrice = c.get("estimatedPrice") as number;
    return c.json({
      id: "chatcmpl-test",
      model: rule.model,
      pricing_mode: rule.mode,
      estimated_price: estimatedPrice,
      stamp_amount: stamp?.amount,
    });
  });

  return { app, redeemFn };
}

async function post(
  app: Hono,
  headers: Record<string, string> = {},
  body: object = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hello, world!" }],
    max_tokens: 100,
  }
) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("per_token pricing mode", () => {
  it("should use per_token mode for pricing validation", async () => {
    const { app } = createPerTokenApp();
    const token = makeTestToken({ amount: 1000 }); // 1000 units should be enough for short message
    const res = await post(app, { "X-Cashu": token });
    
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pricing_mode).toBe("per_token");
  });

  it("should estimate cost based on input + max_tokens", async () => {
    const { app } = createPerTokenApp();
    const token = makeTestToken({ amount: 10000 });

    // Short message with low max_tokens
    const res = await post(app, { "X-Cashu": token }, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 50,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // With ~100 input tokens estimated and 50 max_tokens:
    // Input: 100/1M * 15000 = 1.5 units
    // Output: 50/1M * 60000 = 3 units
    // Total ~5 units
    expect(body.estimated_price).toBeGreaterThanOrEqual(1);
    expect(body.estimated_price).toBeLessThan(1000); // Should be small
  });

  it("should reject insufficient payment for expensive models", async () => {
    const { app } = createPerTokenApp();
    const token = makeTestToken({ amount: 10 }); // Only 10 units
    
    // Large message to expensive model
    const res = await post(app, { "X-Cashu": token }, {
      model: "claude-opus-4",
      messages: [{ role: "user", content: "A".repeat(10000) }], // ~2500 tokens
      max_tokens: 4096,
    });
    
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("insufficient_payment");
    expect(body.error.required).toBeGreaterThan(10);
  });

  it("should pass estimated price to redeemFn", async () => {
    const { app, redeemFn } = createPerTokenApp();
    const token = makeTestToken({ amount: 10000 });

    await post(app, { "X-Cashu": token }, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Test" }],
      max_tokens: 100,
    });
    
    expect(redeemFn).toHaveBeenCalled();
    const [, price] = redeemFn.mock.calls[0];
    expect(price).toBeGreaterThanOrEqual(1);
  });

  it("should include per_token pricing info in 402 response header", async () => {
    const { app } = createPerTokenApp();
    const token = makeTestToken({ amount: 1 }); // Too little
    
    const res = await post(app, { "X-Cashu": token }, {
      model: "claude-opus-4",
      messages: [{ role: "user", content: "A".repeat(10000) }],
      max_tokens: 1000,
    });
    
    expect(res.status).toBe(402);
    const priceHeader = res.headers.get("X-Cashu-Price");
    expect(priceHeader).toBeDefined();
    
    const price = JSON.parse(priceHeader!);
    expect(price.mode).toBe("per_token");
    expect(price.input_per_million).toBe(1500000);
    expect(price.output_per_million).toBe(7500000);
    expect(price.unit).toBe("usd");
  });

  it("should use wildcard pricing for unknown models", async () => {
    const { app } = createPerTokenApp();
    const token = makeTestToken({ amount: 10000 });
    
    const res = await post(app, { "X-Cashu": token }, {
      model: "some-unknown-model",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    });
    
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("some-unknown-model"); // Wildcard inherits model name
    expect(body.pricing_mode).toBe("per_token");
  });

  it("should handle multipart content (images)", async () => {
    const { app } = createPerTokenApp();
    const token = makeTestToken({ amount: 10000 });
    
    const res = await post(app, { "X-Cashu": token }, {
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
        ],
      }],
      max_tokens: 500,
    });
    
    expect(res.status).toBe(200);
    const body = await res.json();
    // Image should add ~800 tokens to estimate
    expect(body.estimated_price).toBeGreaterThanOrEqual(1);
  });
});

describe("backwards compatibility with per_request mode", () => {
  it("should still work with per_request pricing rules", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: true as const,
      keep: MOCK_KEEP,
      change: [],
    }));
    
    const pricing: PricingRule[] = [
      { model: "legacy-model", mode: "per_request", per_request: 500 },
    ];
    
    const app = new Hono();
    app.post("/v1/chat/completions", stampGate({
      trustedMints: [TRUSTED_MINT],
      pricing,
      redeemFn,
    }), (c) => {
      const rule = c.get("pricingRule") as PricingRule;
      const estimatedPrice = c.get("estimatedPrice") as number;
      return c.json({ mode: rule.mode, price: estimatedPrice });
    });
    
    const token = makeTestToken({ amount: 50000 });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cashu": token,
      },
      body: JSON.stringify({
        model: "legacy-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("per_request");
    expect(body.price).toBe(500);
  });
});
