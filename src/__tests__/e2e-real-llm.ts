/**
 * Real E2E: mint tokens → pay Gate → get real LLM response
 *
 * Tests both non-streaming and streaming modes.
 * Requires: Gate running on localhost:10402 with real OPENAI_API_KEY
 */
import {
  CashuMint,
  CashuWallet,
  MintQuoteState,
  getEncodedTokenV4,
} from "@cashu/cashu-ts";

const GATE = "http://localhost:10402";
const MINT = "https://testnut.cashu.space";

async function mintTokens(amount: number): Promise<string> {
  const mint = new CashuMint(MINT);
  const wallet = new CashuWallet(mint);
  await wallet.loadMint();
  const quote = await wallet.createMintQuote(amount);
  for (let i = 0; i < 30; i++) {
    const c = await wallet.checkMintQuote(quote.quote);
    if (c.state === MintQuoteState.PAID || c.state === MintQuoteState.ISSUED) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const proofs = await wallet.mintProofs(amount, quote.quote);
  return getEncodedTokenV4({ mint: MINT, proofs, unit: "usd" });
}

async function main() {
  // === Test 1: Non-streaming ===
  console.log("\n🔵 Test 1: Non-streaming request");
  const token1 = await mintTokens(200);
  console.log("  Minted 200 sat");

  const res1 = await fetch(`${GATE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": token1,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "Say exactly: token2chat works!" },
      ],
      max_tokens: 20,
    }),
  });

  console.log(`  Status: ${res1.status}`);
  const receipt1 = res1.headers.get("X-Cashu-Receipt");
  if (receipt1) {
    const r = JSON.parse(receipt1);
    console.log(`  Receipt: ${r.amount} sat, model=${r.model}, id=${r.id}`);
  }
  const body1 = await res1.json();
  const reply1 = body1.choices?.[0]?.message?.content;
  console.log(`  LLM reply: "${reply1}"`);
  console.log(res1.status === 200 ? "  ✅ PASS" : "  ❌ FAIL");

  // === Test 2: Streaming ===
  console.log("\n🟢 Test 2: Streaming request");
  const token2 = await mintTokens(200);
  console.log("  Minted 200 sat");

  const res2 = await fetch(`${GATE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": token2,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "Count from 1 to 5, one per line." },
      ],
      max_tokens: 50,
      stream: true,
    }),
  });

  console.log(`  Status: ${res2.status}`);
  console.log(`  Content-Type: ${res2.headers.get("content-type")}`);

  if (res2.status === 200 && res2.body) {
    const reader = res2.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      chunkCount++;

      // Parse SSE data lines to extract content
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) fullText += delta;
          } catch {}
        }
      }
    }

    console.log(`  Received ${chunkCount} chunks`);
    console.log(`  Full streamed text: "${fullText.trim()}"`);
    console.log(chunkCount > 1 ? "  ✅ PASS (streaming confirmed)" : "  ⚠️  Single chunk (might not be streaming)");
  } else {
    const body2 = await res2.json();
    console.log(`  Error:`, body2);
    console.log("  ❌ FAIL");
  }

  console.log("\n🎉 Real LLM E2E complete!");
}

main().catch(console.error);
