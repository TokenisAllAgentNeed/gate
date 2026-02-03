/**
 * Shared pricing configuration for the Gate.
 *
 * Default pricing is used as fallback. Override via:
 * - PRICING_JSON env var (JSON string of PricingRule[])
 * - Dynamic fetch from OpenRouter API at startup
 *
 * Pricing is per-token by default (input_per_million / output_per_million).
 * Rates are in units, with 1 USD = 100,000 units conversion.
 */
import type { PricingRule } from "./lib/types.js";

/**
 * Default pricing — used when no override is provided.
 * These match OpenRouter rates at time of writing (Feb 2025).
 * Rates: units per 1M tokens (1 USD = 100,000 units)
 */
export const PRICING: PricingRule[] = [
  // ── OpenAI ────────────────────────────────────────────────────
  // GPT-4o-mini: $0.15/1M input, $0.60/1M output
  { model: "openai/gpt-4o-mini", mode: "per_token", input_per_million: 15000, output_per_million: 60000 },
  // GPT-4o: $2.50/1M input, $10/1M output
  { model: "openai/gpt-4o", mode: "per_token", input_per_million: 250000, output_per_million: 1000000 },
  // o3-mini: $1.10/1M input, $4.40/1M output
  { model: "openai/o3-mini", mode: "per_token", input_per_million: 110000, output_per_million: 440000 },
  // o3-pro: $20/1M input, $80/1M output
  { model: "openai/o3-pro", mode: "per_token", input_per_million: 2000000, output_per_million: 8000000 },

  // ── Anthropic ─────────────────────────────────────────────────
  // Claude Sonnet 4: $3/1M input, $15/1M output
  { model: "anthropic/claude-sonnet-4", mode: "per_token", input_per_million: 300000, output_per_million: 1500000 },
  // Claude Opus 4: $15/1M input, $75/1M output
  { model: "anthropic/claude-opus-4", mode: "per_token", input_per_million: 1500000, output_per_million: 7500000 },
  // Claude Haiku 3.5: $0.80/1M input, $4/1M output
  { model: "anthropic/claude-3.5-haiku", mode: "per_token", input_per_million: 80000, output_per_million: 400000 },

  // ── Google ────────────────────────────────────────────────────
  // Gemini 2.5 Pro: $1.25/1M input, $10/1M output
  { model: "google/gemini-2.5-pro-preview", mode: "per_token", input_per_million: 125000, output_per_million: 1000000 },
  // Gemini 2.5 Flash: $0.15/1M input, $0.60/1M output
  { model: "google/gemini-2.5-flash-preview", mode: "per_token", input_per_million: 15000, output_per_million: 60000 },

  // ── DeepSeek ──────────────────────────────────────────────────
  // DeepSeek R1: $0.55/1M input, $2.19/1M output
  { model: "deepseek/deepseek-r1", mode: "per_token", input_per_million: 55000, output_per_million: 219000 },
  // DeepSeek V3: $0.27/1M input, $1.10/1M output
  { model: "deepseek/deepseek-chat", mode: "per_token", input_per_million: 27000, output_per_million: 110000 },

  // ── Qwen ──────────────────────────────────────────────────────
  // Qwen3 235B: $0.30/1M input, $1.20/1M output
  { model: "qwen/qwen3-235b", mode: "per_token", input_per_million: 30000, output_per_million: 120000 },

  // ── Meta ──────────────────────────────────────────────────────
  // Llama 4 Maverick: $0.20/1M input, $0.60/1M output
  { model: "meta-llama/llama-4-maverick", mode: "per_token", input_per_million: 20000, output_per_million: 60000 },

  // ── Moonshot ──────────────────────────────────────────────────
  // Kimi K2: $0.60/1M input, $2.00/1M output
  { model: "moonshotai/kimi-k2", mode: "per_token", input_per_million: 60000, output_per_million: 200000 },

  // ── Catch-all wildcard (moderate pricing for unknown models) ──
  { model: "*", mode: "per_token", input_per_million: 100000, output_per_million: 500000 },
];

/**
 * Load pricing rules, optionally overriding defaults with a JSON string.
 *
 * @param pricingJson - Optional JSON string (e.g. from PRICING_JSON env var).
 *   If valid, completely replaces the defaults.
 *   If undefined/null/empty, returns the built-in PRICING defaults.
 */
export function loadPricing(pricingJson?: string | null): PricingRule[] {
  if (!pricingJson || pricingJson.trim() === "") {
    return PRICING;
  }
  try {
    const parsed = JSON.parse(pricingJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.warn("⚠️  PRICING_JSON is not a non-empty array, using defaults");
      return PRICING;
    }
    return parsed as PricingRule[];
  } catch (e) {
    console.warn(
      `⚠️  Failed to parse PRICING_JSON: ${e instanceof Error ? e.message : e}. Using defaults.`,
    );
    return PRICING;
  }
}

/**
 * Merge OpenRouter pricing with custom rules.
 * Custom rules take precedence over OpenRouter pricing.
 * 
 * @param openRouterRules - Rules fetched from OpenRouter API
 * @param customRules - Custom rules (from PRICING_JSON or defaults)
 * @returns Merged rules with custom taking precedence
 */
export function mergePricing(
  openRouterRules: PricingRule[],
  customRules: PricingRule[]
): PricingRule[] {
  const customModels = new Set(customRules.map(r => r.model));
  
  // Filter out OpenRouter rules that have custom overrides
  const filteredOpenRouter = openRouterRules.filter(r => !customModels.has(r.model));
  
  // Custom rules first (higher precedence), then OpenRouter
  return [...customRules, ...filteredOpenRouter];
}
