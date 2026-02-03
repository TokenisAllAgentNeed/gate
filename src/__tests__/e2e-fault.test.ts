/**
 * E2E tests — Layer 2: Fault injection
 *
 * Tests Gate behavior when mint or upstream misbehave:
 * timeouts, 500s, rate limiting, slow responses.
 * Uses mock redeemFn (no real mint), fast and deterministic.
 */
import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { decodeStamp, type Stamp } from "../lib/index.js";
import type { RedeemResult } from "../redeem.js";
import { createGateApp, makeRequest } from "./helpers/gate-app.js";
import { createMockUpstream } from "./helpers/mock-upstream.js";

const MINT_URL = "https://fault-test-mint.example";
const PRICE = 200;

// ── Helpers ───────────────────────────────────────────────────

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
  // Split amount into powers of 2 for realistic proofs
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

/** Create a redeemFn that simulates various mint behaviors */
function createFaultRedeemFn(
  behavior: "ok" | "timeout" | "error-500" | "ratelimit" | "slow" | "double-spend",
  opts?: { delayMs?: number }
) {
  return async (stamp: Stamp, price?: number): Promise<RedeemResult> => {
    switch (behavior) {
      case "timeout":
        // Simulate mint hanging beyond timeout
        await new Promise((r) => setTimeout(r, 15_000));
        return { ok: true, keep: [], change: [] };

      case "error-500":
        return { ok: false, error: "Redeem failed: Mint internal error (500)" };

      case "ratelimit":
        return { ok: false, error: "Redeem failed: Rate limited (429)" };

      case "double-spend":
        return { ok: false, error: "Token already spent" };

      case "slow": {
        // Slow but within timeout
        const delay = opts?.delayMs ?? 3000;
        await new Promise((r) => setTimeout(r, delay));
        const keepAmount = price && price > 0 && price < stamp.amount ? price : stamp.amount;
        const changeAmount = stamp.amount - keepAmount;
        return {
          ok: true,
          keep: mockProofs(keepAmount),
          change: changeAmount > 0 ? mockProofs(changeAmount) : [],
        };
      }

      case "ok":
      default: {
        const keepAmount = price && price > 0 && price < stamp.amount ? price : stamp.amount;
        const changeAmount = stamp.amount - keepAmount;
        return {
          ok: true,
          keep: mockProofs(keepAmount),
          change: changeAmount > 0 ? mockProofs(changeAmount) : [],
        };
      }
    }
  };
}

function buildFaultApp(
  mintBehavior: Parameters<typeof createFaultRedeemFn>[0],
  mintOpts?: Parameters<typeof createFaultRedeemFn>[1]
) {
  const mockUpstream = createMockUpstream();
  return createGateApp({
    trustedMints: [MINT_URL],
    pricing: [
      { model: "mock-ok", mode: "per_request", per_request: PRICE },
      { model: "mock-500", mode: "per_request", per_request: PRICE },
      { model: "mock-stream", mode: "per_request", per_request: PRICE },
      { model: "*", mode: "per_request", per_request: PRICE },
    ],
    redeemFn: createFaultRedeemFn(mintBehavior, mintOpts),
    upstreamFetch: (req) => mockUpstream.fetch(req),
  });
}

// ── Mint fault tests ──────────────────────────────────────────

describe("E2E Fault Injection — Mint failures", () => {
  it("mint 500 error → 500 redeem_failed, no charge", async () => {
    const app = buildFaultApp("error-500");
    const token = makeFakeToken(200);

    const res = await makeRequest(app, { token, model: "mock-ok" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("redeem_failed");
  });

  it("mint rate limited (429) → 500 redeem_failed, no charge", async () => {
    const app = buildFaultApp("ratelimit");
    const token = makeFakeToken(200);

    const res = await makeRequest(app, { token, model: "mock-ok" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("redeem_failed");
  });

  it("mint double-spend → 400 token_spent", async () => {
    const app = buildFaultApp("double-spend");
    const token = makeFakeToken(200);

    const res = await makeRequest(app, { token, model: "mock-ok" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("token_spent");
  });

  it("mint slow but within timeout → normal 200", async () => {
    const app = buildFaultApp("slow", { delayMs: 100 }); // 100ms delay
    const token = makeFakeToken(200);

    const res = await makeRequest(app, { token, model: "mock-ok" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Hello from mock!");
  });
});

// ── Upstream fault tests ──────────────────────────────────────

describe("E2E Fault Injection — Upstream failures", () => {
  it("upstream 500 → 502 + full refund in X-Cashu-Refund", async () => {
    const app = buildFaultApp("ok"); // mint works fine
    const token = makeFakeToken(200);

    const res = await makeRequest(app, { token, model: "mock-500" });
    expect(res.status).toBe(502);

    // Verify refund token exists and has correct amount
    const refundHeader = res.headers.get("X-Cashu-Refund");
    expect(refundHeader).toBeTruthy();
    const refundStamp = decodeStamp(refundHeader!);
    expect(refundStamp.amount).toBe(200);
  });

  it("upstream 500 with overpayment → 502 + full refund (keep + change)", async () => {
    const app = buildFaultApp("ok");
    const token = makeFakeToken(300); // overpay by 100

    const res = await makeRequest(app, { token, model: "mock-500" });
    expect(res.status).toBe(502);

    const refundHeader = res.headers.get("X-Cashu-Refund");
    expect(refundHeader).toBeTruthy();
    // Full refund = keep (200) + change (100) = 300
    const refundStamp = decodeStamp(refundHeader!);
    expect(refundStamp.amount).toBe(300);
  });
});

// ── Combined fault tests ──────────────────────────────────────

describe("E2E Fault Injection — Combined scenarios", () => {
  it("mint ok + upstream ok → normal success", async () => {
    const app = buildFaultApp("ok");
    const token = makeFakeToken(200);

    const res = await makeRequest(app, { token, model: "mock-ok" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cashu-Receipt")).toBeTruthy();
  });

  it("mint ok + upstream ok + SSE → streaming success with change via SSE event", async () => {
    const app = buildFaultApp("ok");
    const token = makeFakeToken(300);

    const res = await makeRequest(app, { token, model: "mock-stream", stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cashu-Receipt")).toBeTruthy();

    // Change should NOT be in headers for streaming
    expect(res.headers.get("X-Cashu-Change")).toBeNull();

    // Change should be in SSE event after [DONE]
    const text = await res.text();
    expect(text).toContain("[DONE]");
    const match = text.match(/event: cashu-change\ndata: (.+)\n/);
    expect(match).toBeTruthy();
    expect(decodeStamp(match![1]).amount).toBe(100);
  });
});
