/**
 * Integration test: connects to a real Cashu testnet mint.
 *
 * Uses https://nofees.testnut.cashu.space — a public test mint
 * with unbacked fake ecash (no real sats needed).
 *
 * Run with: npx vitest run redeem.integration
 *
 * Skipped in CI (no network access to external mints).
 */
import { describe, it, expect } from "vitest";
import {
  CashuMint,
  CashuWallet,
  MintQuoteState,
  getEncodedTokenV4,
} from "@cashu/cashu-ts";
import { createRedeemFn } from "../redeem.js";
import { decodeStamp } from "../lib/index.js";

const TEST_MINT = "https://testnut.cashu.space";

// Skip in CI environment (GitHub Actions sets CI=true)
const isCI = process.env.CI === "true";

// Helper: mint fresh test tokens from the testnut mint
async function mintTestTokens(amount: number): Promise<string> {
  const mint = new CashuMint(TEST_MINT);
  const wallet = new CashuWallet(mint);
  await wallet.loadMint();

  // Create a mint quote
  const quote = await wallet.createMintQuote(amount);

  // Poll until paid (testnut mints are instant/auto-paid for small amounts)
  let state: MintQuoteState | undefined;
  for (let i = 0; i < 30; i++) {
    const checked = await wallet.checkMintQuote(quote.quote);
    state = checked.state;
    if (state === MintQuoteState.PAID || state === MintQuoteState.ISSUED) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (state !== MintQuoteState.PAID && state !== MintQuoteState.ISSUED) {
    throw new Error(
      `Mint quote not paid after 30s (state: ${state}). ` +
        `Invoice: ${quote.request}`
    );
  }

  // Mint the proofs
  const proofs = await wallet.mintProofs(amount, quote.quote);

  // Encode as V4 token
  return getEncodedTokenV4({
    mint: TEST_MINT,
    proofs,
    unit: "usd",
  });
}

describe.skipIf(isCI)("createRedeemFn (real mint)", () => {
  it(
    "should successfully redeem a fresh token",
    async () => {
      const redeemedProofs: any[] = [];
      const redeemFn = createRedeemFn({
        onRedeem: (_mint, proofs) => redeemedProofs.push(...proofs),
      });

      // Mint 64 sat of test tokens
      const tokenStr = await mintTestTokens(64);
      console.log("Minted test token:", tokenStr.slice(0, 60) + "...");

      const stamp = decodeStamp(tokenStr);
      expect(stamp.amount).toBe(64);
      expect(stamp.mint).toBe(TEST_MINT);

      // Redeem (swap) the token
      const result = await redeemFn(stamp);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify we got new proofs
      expect(redeemedProofs.length).toBeGreaterThan(0);
      const totalRedeemed = redeemedProofs.reduce(
        (s: number, p: any) => s + p.amount,
        0
      );
      // testnut may have small fees, so redeemed amount could be <= original
      expect(totalRedeemed).toBeGreaterThan(0);
      expect(totalRedeemed).toBeLessThanOrEqual(64);
    },
    60_000
  );

  it(
    "should reject a double-spent token",
    async () => {
      const redeemFn = createRedeemFn();

      // Mint and redeem once
      const tokenStr = await mintTestTokens(32);
      const stamp = decodeStamp(tokenStr);

      const first = await redeemFn(stamp);
      expect(first.ok).toBe(true);

      // Try to redeem the same token again — should fail
      const second = await redeemFn(stamp);
      expect(second.ok).toBe(false);
      expect(second.error).toBeDefined();
      console.log("Double-spend rejection:", second.error);
    },
    60_000
  );
});
