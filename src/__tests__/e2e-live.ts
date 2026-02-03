/**
 * Live E2E test script — mints real test tokens, sends to running gate.
 *
 * Prerequisites:
 *   - Gate server running on localhost:10402
 *   - TRUSTED_MINTS includes https://testnut.cashu.space
 *
 * Usage: npx tsx src/__tests__/e2e-live.ts
 */
import {
  CashuMint,
  CashuWallet,
  MintQuoteState,
  getEncodedTokenV4,
} from "@cashu/cashu-ts";

const GATE_URL = "http://localhost:10402";
const MINT_URL = "https://testnut.cashu.space";

async function mintTestTokens(amount: number): Promise<string> {
  console.log(`⏳ Minting ${amount} sat from ${MINT_URL}...`);
  const mint = new CashuMint(MINT_URL);
  const wallet = new CashuWallet(mint);
  await wallet.loadMint();

  const quote = await wallet.createMintQuote(amount);

  for (let i = 0; i < 30; i++) {
    const checked = await wallet.checkMintQuote(quote.quote);
    if (
      checked.state === MintQuoteState.PAID ||
      checked.state === MintQuoteState.ISSUED
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const proofs = await wallet.mintProofs(amount, quote.quote);
  const token = getEncodedTokenV4({ mint: MINT_URL, proofs, unit: "usd" });
  console.log(`✅ Minted! Token: ${token.slice(0, 50)}...`);
  return token;
}

async function main() {
  // Test 1: No token → 402
  console.log("\n--- Test 1: No token → 402 ---");
  const res1 = await fetch(`${GATE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  console.log(`Status: ${res1.status}`);
  console.log(`Body:`, await res1.json());

  // Test 2: Valid token, insufficient amount → 402
  console.log("\n--- Test 2: Insufficient amount → 402 ---");
  const smallToken = await mintTestTokens(8);
  const res2 = await fetch(`${GATE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": smallToken,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  console.log(`Status: ${res2.status}`);
  console.log(`Body:`, await res2.json());

  // Test 3: Valid token, correct amount → redeems + proxies (will 502 since upstream is dummy)
  console.log("\n--- Test 3: Valid payment → redeem + proxy ---");
  const goodToken = await mintTestTokens(200);
  const res3 = await fetch(`${GATE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": goodToken,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  console.log(`Status: ${res3.status}`);
  const body3 = await res3.json();
  console.log(`Body:`, JSON.stringify(body3).slice(0, 200));
  if (res3.status === 502) {
    console.log("(502 expected — upstream API key is dummy)");
  }

  // Test 4: Replay same token → double-spend rejection
  console.log("\n--- Test 4: Replay same token → rejection ---");
  const res4 = await fetch(`${GATE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": goodToken,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  console.log(`Status: ${res4.status}`);
  console.log(`Body:`, await res4.json());

  console.log("\n🎉 All E2E tests completed!");
}

main().catch(console.error);
