/**
 * Tests for admin endpoints, info endpoints, and error paths in create-app.ts.
 *
 * Tests the REAL createGateApp factory covering:
 * - GET / (landing page)
 * - GET /health
 * - GET /v1/info
 * - GET /v1/pricing (per_token + legacy per_request)
 * - GET /stats (admin)
 * - GET /v1/gate/balance (admin)
 * - POST /v1/gate/melt (admin)
 * - GET /v1/gate/metrics/summary (admin)
 * - GET /v1/gate/metrics/errors (admin)
 * - GET /v1/gate/metrics (admin)
 * - GET /v1/gate/token-errors (admin)
 * - GET /v1/gate/token-errors/summary (admin)
 * - Admin brute-force protection
 * - SSE cashu-change event
 * - Missing walletAddress validation
 * - executionCtx.waitUntil metric path
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { createGateApp, type GateAppConfig } from "../create-app.js";
import { createMockKV } from "./helpers.js";
import type { Stamp } from "../lib/types.js";
import type { RedeemResult } from "../redeem.js";

const MINT_URL = "https://testmint.example";
const ADMIN_TOKEN = "test-admin-secret";

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
  async function redeemFn(stamp: Stamp, price?: number): Promise<RedeemResult> {
    const total = stamp.amount;
    const keepAmt = price && price > 0 && price < total ? price : total;
    const changeAmt = total - keepAmt;
    const freshProofs = (amount: number): Proof[] => [{
      amount,
      id: "009a1f293253e41e",
      secret: `new_${amount}_${Math.random().toString(36).slice(2, 8)}`,
      C: "02" + "cd".repeat(32),
    }];
    return {
      ok: true,
      keep: freshProofs(keepAmt),
      change: changeAmt > 0 ? freshProofs(changeAmt) : [],
    };
  }
  return { redeemFn };
}

function makeConfig(overrides: Partial<GateAppConfig> = {}): GateAppConfig {
  return {
    trustedMints: [MINT_URL],
    upstreams: [{ match: "*", baseUrl: "https://upstream.test", apiKey: "k" }],
    pricing: [
      { model: "test-model", mode: "per_token" as const, input_per_million: 100000, output_per_million: 500000 },
      { model: "*", mode: "per_token" as const, input_per_million: 50000, output_per_million: 200000 },
    ],
    kvStore: createMockKV(),
    adminToken: ADMIN_TOKEN,
    walletAddress: "0xtestwallet",
    ...overrides,
  };
}

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

// ── Mock fetch ──────────────────────────────────────────────
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────

describe("config validation", () => {
  test("throws when walletAddress is missing", () => {
    expect(() =>
      createGateApp({
        trustedMints: [MINT_URL],
        upstreams: [],
        pricing: [],
        walletAddress: undefined as any,
      })
    ).toThrow(/walletAddress is required/);
  });
});

describe("GET / (landing page)", () => {
  test("returns service info", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.service).toBe("cash2chat");
    expect(body.mints).toEqual([MINT_URL]);
  });
});

describe("GET /health", () => {
  test("returns health with mints and upstreams", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.mints).toEqual([MINT_URL]);
    expect(body.upstreams).toHaveLength(1);
  });
});

describe("GET /v1/info", () => {
  test("returns version info", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/info"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe("cash2chat");
    expect(body.version).toBeDefined();
  });
});

describe("GET /v1/pricing", () => {
  test("returns per_token pricing info", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/pricing"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.unit).toBe("usd");
    expect(body.pricing_mode).toBe("per_token");
    expect(body.exchange_rate.usd_to_units).toBe(100000);
    expect(body.models["test-model"]).toEqual({
      mode: "per_token",
      input_per_million: 100000,
      output_per_million: 500000,
    });
  });

  test("returns per_request pricing (legacy)", async () => {
    const app = createGateApp(makeConfig({
      pricing: [
        { model: "legacy-model", mode: "per_request" as const, per_request: 200 },
      ],
    }));
    const res = await app.fetch(new Request("http://localhost/v1/pricing"));
    const body = await res.json() as any;
    expect(body.models["legacy-model"]).toEqual({
      mode: "per_request",
      per_request: 200,
      deprecated: true,
    });
  });
});

describe("GET /stats (admin)", () => {
  test("returns 401 without auth", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/stats"));
    expect(res.status).toBe(401);
  });

  test("returns 503 when adminToken not configured", async () => {
    const app = createGateApp(makeConfig({ adminToken: undefined }));
    const res = await app.fetch(new Request("http://localhost/stats", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(503);
  });

  test("returns 500 when kvStore unavailable", async () => {
    const app = createGateApp(makeConfig({ kvStore: undefined }));
    const res = await app.fetch(new Request("http://localhost/stats", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(500);
  });

  test("returns today and 7-day summary with auth", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/stats", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.today).toBeDefined();
    expect(body.last_7_days).toBeDefined();
    expect(body.generated_at).toBeDefined();
  });
});

describe("GET /v1/gate/balance (admin)", () => {
  test("returns balance with auth", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/balance", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.balance_units).toBe(0);
    expect(body.unit).toBe("usd");
  });

  test("returns 401 without auth", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/balance"));
    expect(res.status).toBe(401);
  });

  test("returns 500 without kvStore", async () => {
    const app = createGateApp(makeConfig({ kvStore: undefined }));
    const res = await app.fetch(new Request("http://localhost/v1/gate/balance", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(500);
  });
});

describe("POST /v1/gate/melt (admin)", () => {
  test("returns 401 without auth", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/melt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(401);
  });

  test("returns 500 without kvStore", async () => {
    const app = createGateApp(makeConfig({ kvStore: undefined }));
    const res = await app.fetch(new Request("http://localhost/v1/gate/melt", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(500);
  });
});

describe("GET /v1/gate/metrics/summary (admin)", () => {
  test("returns 400 when from/to params missing", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/metrics/summary", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid date format", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/metrics/summary?from=bad&to=bad", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("Invalid date format");
  });

  test("returns summary for valid date range", async () => {
    const app = createGateApp(makeConfig());
    const today = new Date().toISOString().slice(0, 10);
    const res = await app.fetch(
      new Request(`http://localhost/v1/gate/metrics/summary?from=${today}&to=${today}`, {
        headers: adminHeaders(),
      })
    );
    expect(res.status).toBe(200);
  });

  test("returns 500 without kvStore", async () => {
    const app = createGateApp(makeConfig({ kvStore: undefined }));
    const res = await app.fetch(new Request("http://localhost/v1/gate/metrics/summary?from=2025-01-01&to=2025-01-02", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(500);
  });
});

describe("GET /v1/gate/metrics/errors (admin)", () => {
  test("returns 400 when date param missing", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/metrics/errors", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(400);
  });

  test("returns errors for a date", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/metrics/errors?date=2025-01-01", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.date).toBe("2025-01-01");
    expect(body.errors).toBeDefined();
  });
});

describe("GET /v1/gate/metrics (admin)", () => {
  test("returns 400 when date param missing", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/metrics", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(400);
  });

  test("returns metrics for a date", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/metrics?date=2025-01-01", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.date).toBe("2025-01-01");
    expect(body.records).toBeDefined();
  });
});

describe("GET /v1/gate/token-errors (admin)", () => {
  test("returns recent errors without date param", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/token-errors", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.errors).toBeDefined();
    expect(body.count).toBeDefined();
  });

  test("returns errors for specific date", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/token-errors?date=2025-01-01", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.date).toBe("2025-01-01");
  });

  test("returns 500 without kvStore", async () => {
    const app = createGateApp(makeConfig({ kvStore: undefined }));
    const res = await app.fetch(new Request("http://localhost/v1/gate/token-errors", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(500);
  });
});

describe("GET /v1/gate/token-errors/summary (admin)", () => {
  test("returns error summary", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/gate/token-errors/summary", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(200);
  });

  test("returns 500 without kvStore", async () => {
    const app = createGateApp(makeConfig({ kvStore: undefined }));
    const res = await app.fetch(new Request("http://localhost/v1/gate/token-errors/summary", {
      headers: adminHeaders(),
    }));
    expect(res.status).toBe(500);
  });
});

describe("admin brute-force protection", () => {
  test("locks out after 5 failed attempts", async () => {
    const app = createGateApp(makeConfig());

    // Send 5 failed auth attempts with same IP
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(new Request("http://localhost/v1/gate/balance", {
        headers: {
          Authorization: "Bearer wrong-token",
          "X-Forwarded-For": "1.2.3.4",
        },
      }));
      if (i < 4) {
        expect(res.status).toBe(401);
      } else {
        // 5th attempt triggers lockout
        expect(res.status).toBe(429);
      }
    }

    // 6th attempt should also be locked out even with correct token
    const res = await app.fetch(new Request("http://localhost/v1/gate/balance", {
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "X-Forwarded-For": "1.2.3.4",
      },
    }));
    expect(res.status).toBe(429);
  });
});

describe("SSE streaming with change token", () => {
  test("emits cashu-change SSE event for overpayment", async () => {
    const { redeemFn } = createMockRedeem();
    const app = createGateApp(makeConfig({
      redeemFn,
      pricing: [{ model: "*", mode: "per_request" as const, per_request: 100 }],
    }));

    // Mock upstream SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const token = makeToken([256]); // 256 > 100, so there's change
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
          stream: true,
        }),
      })
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // Should contain the cashu-change SSE event
    expect(text).toContain("event: cashu-change");
    expect(text).toContain("cashuB");
  });
});

describe("executionCtx.waitUntil metric path", () => {
  test("uses waitUntil when available", async () => {
    const { redeemFn } = createMockRedeem();
    const kv = createMockKV();
    // Use per_request pricing so token amount is straightforward
    const app = createGateApp(makeConfig({
      redeemFn,
      kvStore: kv,
      pricing: [{ model: "*", mode: "per_request" as const, per_request: 100 }],
    }));

    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      })
    );

    const waitUntilFn = vi.fn();
    const token = makeToken([256]);
    const res = await app.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cashu": token,
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }),
      {},
      { waitUntil: waitUntilFn, passThroughOnException: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    // waitUntil should have been called for metric writing
    expect(waitUntilFn).toHaveBeenCalled();
  });
});

describe("CORS", () => {
  test("OPTIONS returns 204", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "OPTIONS",
    }));
    expect(res.status).toBe(204);
  });
});

describe("version header", () => {
  test("all responses include X-Gate-Version", async () => {
    const app = createGateApp(makeConfig());
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.headers.get("X-Gate-Version")).toBeTruthy();
  });
});
