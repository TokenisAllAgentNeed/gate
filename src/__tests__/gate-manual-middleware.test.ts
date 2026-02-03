/**
 * Test: Gate worker's manual middleware invocation handles early-return correctly.
 *
 * Bug fixed: When stampGate middleware returns 402/400 (insufficient payment, etc.),
 * the handler continued because c.finalized wasn't set, causing stamp=undefined → 500.
 *
 * Fix: Check if stamp/rule are set after middleware; if not, return the middleware's Response.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { stampGate, type StampGateOptions } from "../middleware.js";
import { getEncodedTokenV4 } from "@cashu/cashu-ts";
import type { Proof } from "@cashu/cashu-ts";

const TRUSTED_MINT = "https://mint.example.com";

const MOCK_KEEP: Proof[] = [
  {
    amount: 128,
    id: "009a1f293253e41e",
    secret: "keep_secret_manual_1",
    C: "02" + "cd".repeat(32),
  },
  {
    amount: 64,
    id: "009a1f293253e41e",
    secret: "keep_secret_manual_2",
    C: "02" + "cd".repeat(32),
  },
  {
    amount: 8,
    id: "009a1f293253e41e",
    secret: "keep_secret_manual_3",
    C: "02" + "cd".repeat(32),
  },
];

function makeToken(amount: number): string {
  return getEncodedTokenV4({
    mint: TRUSTED_MINT,
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

/**
 * Simulate the Gate worker's manual middleware pattern (from worker.ts).
 */
function createManualMiddlewareApp() {
  const redeemFn = vi.fn(async () => ({ ok: true as const, keep: MOCK_KEEP, change: [] as Proof[] }));

  const app = new Hono();
  app.post("/v1/chat/completions", async (c) => {
    const gate = stampGate({
      trustedMints: [TRUSTED_MINT],
      pricing: [{ model: "gpt-4o-mini", mode: "per_request" as const, per_request: 200 }],
      redeemFn,
    });

    // This is the pattern from worker.ts
    const middlewareResult = await gate(c, async () => {});

    if (c.finalized) return;

    const stamp = c.get("stamp");
    const rule = c.get("pricingRule");

    // THE FIX: check stamp/rule before using them
    if (!stamp || !rule) {
      if (middlewareResult instanceof Response) {
        return middlewareResult;
      }
      return c.json(
        { error: { code: "payment_required", message: "Payment validation failed" } },
        402,
      );
    }

    // Simulate upstream call (would crash here if stamp is undefined)
    return c.json({
      choices: [{ message: { role: "assistant", content: "OK" } }],
      _stamp_amount: stamp.amount,
    });
  });

  return { app, redeemFn };
}

describe("Gate manual middleware pattern", () => {
  it("should return 402 (not 500) when token has insufficient sats", async () => {
    const { app } = createManualMiddlewareApp();
    const token = makeToken(50); // 50 < 200 required

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cashu": token },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    // Before fix: status was 500 (stamp=undefined → crash)
    // After fix: status is 402 (insufficient payment)
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("insufficient_payment");
  });

  it("should return 400 when mint is untrusted", async () => {
    const { app } = createManualMiddlewareApp();
    const token = getEncodedTokenV4({
      mint: "https://evil.example.com",
      proofs: [{ amount: 200, id: "009a1f293253e41e", secret: "s1", C: "02" + "ab".repeat(32) }],
      unit: "usd",
    });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cashu": token },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("untrusted_mint");
  });

  it("should return 402 when no X-Cashu header", async () => {
    const { app } = createManualMiddlewareApp();

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(402);
  });

  it("should return 200 with valid token and sufficient sats", async () => {
    const { app } = createManualMiddlewareApp();
    const token = makeToken(200);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cashu": token },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._stamp_amount).toBe(200);
  });

  it("should return 400 on double-spend (redeem fails)", async () => {
    const redeemFn = vi.fn(async () => ({
      ok: false as const,
      error: "Token already spent",
    }));
    const app = new Hono();
    app.post("/v1/chat/completions", async (c) => {
      const gate = stampGate({
        trustedMints: [TRUSTED_MINT],
        pricing: [{ model: "gpt-4o-mini", mode: "per_request" as const, per_request: 200 }],
        redeemFn,
      });
      const middlewareResult = await gate(c, async () => {});
      if (c.finalized) return;
      const stamp = c.get("stamp");
      const rule = c.get("pricingRule");
      if (!stamp || !rule) {
        if (middlewareResult instanceof Response) return middlewareResult;
        return c.json({ error: { code: "payment_required" } }, 402);
      }
      return c.json({ ok: true });
    });

    const token = makeToken(200);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cashu": token },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("token_spent");
  });

  it("should call redeemFn in middleware (charge upfront)", async () => {
    const { app, redeemFn } = createManualMiddlewareApp();
    const token = makeToken(200);

    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cashu": token },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(redeemFn).toHaveBeenCalledOnce();
  });
});
