/**
 * Admin Melt to Lightning tests — melt Gate ecash to Lightning invoice.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Variables } from "../create-app.js";

// ── Mock CashuWallet ──────────────────────────────────────────────
const mockLoadMint = vi.fn().mockResolvedValue(undefined);
const mockCreateMeltQuote = vi.fn();
const mockMeltProofs = vi.fn();

vi.mock("@cashu/cashu-ts", () => ({
  CashuMint: vi.fn().mockImplementation(() => ({})),
  CashuWallet: vi.fn().mockImplementation(() => ({
    loadMint: mockLoadMint,
    createMeltQuote: mockCreateMeltQuote,
    meltProofs: mockMeltProofs,
  })),
}));

// ── Mock KV Store ─────────────────────────────────────────────────
const mockKvData = new Map<string, string>();
const mockKv = {
  get: vi.fn(async (key: string) => mockKvData.get(key) ?? null),
  put: vi.fn(async (key: string, value: string) => { mockKvData.set(key, value); }),
  delete: vi.fn(async (key: string) => { mockKvData.delete(key); }),
  list: vi.fn(async (opts?: { prefix?: string }) => {
    const keys = [];
    for (const [name] of mockKvData) {
      if (!opts?.prefix || name.startsWith(opts.prefix)) {
        keys.push({ name });
      }
    }
    return { keys, list_complete: true, cursor: undefined };
  }),
};

// ── Test setup ────────────────────────────────────────────────────
const TEST_ADMIN_TOKEN = "test-admin-token-12345";
const TEST_MINT_URL = "https://mint.test.local";

// Import after mocks are set up
import { createAdminMeltLnRoute, createAdminBalanceLnRoute } from "../admin-melt-ln.js";

describe("POST /admin/melt-ln", () => {
  beforeEach(() => {
    mockKvData.clear();
    vi.clearAllMocks();
    // Re-setup the loadMint mock after clearAllMocks
    mockLoadMint.mockResolvedValue(undefined);
  });

  test("returns 401 without Authorization header", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice: "lnbc10n1..." }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 with invalid token", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong-token",
      },
      body: JSON.stringify({ invoice: "lnbc10n1..." }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 503 when admin endpoint not available", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: undefined,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc10n1..." }),
    });
    expect(res.status).toBe(503);
  });

  test("returns 400 when no invoice provided", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("invoice");
  });

  test("returns 400 when no proofs available", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc1000n1pj..." }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("No proofs");
  });

  test("returns 500 when KV not available", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: null,
      mintUrl: TEST_MINT_URL,
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc1000n1pj..." }),
    });
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toContain("Storage");
  });

  test("returns 400 when balance is insufficient for invoice amount", async () => {
    mockCreateMeltQuote.mockResolvedValue({
      quote: "quote123",
      amount: 500,
      fee_reserve: 10,
      unit: "usd",
      state: "UNPAID",
      expiry: Date.now() + 60000,
    });

    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    mockKvData.set("proofs:123:abc", JSON.stringify({
      mintUrl: TEST_MINT_URL,
      proofs: [
        { amount: 50, id: "key1", secret: "s1", C: "c1" },
        { amount: 50, id: "key1", secret: "s2", C: "c2" },
      ],
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc5000n1pj..." }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("Insufficient balance");
    expect(body.balance_units).toBe(100);
    expect(body.required_units).toBe(510);
  });

  test("stores change proofs back to KV after successful melt", async () => {
    mockCreateMeltQuote.mockResolvedValue({
      quote: "quote-abc",
      amount: 900,
      fee_reserve: 100,
      unit: "usd",
      state: "UNPAID",
    });
    mockMeltProofs.mockResolvedValue({
      quote: { state: "PAID", payment_preimage: "preimage123" },
      change: [
        { amount: 64, id: "change_key1", secret: "cs1", C: "cc1" },
        { amount: 31, id: "change_key2", secret: "cs2", C: "cc2" },
      ],
    });

    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    mockKvData.set("proofs:123:abc", JSON.stringify({
      mintUrl: TEST_MINT_URL,
      proofs: [
        { amount: 500, id: "key1", secret: "s1", C: "c1" },
        { amount: 500, id: "key1", secret: "s2", C: "c2" },
      ],
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc9000n1pj..." }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.change_units).toBe(95);

    // Original proofs entry should be deleted
    expect(mockKvData.has("proofs:123:abc")).toBe(false);

    // Change proofs should be stored in KV
    const newEntries = Array.from(mockKvData.entries())
      .filter(([k]) => k.startsWith("proofs:"));
    expect(newEntries.length).toBe(1);

    const storedChange = JSON.parse(newEntries[0][1]);
    expect(storedChange.proofs).toHaveLength(2);
    const storedAmount = storedChange.proofs.reduce(
      (s: number, p: { amount: number }) => s + p.amount, 0
    );
    expect(storedAmount).toBe(95);
  });

  test("does not store change when melt returns no change proofs", async () => {
    mockCreateMeltQuote.mockResolvedValue({
      quote: "quote-def",
      amount: 90,
      fee_reserve: 10,
      unit: "usd",
      state: "UNPAID",
    });
    mockMeltProofs.mockResolvedValue({
      quote: { state: "PAID", payment_preimage: "preimage456" },
      change: [],
    });

    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    mockKvData.set("proofs:456:def", JSON.stringify({
      mintUrl: TEST_MINT_URL,
      proofs: [
        { amount: 100, id: "key1", secret: "s1", C: "c1" },
      ],
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc900n1pj..." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.change_units).toBe(0);

    // Original should be deleted, no new entries
    expect(mockKvData.has("proofs:456:def")).toBe(false);
    const remaining = Array.from(mockKvData.keys()).filter(k => k.startsWith("proofs:"));
    expect(remaining.length).toBe(0);
  });
});

describe("GET /admin/balance-ln", () => {
  beforeEach(() => {
    mockKvData.clear();
    vi.clearAllMocks();
  });

  test("returns ecash balance", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.get("/admin/balance-ln", createAdminBalanceLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
    }));

    mockKvData.set("proofs:123:abc", JSON.stringify({
      mintUrl: TEST_MINT_URL,
      proofs: [
        { amount: 100, id: "key1", secret: "s1", C: "c1" },
        { amount: 200, id: "key1", secret: "s2", C: "c2" },
      ],
    }));

    const res = await app.request("/admin/balance-ln", {
      method: "GET",
      headers: { "Authorization": `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.balance_units).toBe(300);
    expect(body.proof_count).toBe(2);
  });

  test("returns 401 without auth", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.get("/admin/balance-ln", createAdminBalanceLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
    }));

    const res = await app.request("/admin/balance-ln", { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("returns 500 when KV not available", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.get("/admin/balance-ln", createAdminBalanceLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: null,
    }));

    const res = await app.request("/admin/balance-ln", {
      method: "GET",
      headers: { "Authorization": `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toContain("Storage");
  });
});

describe("POST /admin/melt-ln — error paths", () => {
  beforeEach(() => {
    mockKvData.clear();
    vi.clearAllMocks();
    mockLoadMint.mockResolvedValue(undefined);
  });

  test("returns 502 when meltProofs throws", async () => {
    mockCreateMeltQuote.mockResolvedValue({
      quote: "quote-err",
      amount: 50,
      fee_reserve: 5,
      unit: "usd",
      state: "UNPAID",
    });
    mockMeltProofs.mockRejectedValue(new Error("Lightning payment failed"));

    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    mockKvData.set("proofs:789:xyz", JSON.stringify({
      mintUrl: TEST_MINT_URL,
      proofs: [
        { amount: 100, id: "key1", secret: "s1", C: "c1" },
      ],
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc500n1pj..." }),
    });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error).toBe("Melt transfer failed");
    expect(body.details).toContain("Lightning payment failed");
  });

  test("returns 400 for invalid JSON body", async () => {
    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("Invalid JSON");
  });

  test("returns 502 when createMeltQuote throws", async () => {
    mockCreateMeltQuote.mockRejectedValue(new Error("Mint unreachable"));

    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    mockKvData.set("proofs:111:aaa", JSON.stringify({
      mintUrl: TEST_MINT_URL,
      proofs: [
        { amount: 200, id: "key1", secret: "s1", C: "c1" },
      ],
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc2000n1pj..." }),
    });
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error).toBe("Melt quote failed");
  });

  test("handles UNPAID melt result without deleting proofs", async () => {
    mockCreateMeltQuote.mockResolvedValue({
      quote: "quote-unpaid",
      amount: 50,
      fee_reserve: 5,
      unit: "usd",
      state: "UNPAID",
    });
    mockMeltProofs.mockResolvedValue({
      quote: { state: "UNPAID", payment_preimage: null },
      change: [],
    });

    const app = new Hono<{ Variables: Variables }>();
    app.post("/admin/melt-ln", createAdminMeltLnRoute({
      adminToken: TEST_ADMIN_TOKEN,
      kvStore: mockKv as any,
      mintUrl: TEST_MINT_URL,
    }));

    mockKvData.set("proofs:222:bbb", JSON.stringify({
      mintUrl: TEST_MINT_URL,
      proofs: [
        { amount: 100, id: "key1", secret: "s1", C: "c1" },
      ],
    }));

    const res = await app.request("/admin/melt-ln", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ invoice: "lnbc500n1pj..." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    // Proofs should NOT be deleted when payment is UNPAID
    expect(mockKvData.has("proofs:222:bbb")).toBe(true);
  });
});
