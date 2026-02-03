import type { AmountValidation, PricingRule, Stamp, TokenUsage } from "./types.js";

/** Default max_tokens when not specified in request */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Find the pricing rule for a given model.
 *
 * @param model - The model name to look up
 * @param rules - Available pricing rules
 * @returns Matching rule, or null if model is not priced
 */
export function getPrice(
  model: string,
  rules: PricingRule[]
): PricingRule | null {
  // Exact match first
  const exact = rules.find((r) => r.model === model);
  if (exact) return exact;

  // Wildcard catch-all
  const wildcard = rules.find((r) => r.model === "*");
  if (wildcard) return { ...wildcard, model };

  return null;
}

/**
 * Estimate the maximum cost for a request based on input tokens and max_tokens.
 * Used upfront to validate the user has sent enough ecash.
 *
 * @param rule - Pricing rule (must be per_token mode)
 * @param inputTokens - Estimated input/prompt tokens
 * @param maxOutputTokens - Max tokens for completion (from request or default)
 * @returns Maximum cost in sats (always at least 1 sat)
 */
export function estimateMaxCost(
  rule: PricingRule,
  inputTokens: number,
  maxOutputTokens: number = DEFAULT_MAX_TOKENS
): number {
  if (rule.mode !== "per_token") {
    throw new Error(`estimateMaxCost requires per_token mode, got ${rule.mode}`);
  }

  const inputCost = (inputTokens / 1_000_000) * (rule.input_per_million ?? 0);
  const outputCost = (maxOutputTokens / 1_000_000) * (rule.output_per_million ?? 0);
  const totalCost = inputCost + outputCost;

  // Always charge at least 1 sat
  return Math.max(1, Math.ceil(totalCost));
}

/**
 * Calculate the actual cost after receiving the LLM response.
 * Used to determine how much change to return to the user.
 *
 * @param rule - Pricing rule (must be per_token mode)
 * @param usage - Actual token usage from LLM response
 * @returns Actual cost in sats (always at least 1 sat)
 */
export function calculateActualCost(
  rule: PricingRule,
  usage: TokenUsage
): number {
  if (rule.mode !== "per_token") {
    throw new Error(`calculateActualCost requires per_token mode, got ${rule.mode}`);
  }

  const inputCost = (usage.prompt_tokens / 1_000_000) * (rule.input_per_million ?? 0);
  const outputCost = (usage.completion_tokens / 1_000_000) * (rule.output_per_million ?? 0);
  const totalCost = inputCost + outputCost;

  // Always charge at least 1 sat
  return Math.max(1, Math.ceil(totalCost));
}

/**
 * Estimate context for per_token validation
 */
export interface EstimateContext {
  inputTokens: number;
  maxOutputTokens?: number;
}

/**
 * Validate that a stamp's amount meets the pricing requirement.
 *
 * For per_request mode: checks against fixed per_request price
 * For per_token mode: requires EstimateContext to estimate max cost
 *
 * @param stamp - The stamp (or object with amount) to validate
 * @param rule - The pricing rule to check against
 * @param estimate - Token estimate context (required for per_token mode)
 * @returns Validation result with ok/required/provided
 */
export function validateAmount(
  stamp: Pick<Stamp, "amount">,
  rule: PricingRule,
  estimate?: EstimateContext
): AmountValidation {
  const required = getRequiredAmount(rule, estimate);
  return {
    ok: stamp.amount >= required,
    required,
    provided: stamp.amount,
  };
}

/**
 * Get the required amount for a pricing rule.
 * For per_request mode, returns the fixed price.
 * For per_token mode, estimates based on input + max output tokens.
 */
function getRequiredAmount(rule: PricingRule, estimate?: EstimateContext): number {
  if (rule.mode === "per_request") {
    if (rule.per_request == null || rule.per_request < 0) {
      throw new Error(`Invalid per_request price for model ${rule.model}`);
    }
    return rule.per_request;
  }

  if (rule.mode === "per_token") {
    if (!estimate) {
      // If no estimate provided, use a reasonable default
      return estimateMaxCost(rule, 1000, DEFAULT_MAX_TOKENS);
    }
    return estimateMaxCost(rule, estimate.inputTokens, estimate.maxOutputTokens);
  }

  throw new Error(`Pricing mode "${rule.mode}" not supported`);
}
