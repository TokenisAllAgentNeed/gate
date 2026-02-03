/**
 * Additional middleware tests for coverage gaps:
 * - onMetric callbacks on all error paths
 * - onTokenError callback on decode failure
 * - hashIP function (via CF-Connecting-IP header)
 * - Timeout redeem error → 504
 * - per_token pricing mode with input estimation
 * - getParsedBody null body path
 * - pricingHeaders for per_token mode
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { stampGate, type StampGateOptions } from "../middleware.js";
import { getEncodedTokenV4 } from "@cashu/cashu-ts";
import type { Proof } from "@cashu/cashu-ts";
import type { Stamp, DecodeDiagnostics } from "../lib/index.js";

const TRUSTED_MINT = "https://mint.example.com";

function makeTestToken(opts: { mint?: string; amount?: number } = {}): string {
  return getEncodedTokenV4({
    mint: opts.mint ?? TRUSTED_MINT,
    proofs: [
      {
        amount: opts.amount ?? 200,
        id: "009a1f293253e41e",
        secret: `s_${Math.random().toString(36).slice(2)}`,
        C: "02" + "ab".repeat(32),
      },
    ],
    unit: "usd",
  });
}

const MOCK_KEEP: Proof[] = [
  { amount: 200, id: "009a1f293253e41e", secret: "k1", C: "02" + "cd".repeat(32) },
];

function createApp(overrides: Partial<StampGateOptions> = {}) {
  const redeemFn = vi.fn(async () => ({
    ok: true as const,
    keep: MOCK_KEEP,
    change: [] as Proof[],
  }));
  const onMetric = vi.fn();
  const onTokenError = vi.fn();

  const opts: StampGateOptions = {
    trustedMints: [TRUSTED_MINT],
    pricing: [
      { model: "gpt-4o-mini", mode: "per_request" as const, per_request: 200 },
      { model: "gpt-4o", mode: "per_request" as const, per_request: 2000 },
    ],
    redeemFn,
    onMetric,
    onTokenError,
    ...overrides,
  };

  const app = new Hono();
  app.post("/v1/chat/completions", stampGate(opts), (c) => c.json({ ok: true }));
  return { app, redeemFn, onMetric, onTokenError };
}

async function post(
  app: Hono,
  headers: Record<string, string> = {},
  body?: object | string,
) {
  const isString = typeof body === "string";
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: isString ? body : JSON.stringify(body ?? { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("stampGate middleware — onMetric callbacks", () => {
  it("calls onMetric on payment_required (no header)", async () => {
    const { app, onMetric } = createApp();
    await post(app);
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 402,
        error_code: "payment_required",
      }),
    );
  });

  it("calls onMetric on invalid_token (malformed)", async () => {
    const { app, onMetric } = createApp();
    await post(app, { "X-Cashu": "garbage!!!" });
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 400,
        error_code: "invalid_token",
      }),
    );
  });

  it("calls onTokenError on decode failure", async () => {
    const { app, onTokenError } = createApp();
    await post(app, { "X-Cashu": "garbage!!!" });
    expect(onTokenError).toHaveBeenCalledOnce();
    const [diagnostics, rawToken, metadata] = onTokenError.mock.calls[0];
    expect(rawToken).toBe("garbage!!!");
    expect(diagnostics).toHaveProperty("error");
  });

  it("calls onTokenError with IP hash when CF-Connecting-IP present", async () => {
    const { app, onTokenError } = createApp();
    await post(app, {
      "X-Cashu": "garbage!!!",
      "CF-Connecting-IP": "1.2.3.4",
    });
    expect(onTokenError).toHaveBeenCalledOnce();
    const [, , metadata] = onTokenError.mock.calls[0];
    expect(metadata.ipHash).toBeDefined();
    expect(typeof metadata.ipHash).toBe("string");
    expect(metadata.ipHash!.length).toBe(16); // 8 bytes hex
  });

  it("includes userAgent in onTokenError metadata", async () => {
    const { app, onTokenError } = createApp();
    await post(app, {
      "X-Cashu": "garbage!!!",
      "User-Agent": "TestBot/1.0",
    });
    expect(onTokenError).toHaveBeenCalledOnce();
    const [, , metadata] = onTokenError.mock.calls[0];
    expect(metadata.userAgent).toBe("TestBot/1.0");
  });

  it("calls onMetric on untrusted_mint", async () => {
    const { app, onMetric } = createApp();
    const token = makeTestToken({ mint: "https://evil.mint" });
    await post(app, { "X-Cashu": token });
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 400,
        error_code: "untrusted_mint",
      }),
    );
  });

  it("calls onMetric on insufficient_payment", async () => {
    const { app, onMetric } = createApp();
    const token = makeTestToken({ amount: 10 }); // too little
    await post(app, { "X-Cashu": token });
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 402,
        error_code: "insufficient_payment",
      }),
    );
  });

  it("calls onMetric on double-spend (token_spent)", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: false as const,
      error: "Token already spent",
    }));
    const { app, onMetric } = createApp({ redeemFn });
    const token = makeTestToken({ amount: 200 });
    await post(app, { "X-Cashu": token });
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 400,
        error_code: "token_spent",
      }),
    );
  });

  it("calls onMetric on redeem timeout → 504", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: false as const,
      error: "Connection timeout",
    }));
    const { app, onMetric } = createApp({ redeemFn });
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(504);

    const body = await res.json();
    expect(body.error.code).toBe("gateway_timeout");

    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 504,
        error_code: "gateway_timeout",
      }),
    );
  });

  it("calls onMetric on generic redeem failure → 500", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: false as const,
      error: "Unknown mint error",
    }));
    const { app, onMetric } = createApp({ redeemFn });
    const token = makeTestToken({ amount: 200 });
    await post(app, { "X-Cashu": token });
    expect(onMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 500,
        error_code: "redeem_failed",
      }),
    );
  });
});

describe("stampGate middleware — per_token pricing", () => {
  it("estimates cost from input tokens and max_tokens", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: true as const,
      keep: MOCK_KEEP,
      change: [] as Proof[],
    }));
    const { app } = createApp({
      redeemFn,
      pricing: [
        {
          model: "gpt-4o-mini",
          mode: "per_token" as const,
          input_per_million: 15000,
          output_per_million: 60000,
        },
      ],
    });

    const token = makeTestToken({ amount: 500 }); // generous payment
    const res = await post(app, { "X-Cashu": token }, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hello world" }],
      max_tokens: 100,
    });

    // Should succeed (price estimated from tokens)
    expect(res.status).toBe(200);
    // redeemFn should have been called with an estimated price
    expect(redeemFn).toHaveBeenCalledOnce();
    const [, price] = redeemFn.mock.calls[0];
    expect(typeof price).toBe("number");
    expect(price).toBeGreaterThan(0);
  });

  it("includes per_token pricing in X-Cashu-Price header on 402", async () => {
    const { app } = createApp({
      pricing: [
        {
          model: "gpt-4o-mini",
          mode: "per_token" as const,
          input_per_million: 15000,
          output_per_million: 60000,
        },
      ],
    });

    // No X-Cashu → 402 with pricing header
    const res = await post(app);
    expect(res.status).toBe(402);

    const priceHeader = res.headers.get("X-Cashu-Price");
    expect(priceHeader).toBeTruthy();
    const price = JSON.parse(priceHeader!);
    expect(price.mode).toBe("per_token");
    expect(price.input_per_million).toBe(15000);
    expect(price.output_per_million).toBe(60000);
  });

  it("handles multimodal messages with image_url parts", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: true as const,
      keep: MOCK_KEEP,
      change: [] as Proof[],
    }));
    const { app } = createApp({
      redeemFn,
      pricing: [
        {
          model: "gpt-4o",
          mode: "per_token" as const,
          input_per_million: 250000,
          output_per_million: 1000000,
        },
      ],
    });

    const token = makeTestToken({ amount: 500000 });
    const res = await post(app, { "X-Cashu": token }, {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image" },
            { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    // The image_url part should add IMAGE_TOKEN_ESTIMATE to input tokens
    const [, price] = redeemFn.mock.calls[0];
    expect(price).toBeGreaterThan(0);
  });
});

describe("stampGate middleware — edge cases", () => {
  it("handles invalid JSON body gracefully", async () => {
    const { app } = createApp();
    const token = makeTestToken({ amount: 200 });

    // Send invalid JSON
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cashu": token,
      },
      body: "not-valid-json{{{",
    });

    // Should return 400 (missing model from null body)
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
  });

  it("redeem with 'Timeout' in error message returns 504", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: false as const,
      error: "Timeout waiting for mint response",
    }));
    const { app } = createApp({ redeemFn });
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe("gateway_timeout");
  });
});
