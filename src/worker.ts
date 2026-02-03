/**
 * token2chat Stamp Gate — Cloudflare Worker entry point
 *
 * Uses createGateApp() with CF Workers bindings.
 * KV namespace ECASH_STORE is used for proof storage.
 */
import { Hono } from "hono";
import { createGateApp, type Variables } from "./create-app.js";
import { loadPricing } from "./pricing-config.js";
import type { UpstreamEntry } from "./upstream.js";
import type { KVNamespace } from "./lib/kv.js";

// ── Bindings (CF Worker environment) ────────────────────────────────

type Bindings = {
  // Required
  OPENROUTER_API_KEY: string;
  GATE_WALLET_ADDRESS: string;

  // Optional with defaults
  TRUSTED_MINTS?: string;
  MINT_URL?: string;
  ALLOWED_ORIGINS?: string;
  PRICING_JSON?: string;

  // Optional features
  GATE_ADMIN_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENROUTER_BASE_URL?: string;
  IP_HASH_SALT?: string;

  // KV binding
  ECASH_STORE?: KVNamespace;
};

// ── App factory (creates app with env-specific config) ──────────────

function buildApp(env: Bindings) {
  // Parse trusted mints
  const trustedMints = (env.TRUSTED_MINTS ?? "https://mint.token2chat.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Build upstreams array (order matters: first match wins)
  const upstreams: UpstreamEntry[] = [];

  if (env.OPENAI_API_KEY) {
    upstreams.push({
      match: "gpt-*",
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com",
      apiKey: env.OPENAI_API_KEY,
    });
  }

  if (env.OPENROUTER_API_KEY) {
    upstreams.push({
      match: "*",
      baseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
      apiKey: env.OPENROUTER_API_KEY,
    });
  }

  // If only OpenAI is configured, use it as fallback for all models
  if (upstreams.length === 1 && upstreams[0].match === "gpt-*") {
    upstreams.push({
      match: "*",
      baseUrl: upstreams[0].baseUrl,
      apiKey: upstreams[0].apiKey,
    });
  }

  // Load pricing
  const pricing = loadPricing(env.PRICING_JSON);

  // Create the Gate app
  return createGateApp({
    trustedMints,
    upstreams,
    pricing,
    kvStore: env.ECASH_STORE ?? null,
    adminToken: env.GATE_ADMIN_TOKEN,
    mintUrl: env.MINT_URL ?? "https://mint.token2chat.com",
    walletAddress: env.GATE_WALLET_ADDRESS,
    allowedOrigins: env.ALLOWED_ORIGINS ?? "*",
  });
}

// ── Worker export ───────────────────────────────────────────────────

// Cache the app instance per isolate (env is stable within a Worker)
let cachedApp: ReturnType<typeof createGateApp> | null = null;
let cachedEnvHash: string | null = null;

/**
 * Simple hash of env keys to detect config changes.
 * In production, env is stable; this helps during development.
 */
function envHash(env: Bindings): string {
  return [
    env.OPENROUTER_API_KEY?.slice(0, 8),
    env.GATE_WALLET_ADDRESS?.slice(0, 8),
    env.TRUSTED_MINTS,
    env.GATE_ADMIN_TOKEN?.slice(0, 8),
  ].join("|");
}

const worker = new Hono<{ Bindings: Bindings; Variables: Variables }>();

worker.all("*", async (c) => {
  const env = c.env;
  const hash = envHash(env);

  // Rebuild app if env changed or not yet created
  if (!cachedApp || cachedEnvHash !== hash) {
    cachedApp = buildApp(env);
    cachedEnvHash = hash;
  }

  // Forward request to the cached app
  return cachedApp.fetch(c.req.raw, env, c.executionCtx);
});

export default worker;
