import type { Proof, Token } from "@cashu/cashu-ts";

/** Parsed stamp from X-Cashu header */
export interface Stamp {
  /** Raw encoded token string */
  raw: string;
  /** Decoded Cashu token */
  token: Token;
  /** Mint URL */
  mint: string;
  /** Total amount in units */
  amount: number;
  /** Individual proofs */
  proofs: Proof[];
}

/** Pricing mode */
export type PricingMode = "per_request" | "per_token";

/** Pricing rule for a model */
export interface PricingRule {
  /** LLM model name (exact match, or "*" for wildcard) */
  model: string;
  /** Pricing mode */
  mode: PricingMode;
  /**
   * Fixed price per request (units), used when mode=per_request.
   * @deprecated Use per_token mode instead
   */
  per_request?: number;
  /**
   * Price per 1M input tokens (units), used when mode=per_token.
   * Conversion: 1 USD = 100,000 units, so $0.15/1M → 15,000 units/1M
   */
  input_per_million?: number;
  /**
   * Price per 1M output tokens (units), used when mode=per_token.
   * Conversion: 1 USD = 100,000 units, so $0.60/1M → 60,000 units/1M
   */
  output_per_million?: number;
}

/** Token usage from LLM response */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

/** Amount validation result */
export interface AmountValidation {
  ok: boolean;
  required: number;
  provided: number;
}

/** Payment receipt */
export interface Receipt {
  /** Unique receipt ID */
  id: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Amount consumed (units) */
  amount: number;
  /** Unit */
  unit: string;
  /** Model used */
  model: string;
  /** Hash of token proofs (for audit, not the secret) */
  token_hash: string;
}

/** Trusted mint config */
export interface TrustedMint {
  url: string;
  unit: string;
  max_amount_per_request?: number;
}

/** Gate configuration */
export interface GateConfig {
  listen: { host: string; port: number };
  trusted_mints: TrustedMint[];
  pricing: PricingRule[];
  upstream: UpstreamConfig[];
}

/** Upstream LLM API config */
export interface UpstreamConfig {
  /** Glob or exact model name pattern */
  model_pattern: string;
  /** Base URL of upstream API */
  base_url: string;
  /** API key for upstream */
  api_key: string;
}
