import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { stampGate } from "../middleware.js";
import type { StampGateOptions } from "../middleware.js";
import { getEncodedTokenV4 } from "@cashu/cashu-ts";
import type { Proof } from "@cashu/cashu-ts";
import type { Stamp } from "../lib/index.js";

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
  {
    amount: 128,
    id: "009a1f293253e41e",
    secret: "keep_secret_1",
    C: "02" + "cd".repeat(32),
  },
  {
    amount: 64,
    id: "009a1f293253e41e",
    secret: "keep_secret_2",
    C: "02" + "cd".repeat(32),
  },
  {
    amount: 8,
    id: "009a1f293253e41e",
    secret: "keep_secret_3",
    C: "02" + "cd".repeat(32),
  },
];

const MOCK_CHANGE: Proof[] = [
  {
    amount: 64,
    id: "009a1f293253e41e",
    secret: "change_secret_1",
    C: "02" + "ef".repeat(32),
  },
  {
    amount: 32,
    id: "009a1f293253e41e",
    secret: "change_secret_2",
    C: "02" + "ef".repeat(32),
  },
  {
    amount: 4,
    id: "009a1f293253e41e",
    secret: "change_secret_3",
    C: "02" + "ef".repeat(32),
  },
];

function createApp(overrides: Partial<StampGateOptions> = {}) {
  const redeemFn = vi.fn(async () => ({ ok: true as const, keep: MOCK_KEEP, change: [] as Proof[] }));
  const opts: StampGateOptions = {
    trustedMints: [TRUSTED_MINT],
    pricing: [
      { model: "gpt-4o-mini", mode: "per_request" as const, per_request: 200 },
      { model: "gpt-4o", mode: "per_request" as const, per_request: 2000 },
    ],
    redeemFn,
    ...overrides,
  };

  const app = new Hono();
  app.post("/v1/chat/completions", stampGate(opts), (c) => {
    const stamp = c.get("stamp") as Stamp;
    const redeemKeep = c.get("redeemKeep") as Proof[];
    const redeemChange = c.get("redeemChange") as Proof[];
    return c.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [
        {
          message: { role: "assistant", content: "Hello from mock LLM" },
        },
      ],
      _stamp_amount: stamp?.amount,
      _has_keep: Array.isArray(redeemKeep) && redeemKeep.length > 0,
      _has_change: Array.isArray(redeemChange) && redeemChange.length > 0,
      _change_count: redeemChange?.length ?? 0,
    });
  });

  return { app, redeemFn };
}

async function post(
  app: Hono,
  headers: Record<string, string> = {},
  body: object = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }
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

describe("stampGate middleware", () => {
  it("should return 402 when X-Cashu header is missing", async () => {
    const { app } = createApp();
    const res = await post(app);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("payment_required");
  });

  it("should include X-Cashu-Price header on 402", async () => {
    const { app } = createApp();
    const res = await post(app);
    expect(res.status).toBe(402);
    const priceHeader = res.headers.get("X-Cashu-Price");
    expect(priceHeader).toBeDefined();
    const price = JSON.parse(priceHeader!);
    expect(price.amount).toBe(200);
    expect(price.unit).toBe("usd");
  });

  it("should return 400 when token is malformed", async () => {
    const { app } = createApp();
    const res = await post(app, { "X-Cashu": "garbage-data" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_token");
  });

  it("should return 400 when mint is not trusted", async () => {
    const { app } = createApp();
    const token = makeTestToken({ mint: "https://evil-mint.example" });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("untrusted_mint");
  });

  it("should return 402 when token amount is insufficient", async () => {
    const { app } = createApp();
    const token = makeTestToken({ amount: 50 });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("insufficient_payment");
    expect(body.error.required).toBe(200);
    expect(body.error.provided).toBe(50);
  });

  it("should call redeemFn in middleware (charge upfront)", async () => {
    const { app, redeemFn } = createApp();
    const token = makeTestToken({ amount: 200 });
    await post(app, { "X-Cashu": token });
    expect(redeemFn).toHaveBeenCalledOnce();
  });

  it("should return 400 on double-spend (token already spent)", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: false as const,
      error: "Token already spent",
    }));
    const { app } = createApp({ redeemFn });
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("token_spent");
  });

  it("should pass redeemKeep to downstream handler via context", async () => {
    const { app } = createApp();
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._has_keep).toBe(true);
  });

  it("should pass empty change when exact payment", async () => {
    const { app } = createApp();
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token });
    const body = await res.json();
    expect(body._has_change).toBe(false);
    expect(body._change_count).toBe(0);
  });

  it("should pass change proofs when overpaying", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: true as const,
      keep: MOCK_KEEP,
      change: MOCK_CHANGE,
    }));
    const { app } = createApp({ redeemFn });
    const token = makeTestToken({ amount: 300 });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._has_change).toBe(true);
    expect(body._change_count).toBe(3);
  });

  it("should pass price to redeemFn", async () => {
    const { app, redeemFn } = createApp();
    const token = makeTestToken({ amount: 200 });
    await post(app, { "X-Cashu": token });
    expect(redeemFn).toHaveBeenCalledOnce();
    const [stamp, price] = redeemFn.mock.calls[0];
    expect(price).toBe(200);
  });

  it("should proxy to upstream and return 200 on valid payment", async () => {
    const { app } = createApp();
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices).toBeDefined();
    expect(body.choices[0].message.content).toBe("Hello from mock LLM");
  });

  it("should pass stamp to downstream handler via context", async () => {
    const { app } = createApp();
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token });
    const body = await res.json();
    expect(body._stamp_amount).toBe(200);
  });

  it("should return 400 when model is missing from body", async () => {
    const { app } = createApp();
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token }, { messages: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_request");
  });

  it("should return 400 when model has no pricing rule", async () => {
    const { app } = createApp();
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token }, {
      model: "nonexistent-model",
      messages: [],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("model_not_found");
  });

  it("should handle mint URL with trailing slash", async () => {
    const { app } = createApp({ trustedMints: [TRUSTED_MINT + "/"] });
    const token = makeTestToken({ mint: TRUSTED_MINT });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(200);
  });

  it("should return 500 when redeem fails for non-double-spend reasons", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: false as const,
      error: "Redeem failed: network error",
    }));
    const { app } = createApp({ redeemFn });
    const token = makeTestToken({ amount: 200 });
    const res = await post(app, { "X-Cashu": token });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("redeem_failed");
  });
});
