/**
 * Quick test: does gate return 402 (not 500) when token has insufficient sats?
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getEncodedTokenV4 } from "@cashu/cashu-ts";

const CASHU_PATH = join(homedir(), ".secrets/wallet/cashu-wallet.json");

async function main() {
  const wallet = JSON.parse(readFileSync(CASHU_PATH, "utf-8"));
  const sorted = [...wallet.proofs].sort((a: any, b: any) => a.amount - b.amount);
  const small = sorted[0];
  console.log("Using proof:", small.amount, "sats (need 200 for gpt-4o-mini)");

  const token = getEncodedTokenV4({
    mint: "https://mint.token2chat.com",
    proofs: [small],
    unit: "sat",
  });

  const res = await fetch("https://gate.token2chat.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": token,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 10,
    }),
  });

  console.log("Status:", res.status, res.statusText);
  const text = await res.text();
  console.log("Body:", text);

  if (res.status === 402) {
    console.log("\n✅ Correctly returns 402 for insufficient payment");
  } else if (res.status === 500) {
    console.log("\n❌ BUG: Returns 500 instead of 402!");
  } else {
    console.log(`\n⚠️ Unexpected status: ${res.status}`);
  }
}

main().catch(console.error);
