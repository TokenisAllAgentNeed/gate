export { createGateApp, type GateAppConfig, type Variables } from "./create-app.js";
export { stampGate } from "./middleware.js";
export type { StampGateOptions } from "./middleware.js";
export { createRedeemFn } from "./redeem.js";
export { resolveUpstream, proxyToUpstream } from "./upstream.js";
export type { UpstreamEntry, ProxyResult } from "./upstream.js";
export { PRICING, loadPricing, mergePricing } from "./pricing-config.js";
export { meltProofs, type MeltConfig, type MeltResult } from "./melt.js";

// OpenRouter pricing fetcher
export {
  fetchOpenRouterPricing,
  getCachedOpenRouterPricing,
  convertToPricingRules,
  clearPricingCache,
  USD_TO_UNITS,
  type OpenRouterModel,
  type OpenRouterModelsResponse,
  type ConvertOptions,
} from "./openrouter-pricing.js";

// Pricing utilities
export {
  getPrice,
  validateAmount,
  estimateMaxCost,
  calculateActualCost,
  DEFAULT_MAX_TOKENS,
} from "./lib/pricing.js";
export type { EstimateContext } from "./lib/pricing.js";
export type { TokenUsage, PricingRule, PricingMode } from "./lib/types.js";
