/**
 * token2chat Stamp Gate — standalone Node.js server
 *
 * Thin wrapper: extracts config from process.env → createGateApp() → serve().
 *
 * ENV:
 *   PORT                 (default: 10402)
 *   TRUSTED_MINTS        comma-separated mint URLs
 *   OPENAI_API_KEY       OpenAI API key
 *   OPENAI_BASE_URL      (default: https://api.openai.com)
 *   OPENROUTER_API_KEY   OpenRouter API key
 *   OPENROUTER_BASE_URL  (default: https://openrouter.ai/api)
 *   PRICING_JSON         optional JSON string for custom pricing
 *   GATE_ADMIN_TOKEN     admin auth token for balance/melt endpoints
 */
import { serve } from "@hono/node-server";
import { createGateApp } from "./create-app.js";
import { loadPricing } from "./pricing-config.js";
import type { UpstreamEntry } from "./upstream.js";

// --- Config ---
const PORT = parseInt(process.env.PORT ?? "10402", 10);

const TRUSTED_MINTS = (
  process.env.TRUSTED_MINTS ?? "https://testnut.cashu.space"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --- Upstream entries (order matters: first match wins) ---
const upstreams: UpstreamEntry[] = [];

if (process.env.OPENAI_API_KEY) {
  upstreams.push({
    match: "gpt-*",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
    apiKey: process.env.OPENAI_API_KEY,
  });
}

if (process.env.OPENROUTER_API_KEY) {
  upstreams.push({
    match: "*",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
    apiKey: process.env.OPENROUTER_API_KEY,
  });
}

if (upstreams.length === 1 && upstreams[0].match === "gpt-*") {
  upstreams.push({
    match: "*",
    baseUrl: upstreams[0].baseUrl,
    apiKey: upstreams[0].apiKey,
  });
}

// --- Pricing ---
const pricing = loadPricing(process.env.PRICING_JSON);

// --- App ---
const app = createGateApp({
  trustedMints: TRUSTED_MINTS,
  upstreams,
  pricing,
  adminToken: process.env.GATE_ADMIN_TOKEN,
  mintUrl: process.env.MINT_URL,
  walletAddress: process.env.GATE_WALLET_ADDRESS,
  allowedOrigins: process.env.ALLOWED_ORIGINS,
});

// --- Helper to format pricing for logs ---
function formatPricing(p: typeof pricing[number]): string {
  if (p.mode === "per_request" && p.per_request !== undefined) {
    return `${p.model} (${p.per_request} units/req)`;
  }
  // per_token mode
  const input = p.input_per_million ?? 0;
  const output = p.output_per_million ?? 0;
  return `${p.model} (${input}/${output} units/M)`;
}

// --- Start ---
console.log(`
🎟️  token2chat Stamp Gate
   Port:      ${PORT}
   Mints:     ${TRUSTED_MINTS.join(", ")}
   Upstreams: ${upstreams.map((u) => `${u.match} → ${u.baseUrl}`).join(", ") || "(none!)"}
   Models:    ${pricing.map(formatPricing).join(", ")}
`);

if (upstreams.length === 0) {
  console.warn(
    "⚠️  No upstream API keys configured! Set OPENAI_API_KEY or OPENROUTER_API_KEY.",
  );
}

serve({ fetch: app.fetch, port: PORT });
