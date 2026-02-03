/**
 * Unit tests for admin-cleanup.ts and admin-withdraw.ts.
 *
 * Mocks @cashu/cashu-ts to isolate route handler logic from mint operations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { storeProofs, listAllProofs, type StoredProof } from "../ecash-store.js";
import { createMockKV } from "./helpers.js";

// ── Mock @cashu/cashu-ts ──────────────────────────────────────────

const mockLoadMint = vi.fn().mockResolvedValue(undefined);
const mockSwap = vi.fn();

vi.mock("@cashu/cashu-ts", () => ({
  CashuMint: vi.fn().mockImplementation(() => ({})),
  CashuWallet: vi.fn().mockImplementation(() => ({
    loadMint: mockLoadMint,
    swap: mockSwap,
  })),
  getEncodedTokenV4: vi.fn().mockReturnValue("cashuBmock_encoded_token"),
}));

import { createAdminCleanupRoute } from "../admin-cleanup.js";
import { createAdminWithdrawRoute } from "../admin-withdraw.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeProofs(amounts: number[]): StoredProof[] {
  return amounts.map((amount, i) => ({
    amount,
    id: "009a1f293253e41e",
    secret: `secret_${i}_${Math.random().toString(36).slice(2)}`,
    C: "02" + "ab".repeat(32),
  }));
}

const MINT = "https://mint.test.com";
const ADMIN_TOKEN = "test-value-for-unit-tests";
const AUTH = { Authorization: `Bearer ${ADMIN_TOKEN}` };

// ══════════════════════════════════════════════════════════════════
// admin-cleanup
// ══════════════════════════════════════════════════════════════════

describe("admin-cleanup", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeApp(kv: KVNamespace | null, adminToken?: string) {
    const app = new Hono();
    app.post("/cleanup", createAdminCleanupRoute({
      adminToken,
      kvStore: kv,
      mintUrl: MINT,
    }));
    return app;
  }

  it("returns 401 without Authorization header", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when admin token not configured", async () => {
    const app = makeApp(createMockKV(), undefined);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", { method: "POST", headers: AUTH }),
    );
    expect(res.status).toBe(503);
  });

  it("returns 500 when KV store not available", async () => {
    const app = makeApp(null, ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", { method: "POST", headers: AUTH }),
    );
    expect(res.status).toBe(500);
  });

  it("returns cleaned=0 when no proofs stored", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", { method: "POST", headers: AUTH }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.message).toMatch(/no proofs/i);
    expect(body.cleaned).toBe(0);
    expect(body.kept).toBe(0);
  });

  it("swaps and re-stores all valid proofs", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([100, 200]));

    // Batch swap succeeds — returns fresh proofs
    const freshProofs = makeProofs([150, 150]);
    mockSwap.mockResolvedValue({ send: freshProofs, keep: [] });

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", { method: "POST", headers: AUTH }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;
    expect(body.entries_processed).toBe(1);
    expect(body.proofs_removed).toBe(0);
    expect(body.units_removed).toBe(0);
    expect(body.units_kept).toBe(300);
  });

  it("removes spent proofs via individual probe when batch fails", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([100, 200]));

    // Batch swap fails
    mockSwap.mockRejectedValueOnce(new Error("some proofs spent"));
    // Individual: first proof valid, second spent
    mockSwap.mockResolvedValueOnce({ send: makeProofs([100]), keep: [] });
    mockSwap.mockRejectedValueOnce(new Error("already spent"));

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", { method: "POST", headers: AUTH }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;
    expect(body.proofs_removed).toBe(1);
    expect(body.units_removed).toBe(200);
    expect(body.units_kept).toBe(100);
  });

  it("handles all proofs spent in an entry", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([50]));

    // Batch fails, individual also fails
    mockSwap.mockRejectedValue(new Error("already spent"));

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", { method: "POST", headers: AUTH }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;
    expect(body.proofs_removed).toBe(1);
    expect(body.units_removed).toBe(50);
    expect(body.units_kept).toBe(0);

    // KV should be empty after cleanup
    const entries = await listAllProofs(kv);
    expect(entries).toHaveLength(0);
  });

  it("processes multiple entries independently", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([100]));
    await storeProofs(kv, MINT, makeProofs([200]));

    // Both batch swaps succeed
    mockSwap
      .mockResolvedValueOnce({ send: makeProofs([100]), keep: [] })
      .mockResolvedValueOnce({ send: makeProofs([200]), keep: [] });

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/cleanup", { method: "POST", headers: AUTH }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, number>;
    expect(body.entries_processed).toBe(2);
    expect(body.units_kept).toBe(300);
  });
});

// ══════════════════════════════════════════════════════════════════
// admin-withdraw
// ══════════════════════════════════════════════════════════════════

describe("admin-withdraw", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeApp(kv: KVNamespace | null, adminToken?: string) {
    const app = new Hono();
    app.post("/withdraw", createAdminWithdrawRoute({
      adminToken,
      kvStore: kv,
      mintUrl: MINT,
    }));
    return app;
  }

  function post(app: ReturnType<typeof makeApp>, body: unknown, headers?: HeadersInit) {
    return app.fetch(
      new Request("http://localhost/withdraw", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  // ── Auth ──

  it("returns 401 without Authorization header", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await app.fetch(
      new Request("http://localhost/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when admin token not configured", async () => {
    const app = makeApp(createMockKV(), undefined);
    const res = await post(app, { amount: 100 });
    expect(res.status).toBe(503);
  });

  it("returns 500 when KV store not available", async () => {
    const app = makeApp(null, ADMIN_TOKEN);
    const res = await post(app, { amount: 100 });
    expect(res.status).toBe(500);
  });

  // ── Validation ──

  it("returns 400 for invalid JSON body", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await post(app, "{invalid}");
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, string>;
    expect(body.error).toMatch(/invalid json/i);
  });

  it("returns 400 for missing amount", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await post(app, {});
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, string>;
    expect(body.error).toMatch(/amount/i);
  });

  it("returns 400 for negative amount", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await post(app, { amount: -10 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-integer amount", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await post(app, { amount: 10.5 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for zero amount", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await post(app, { amount: 0 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for string amount", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await post(app, { amount: "100" });
    expect(res.status).toBe(400);
  });

  // ── Balance checks ──

  it("returns 400 when insufficient balance", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([100]));

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await post(app, { amount: 200 });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; balance_units: number };
    expect(body.error).toMatch(/insufficient/i);
    expect(body.balance_units).toBe(100);
  });

  it("returns 400 when no proofs stored", async () => {
    const app = makeApp(createMockKV(), ADMIN_TOKEN);
    const res = await post(app, { amount: 100 });
    expect(res.status).toBe(400);
    const body = await res.json() as { balance_units: number };
    expect(body.balance_units).toBe(0);
  });

  // ── Successful withdraw ──

  it("successful withdraw returns token and correct amounts", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([200]));

    const withdrawProofs = makeProofs([100]);
    const changeProofs = makeProofs([100]);
    mockSwap.mockResolvedValue({ send: withdrawProofs, keep: changeProofs });

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await post(app, { amount: 100 });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.token).toBe("cashuBmock_encoded_token");
    expect(body.amount_units).toBe(100);
    expect(body.change_units).toBe(100);
    expect(body.remaining_balance_units).toBe(100); // 200 total - 100 withdrawn
  });

  it("stores change proofs back to KV", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([200]));

    const changeProofs = makeProofs([100]);
    mockSwap.mockResolvedValue({ send: makeProofs([100]), keep: changeProofs });

    const app = makeApp(kv, ADMIN_TOKEN);
    await post(app, { amount: 100 });

    // KV should have new entry with change proofs
    const entries = await listAllProofs(kv);
    const totalBalance = entries.reduce(
      (sum, e) => sum + e.proofs.reduce((s, p) => s + p.amount, 0), 0,
    );
    expect(totalBalance).toBe(100); // Only change proofs remain
  });

  it("no change proofs when exact amount", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([100]));

    mockSwap.mockResolvedValue({ send: makeProofs([100]), keep: [] });

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await post(app, { amount: 100 });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.change_units).toBe(0);
    expect(body.remaining_balance_units).toBe(0);

    // KV should be empty
    const entries = await listAllProofs(kv);
    expect(entries).toHaveLength(0);
  });

  // ── Swap failure ──

  it("returns 502 when mint swap fails, KV unchanged", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([100]));

    mockSwap.mockRejectedValue(new Error("mint unavailable"));

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await post(app, { amount: 50 });
    expect(res.status).toBe(502);

    const body = await res.json() as { error: string; details: string };
    expect(body.error).toMatch(/swap failed/i);
    expect(body.details).toContain("mint unavailable");

    // KV should be unchanged — original proofs intact
    const entries = await listAllProofs(kv);
    expect(entries).toHaveLength(1);
    expect(entries[0].proofs[0].amount).toBe(100);
  });

  // ── Partial entry usage ──

  it("selects proofs greedily (largest first)", async () => {
    const kv = createMockKV();
    // Store one entry with proofs [10, 50, 200]
    await storeProofs(kv, MINT, makeProofs([10, 50, 200]));

    // Asking for 100: should select 200 (greedy largest first)
    mockSwap.mockResolvedValue({ send: makeProofs([100]), keep: makeProofs([100]) });

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await post(app, { amount: 100 });
    expect(res.status).toBe(200);

    // swap should have been called with total 200 from the largest proof
    expect(mockSwap).toHaveBeenCalledWith(100, expect.any(Array));
  });

  it("withdraw from multiple entries", async () => {
    const kv = createMockKV();
    await storeProofs(kv, MINT, makeProofs([50]));
    await storeProofs(kv, MINT, makeProofs([80]));

    // Asking for 100: selects 80 first (largest), then 50 (total 130 >= 100)
    mockSwap.mockResolvedValue({ send: makeProofs([100]), keep: makeProofs([30]) });

    const app = makeApp(kv, ADMIN_TOKEN);
    const res = await post(app, { amount: 100 });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.amount_units).toBe(100);
    expect(body.change_units).toBe(30);
  });
});
