/**
 * E2E: OpenRouter via token2chat Gate
 * Tests a non-gpt model routed through OpenRouter
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

async function testModel(model: string, prompt: string) {
  console.log(`\n--- ${model} ---`);
  const token = await mintTokens(500); // wildcard price
  console.log("  Minted 500 sat");

  const res = await fetch(`${GATE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": token,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 30,
    }),
  });

  console.log(`  Status: ${res.status}`);
  if (res.status === 200) {
    const body = await res.json();
    const reply = body.choices?.[0]?.message?.content;
    console.log(`  Reply: "${reply?.slice(0, 100)}"`);
    const receipt = res.headers.get("X-Cashu-Receipt");
    if (receipt) {
      const r = JSON.parse(receipt);
      console.log(`  Receipt: ${r.amount} sat`);
    }
    console.log("  ✅ PASS");
  } else {
    const body = await res.json();
    console.log(`  Error:`, body.error?.message?.slice(0, 200));
    console.log("  ❌ FAIL");
  }
}

async function testStreaming(model: string) {
  console.log(`\n--- ${model} (streaming) ---`);
  const token = await mintTokens(500);
  console.log("  Minted 500 sat");

  const res = await fetch(`${GATE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": token,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Say hi in 3 words." }],
      max_tokens: 20,
      stream: true,
    }),
  });

  console.log(`  Status: ${res.status}`);
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let chunks = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      for (const line of decoder.decode(value, { stream: true }).split("\n")) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const d = JSON.parse(line.slice(6));
            const c = d.choices?.[0]?.delta?.content;
            if (c) text += c;
          } catch {}
        }
      }
    }
    console.log(`  ${chunks} chunks, text: "${text.trim()}"`);
    console.log(chunks > 1 ? "  ✅ PASS" : "  ⚠️  single chunk");
  } else {
    console.log("  ❌ FAIL", await res.text().catch(() => ""));
  }
}

async function main() {
  // 1. OpenAI via direct route
  await testModel("gpt-4o-mini", "Say exactly: direct OpenAI works!");

  // 2. OpenRouter: Google model
  await testModel("google/gemini-2.0-flash-001", "Say exactly: OpenRouter works!");

  // 3. OpenRouter: streaming
  await testStreaming("google/gemini-2.0-flash-001");

  console.log("\n🎉 OpenRouter E2E complete!");
}

main().catch(console.error);
