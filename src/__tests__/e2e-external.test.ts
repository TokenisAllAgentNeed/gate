/**
 * E2E tests — Layer 3: External mint (testnut.cashu.space)
 *
 * Tests real Cashu protocol compatibility with an external mint.
 * Skipped by default — run with: EXTERNAL_TESTS=1 pnpm test
 *
 * These tests are slower (2-5s per swap) and may be flaky due to
 * rate limiting on the public testnut service.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  CashuMint,
  CashuWallet,
  getEncodedTokenV4,
  type Proof,
} from "@cashu/cashu-ts";
import { decodeStamp, type Stamp } from "../lib/index.js";
import { createRedeemFn, type RedeemResult } from "../redeem.js";
import { createGateApp, makeRequest } from "./helpers/gate-app.js";
import { createMockUpstream } from "./helpers/mock-upstream.js";

const EXTERNAL = !!process.env.EXTERNAL_TESTS;
const TESTNUT_URL = "https://testnut.cashu.space";
const PRICE = 4; // Use small amounts to minimize testnut load
const FEE_TOLERANCE = 2; // testnut may charge ~1 sat swap fee

let wallet: CashuWallet;
let tokens: string[] = [];

// Pre-mint tokens for all tests
beforeAll(async () => {
  if (!EXTERNAL) return;

  const mint = new CashuMint(TESTNUT_URL);
  wallet = new CashuWallet(mint);
  await wallet.loadMint();

  // Mint 3 small tokens: exact, overpay, double-spend test
  for (let i = 0; i < 3; i++) {
    try {
      const quote = await wallet.createMintQuote(8); // 8 sats each
      // testnut auto-pays quotes in test mode
      await new Promise((r) => setTimeout(r, 1000));
      const proofs = await wallet.mintProofs(8, quote.quote);
      tokens.push(getEncodedTokenV4({ mint: TESTNUT_URL, proofs, unit: "usd" }));
    } catch (e) {
      console.warn(`Failed to mint token ${i}:`, e);
    }
  }
}, 60_000);

function buildExternalApp() {
  const mockUpstream = createMockUpstream();
  const redeemFn = createRedeemFn();

  return createGateApp({
    trustedMints: [TESTNUT_URL],
    pricing: [
      { model: "mock-ok", mode: "per_request", per_request: PRICE },
      { model: "mock-500", mode: "per_request", per_request: PRICE },
      { model: "*", mode: "per_request", per_request: PRICE },
    ],
    redeemFn,
    upstreamFetch: (req) => mockUpstream.fetch(req),
  });
}

describe.skipIf(!EXTERNAL)("E2E External Mint (testnut)", () => {
  it("real swap + upstream success → 200 + receipt", async () => {
    expect(tokens.length).toBeGreaterThan(0);
    const app = buildExternalApp();
    const res = await makeRequest(app, { token: tokens[0], model: "mock-ok" });
    expect(res.status).toBe(200);

    const receipt = res.headers.get("X-Cashu-Receipt");
    expect(receipt).toBeTruthy();
    const parsed = JSON.parse(receipt!);
    expect(parsed.amount).toBe(PRICE);
  }, 30_000);

  it("double-spend → 400", async () => {
    expect(tokens.length).toBeGreaterThan(0);
    const app = buildExternalApp();
    // tokens[0] was already spent in previous test
    const res = await makeRequest(app, { token: tokens[0], model: "mock-ok" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("token_spent");
  }, 30_000);

  it("upstream 500 → 502 + refund with fee tolerance", async () => {
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    const app = buildExternalApp();
    const res = await makeRequest(app, { token: tokens[1], model: "mock-500" });
    expect(res.status).toBe(502);

    const refundHeader = res.headers.get("X-Cashu-Refund");
    expect(refundHeader).toBeTruthy();

    const refundStamp = decodeStamp(refundHeader!);
    // testnut may charge a fee on swap, so refund could be slightly less
    expect(refundStamp.amount).toBeGreaterThanOrEqual(8 - FEE_TOLERANCE);
  }, 30_000);
});
