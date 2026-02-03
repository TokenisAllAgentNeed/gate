/**
 * Gate constants — extracted from inline magic numbers.
 */

/** Approximate characters per token for input estimation */
export const CHARS_PER_TOKEN = 4;

/** Buffer factor for token estimation (10% overhead) */
export const TOKEN_OVERHEAD_FACTOR = 1.1;

/** Minimum token estimate to avoid edge cases */
export const MIN_TOKEN_ESTIMATE = 100;

/** Default timeout for mint swap operations (ms) */
export const DEFAULT_SWAP_TIMEOUT_MS = 10_000;

/** Estimated tokens per image in multimodal requests */
export const IMAGE_TOKEN_ESTIMATE = 800;

/** CORS preflight max-age (seconds) */
export const CORS_MAX_AGE = 86400;
