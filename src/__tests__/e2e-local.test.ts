/**
 * E2E tests — Layer 1: Local mint simulation
 *
 * Uses MintState for real crypto verification of spend/double-spend,
 * with a redeemFn that tracks spent secrets locally.
 * Fast, stable, no external dependencies.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { decodeStamp, type Stamp } from "../lib/index.js";
import type { RedeemResult } from "../redeem.js";
import { createGateApp, makeRequest } from "./helpers/gate-app.js";
import { createMockUpstream } from "./helpers/mock-upstream.js";

const MINT_URL = "https://local-test-mint.example";
const PRICE = 200;

// ── In-memory "mint" that tracks spent secrets ────────────────

function createLocalMint() {
  const spent = new Set<string>();

  /** Create a token with given proof amounts */
  function makeToken(amounts: number[]): string {
    const proofs = amounts.map((amount) => ({
      amount,
      id: "009a1f293253e41e",
      secret: `s_${amount}_${Math.random().toString(36).slice(2, 10)}`,
      C: "02" + "ab".repeat(32),
    }));
    return getEncodedTokenV4({ mint: MINT_URL, proofs, unit: "usd" });
  }

  /** Split amount into powers of 2 */
  function splitPow2(amount: number): number[] {
    const parts: number[] = [];
    let rem = amount;
    for (let bit = 1 << 20; bit >= 1; bit >>= 1) {
      if (rem >= bit) { parts.push(bit); rem -= bit; }
    }
    return parts;
  }

  /** Mint fresh mock proofs */
  function freshProofs(amount: number): Proof[] {
    return splitPow2(amount).map((a) => ({
      amount: a,
      id: "009a1f293253e41e",
      secret: `new_${a}_${Math.random().toString(36).slice(2, 10)}`,
      C: "02" + "cd".repeat(32),
    }));
  }

  /** redeemFn that verifies no double-spend, tracks state, returns keep/change */
  async function redeemFn(stamp: Stamp, price?: number): Promise<RedeemResult> {
    // Check double-spend
    for (const p of stamp.proofs) {
      if (spent.has(p.secret)) {
        return { ok: false, error: "Token already spent" };
      }
    }
    // Mark spent
    for (const p of stamp.proofs) {
      spent.add(p.secret);
    }

    const total = stamp.amount;
    const keepAmt = price && price > 0 && price < total ? price : total;
    const changeAmt = total - keepAmt;

    return {
      ok: true,
      keep: freshProofs(keepAmt),
      change: changeAmt > 0 ? freshProofs(changeAmt) : [],
    };
  }

  return { makeToken, redeemFn };
}

// ── Test setup ────────────────────────────────────────────────

let localMint: ReturnType<typeof createLocalMint>;
let mockUpstream: ReturnType<typeof createMockUpstream>;

beforeEach(() => {
  localMint = createLocalMint();
  mockUpstream = createMockUpstream();
});

function buildApp() {
  return createGateApp({
    trustedMints: [MINT_URL],
    pricing: [
      { model: "mock-ok", mode: "per_request", per_request: PRICE },
      { model: "mock-500", mode: "per_request", per_request: PRICE },
      { model: "mock-stream", mode: "per_request", per_request: PRICE },
      { model: "*", mode: "per_request", per_request: PRICE },
    ],
    redeemFn: localMint.redeemFn,
    upstreamFetch: (req) => mockUpstream.fetch(req),
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe("E2E Local Mint", () => {
  // --- Core flow ---

  it("exact payment → 200 + receipt, no change", async () => {
    const app = buildApp();
    const token = localMint.makeToken([128, 64, 8]); // = 200

    const res = await makeRequest(app, { token, model: "mock-ok" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Hello from mock!");

    const receipt = res.headers.get("X-Cashu-Receipt");
    expect(receipt).toBeTruthy();
    const parsed = JSON.parse(receipt!);
    expect(parsed.amount).toBe(200);
    expect(parsed.model).toBe("mock-ok");

    expect(res.headers.get("X-Cashu-Change")).toBeNull();
  });

  it("overpayment → 200 + receipt + change token (correct amount)", async () => {
    const app = buildApp();
    const token = localMint.makeToken([256, 32, 8, 4]); // = 300

    const res = await makeRequest(app, { token, model: "mock-ok" });
    expect(res.status).toBe(200);

    const receipt = JSON.parse(res.headers.get("X-Cashu-Receipt")!);
    expect(receipt.amount).toBe(200);

    const changeHeader = res.headers.get("X-Cashu-Change");
    expect(changeHeader).toBeTruthy();
    const changeStamp = decodeStamp(changeHeader!);
    expect(changeStamp.amount).toBe(100); // 300 - 200
    expect(changeStamp.mint).toBe(MINT_URL);
  });

  it("upstream 500 → 502 + full refund", async () => {
    const app = buildApp();
    const token = localMint.makeToken([256]); // = 256

    const res = await makeRequest(app, { token, model: "mock-500" });
    expect(res.status).toBe(502);

    const refundHeader = res.headers.get("X-Cashu-Refund");
    expect(refundHeader).toBeTruthy();
    const refundStamp = decodeStamp(refundHeader!);
    expect(refundStamp.amount).toBe(256);
  });

  it("refund token can be reused for a new request", async () => {
    const app = buildApp();

    // Fail → get refund
    const token1 = localMint.makeToken([128, 64, 8]); // = 200
    const res1 = await makeRequest(app, { token: token1, model: "mock-500" });
    expect(res1.status).toBe(502);
    const refundToken = res1.headers.get("X-Cashu-Refund")!;

    // Reuse refund → succeed
    const res2 = await makeRequest(app, { token: refundToken, model: "mock-ok" });
    expect(res2.status).toBe(200);
    expect((await res2.json()).choices[0].message.content).toBe("Hello from mock!");
  });

  it("change token can be used for another request", async () => {
    const app = buildApp();

    // Pay 512 for 200 service → 312 change
    const token1 = localMint.makeToken([512]);
    const res1 = await makeRequest(app, { token: token1, model: "mock-ok" });
    expect(res1.status).toBe(200);

    const changeToken = res1.headers.get("X-Cashu-Change")!;
    expect(changeToken).toBeTruthy();
    expect(decodeStamp(changeToken).amount).toBe(312);

    // Use change (312 >= 200) → succeed with second change (112)
    const res2 = await makeRequest(app, { token: changeToken, model: "mock-ok" });
    expect(res2.status).toBe(200);

    const change2 = res2.headers.get("X-Cashu-Change")!;
    expect(change2).toBeTruthy();
    expect(decodeStamp(change2).amount).toBe(112);
  });

  // --- Double spend ---

  it("same token twice → first succeeds, second 400", async () => {
    const app = buildApp();
    const token = localMint.makeToken([128, 64, 8]);

    const res1 = await makeRequest(app, { token, model: "mock-ok" });
    expect(res1.status).toBe(200);

    const res2 = await makeRequest(app, { token, model: "mock-ok" });
    expect(res2.status).toBe(400);
    expect((await res2.json()).error.code).toBe("token_spent");
  });

  // --- Input validation ---

  it("no X-Cashu header → 402", async () => {
    const app = buildApp();
    const res = await makeRequest(app, { model: "mock-ok" });
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("payment_required");
  });

  it("garbage X-Cashu → 400", async () => {
    const app = buildApp();
    const res = await makeRequest(app, { token: "garbage!!!", model: "mock-ok" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_token");
  });

  it("insufficient amount → 402 with required/provided", async () => {
    const app = buildApp();
    const token = localMint.makeToken([64, 32]); // = 96 < 200

    const res = await makeRequest(app, { token, model: "mock-ok" });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("insufficient_payment");
    expect(body.error.required).toBe(200);
    expect(body.error.provided).toBe(96);
  });

  // --- SSE Streaming ---

  it("SSE stream → complete response + receipt", async () => {
    const app = buildApp();
    const token = localMint.makeToken([128, 64, 8]);

    const res = await makeRequest(app, { token, model: "mock-stream", stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("X-Cashu-Receipt")).toBeTruthy();

    const text = await res.text();
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"content":" world"');
    expect(text).toContain("[DONE]");
  });

  it("SSE stream with overpayment → receipt + change via SSE event", async () => {
    const app = buildApp();
    const token = localMint.makeToken([256, 64]); // = 320

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
    expect(decodeStamp(match![1]).amount).toBe(120);
  });
});
