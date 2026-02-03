/**
 * OpenRouter pricing fetcher.
 * 
 * Fetches model pricing from OpenRouter's public API and converts
 * to our PricingRule format.
 */
import type { PricingRule } from "./lib/types.js";

/** Conversion rate: 1 USD = 100,000 units */
export const USD_TO_UNITS = 100000;

/** OpenRouter model pricing structure */
export interface OpenRouterModel {
  id: string;
  pricing?: {
    /** Price per token in USD (e.g., "0.00000015" for $0.15/1M) */
    prompt?: string;
    /** Price per token in USD (e.g., "0.0000006" for $0.60/1M) */
    completion?: string;
  };
}

/** OpenRouter API response */
export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export interface ConvertOptions {
  /** Transform model ID (e.g., strip provider prefix) */
  modelIdTransform?: (id: string) => string;
  /** Filter which models to include */
  modelFilter?: (id: string) => boolean;
}

/**
 * Convert OpenRouter models to PricingRules.
 * 
 * @param models - OpenRouter model list
 * @param options - Conversion options
 * @returns Array of PricingRule in per_token mode
 */
export function convertToPricingRules(
  models: OpenRouterModel[],
  options?: ConvertOptions
): PricingRule[] {
  const { modelIdTransform, modelFilter } = options ?? {};
  
  return models
    .filter((m) => m.pricing?.prompt !== undefined && m.pricing?.completion !== undefined)
    .filter((m) => !modelFilter || modelFilter(m.id))
    .map((m): PricingRule | null => {
      // OpenRouter pricing is per-token in USD
      // e.g., "0.00000015" means $0.00000015 per token = $0.15 per 1M tokens
      const promptPerToken = parseFloat(m.pricing!.prompt!);
      const completionPerToken = parseFloat(m.pricing!.completion!);

      // Guard against NaN/Infinity from malformed pricing strings
      if (!isFinite(promptPerToken) || !isFinite(completionPerToken)) return null;

      // Convert to units per 1M tokens
      // Per-token USD * 1M tokens * USD_TO_UNITS = units per 1M
      const inputPerMillion = Math.round(promptPerToken * 1_000_000 * USD_TO_UNITS);
      const outputPerMillion = Math.round(completionPerToken * 1_000_000 * USD_TO_UNITS);

      const modelId = modelIdTransform ? modelIdTransform(m.id) : m.id;

      return {
        model: modelId,
        mode: "per_token" as const,
        input_per_million: inputPerMillion,
        output_per_million: outputPerMillion,
      };
    })
    .filter((rule): rule is PricingRule => rule !== null);
}

/**
 * Fetch pricing from OpenRouter API and convert to PricingRules.
 * 
 * @param options - Conversion options
 * @returns Array of PricingRule from OpenRouter
 * @throws Error if fetch fails or response is invalid
 */
export async function fetchOpenRouterPricing(
  options?: ConvertOptions
): Promise<PricingRule[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    method: "GET",
    headers: {
      "Accept": "application/json",
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenRouter pricing: ${response.status} ${response.statusText}`);
  }
  
  const data: OpenRouterModelsResponse = await response.json();
  
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("Invalid OpenRouter API response: missing data array");
  }
  
  return convertToPricingRules(data.data, options);
}

/** Cached pricing rules */
let cachedRules: PricingRule[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get cached OpenRouter pricing, fetching if necessary.
 * 
 * Note: If options are provided, cache is bypassed to ensure correct filtering.
 * The result with options is NOT cached (caller should manage their own cache if needed).
 * 
 * @param options - Conversion options (bypasses cache if provided)
 * @returns Cached or freshly fetched PricingRules
 */
export async function getCachedOpenRouterPricing(
  options?: ConvertOptions
): Promise<PricingRule[]> {
  // If options are provided, bypass cache entirely — options affect the output
  if (options) {
    return fetchOpenRouterPricing(options);
  }

  const now = Date.now();
  
  if (cachedRules && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedRules;
  }
  
  try {
    cachedRules = await fetchOpenRouterPricing();
    cacheTimestamp = now;
    return cachedRules;
  } catch (e) {
    // If we have stale cache, use it on error
    if (cachedRules) {
      console.warn("Failed to refresh OpenRouter pricing, using stale cache:", e);
      return cachedRules;
    }
    throw e;
  }
}

/**
 * Clear the cached pricing (useful for testing).
 */
export function clearPricingCache(): void {
  cachedRules = null;
  cacheTimestamp = 0;
}
