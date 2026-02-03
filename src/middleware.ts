import type { Context, Next } from "hono";
import {
  decodeStamp,
  decodeStampWithDiagnostics,
  detectTokenVersion,
  getPrice,
  validateAmount,
  estimateMaxCost,
  DEFAULT_MAX_TOKENS,
} from "./lib/index.js";
import type { PricingRule, TrustedMint, Stamp, DecodeDiagnostics } from "./lib/index.js";
import type { Proof } from "@cashu/cashu-ts";
import type { RedeemResult } from "./redeem.js";
import {
  CHARS_PER_TOKEN,
  TOKEN_OVERHEAD_FACTOR,
  MIN_TOKEN_ESTIMATE,
  IMAGE_TOKEN_ESTIMATE,
} from "./constants.js";

/** Random per-instance salt used when IP_HASH_SALT env is not configured */
let _randomSalt: string | null = null;
function _getRandomSalt(): string {
  if (!_randomSalt) {
    _randomSalt = crypto.randomUUID();
    console.warn("[Gate] IP_HASH_SALT not configured. Using random per-instance salt.");
  }
  return _randomSalt;
}

/** Minimal metrics info from middleware-level errors */
export interface MiddlewareMetric {
  status: number;
  error_code: string;
  model: string;
  mint: string;
  ecash_in: number;
  stream: boolean;
  /** Token version (V3/V4) for debugging */
  token_version?: string;
  /** Decode time in ms */
  decode_time_ms?: number;
}

export interface StampGateOptions {
  /** Accepted mint URLs */
  trustedMints: string[];
  /** Pricing rules */
  pricing: PricingRule[];
  /**
   * Function to redeem (swap) proofs at the mint.
   * @param stamp - decoded stamp
   * @param price - the service price in sat; if < stamp.amount, returns change
   */
  redeemFn: (stamp: Stamp, price?: number) => Promise<RedeemResult>;
  /**
   * Optional callback for recording metrics on middleware-level errors.
   * Called with partial metric info before returning error response.
   */
  onMetric?: (metric: MiddlewareMetric) => void;
  /**
   * Optional callback for recording token decode errors.
   * Called when token parsing fails (for debugging and investigation).
   */
  onTokenError?: (
    diagnostics: DecodeDiagnostics,
    rawToken: string,
    metadata: { ipHash?: string; userAgent?: string }
  ) => void;
}

/**
 * Hono middleware that validates a Cashu stamp and redeems it
 * before passing control to the upstream handler.
 *
 * Design principle: **charge first, refund on failure.**
 * The middleware redeems the ecash immediately (swap at mint) to prevent
 * double-spend. If the upstream LLM call fails, the handler encodes
 * the redeemed proofs back into a Cashu token and returns it via
 * X-Cashu-Refund header, so the user can recover their funds.
 *
 * Flow:
 *   1. Validate token (decode, mint whitelist, amount)
 *   2. Redeem (swap) at mint → Gate owns new proofs
 *   3. Attach stamp + pricingRule + redeemProofs to context
 *   4. Let upstream handler run (next())
 *   5. On upstream failure, handler refunds via X-Cashu-Refund
 */
export function stampGate(opts: StampGateOptions) {
  return async (c: Context, next: Next) => {
    // 1. Extract X-Cashu header
    const header = c.req.header("X-Cashu");

    if (!header) {
      const model = await extractModel(c);
      const rule = model ? getPrice(model, opts.pricing) : null;
      opts.onMetric?.({
        status: 402, error_code: "payment_required",
        model: model ?? "unknown", mint: "", ecash_in: 0, stream: false,
      });
      return c.json(
        {
          error: {
            code: "payment_required",
            message:
              "X-Cashu header required. See GET /v1/pricing for rates.",
            pricing_url: "/v1/pricing",
          },
        },
        402,
        pricingHeaders(rule)
      );
    }

    // 2. Decode token with diagnostics for debugging
    const tokenVersion = detectTokenVersion(header);
    const { stamp: decodedStamp, diagnostics } = decodeStampWithDiagnostics(header);

    if (!decodedStamp) {
      // Log diagnostic info for failed decodes (helps debug CBOR issues)
      console.error("[Gate] Token decode failed:", {
        tokenVersion: diagnostics.tokenVersion,
        prefix: diagnostics.rawPrefix,
        error: diagnostics.error,
        decodeTimeMs: diagnostics.decodeTimeMs,
        rawCborStructure: diagnostics.rawCborStructure,
      });

      // Persist token decode error for investigation
      const userAgent = c.req.header("User-Agent") ?? undefined;
      // Hash IP for privacy (if available)
      const cfIP = c.req.header("CF-Connecting-IP");
      const ipHashSalt = (c.env as { IP_HASH_SALT?: string } | undefined)?.IP_HASH_SALT || _getRandomSalt();
      const ipHash = cfIP ? await hashIP(cfIP, ipHashSalt) : undefined;
      opts.onTokenError?.(diagnostics, header, { ipHash, userAgent });

      opts.onMetric?.({
        status: 400,
        error_code: "invalid_token",
        model: "unknown",
        mint: "",
        ecash_in: 0,
        stream: false,
        token_version: diagnostics.tokenVersion,
        decode_time_ms: diagnostics.decodeTimeMs,
      });
      return c.json(
        {
          error: {
            code: "invalid_token",
            message: diagnostics.error ?? "Cashu token decode failed",
            // Include version hint for debugging
            token_version: diagnostics.tokenVersion,
          },
        },
        400
      );
    }

    const stamp: Stamp = decodedStamp;

    // 3. Check mint whitelist
    const mintNormalized = stamp.mint.replace(/\/+$/, "");
    const trusted = opts.trustedMints.some(
      (m) => m.replace(/\/+$/, "") === mintNormalized
    );
    if (!trusted) {
      opts.onMetric?.({
        status: 400, error_code: "untrusted_mint",
        model: "unknown", mint: stamp.mint, ecash_in: stamp.amount, stream: false,
      });
      return c.json(
        {
          error: {
            code: "untrusted_mint",
            message: `Mint ${stamp.mint} is not in the trusted list`,
          },
        },
        400
      );
    }

    // 4. Get pricing for the requested model
    const requestInfo = await extractRequestInfo(c);
    const model = requestInfo.model;
    if (!model) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Missing model in request body",
          },
        },
        400
      );
    }

    const rule = getPrice(model, opts.pricing);
    if (!rule) {
      return c.json(
        {
          error: {
            code: "model_not_found",
            message: `No pricing for model: ${model}`,
          },
        },
        400
      );
    }

    // 5. Calculate price based on pricing mode
    let estimatedPrice: number;
    if (rule.mode === "per_token") {
      // Estimate max cost from input tokens + max output tokens
      estimatedPrice = estimateMaxCost(
        rule,
        requestInfo.estimatedInputTokens,
        requestInfo.maxTokens
      );
    } else {
      // Legacy per_request mode
      estimatedPrice = rule.per_request ?? 0;
    }

    // 6. Validate amount
    const validation = validateAmount(stamp, rule, {
      inputTokens: requestInfo.estimatedInputTokens,
      maxOutputTokens: requestInfo.maxTokens,
    });
    if (!validation.ok) {
      opts.onMetric?.({
        status: 402, error_code: "insufficient_payment",
        model, mint: stamp.mint, ecash_in: stamp.amount, stream: false,
      });
      return c.json(
        {
          error: {
            code: "insufficient_payment",
            message: `Token value ${validation.provided} < required ${validation.required} for model ${model}`,
            required: validation.required,
            provided: validation.provided,
            unit: "usd",
            pricing_mode: rule.mode,
          },
        },
        402,
        pricingHeaders(rule)
      );
    }

    // 7. Redeem (swap) at mint — charge upfront to prevent double-spend
    //    Pass estimated price so redeemFn can split into Gate's share + user's change
    const price = estimatedPrice;
    const redeemResult = await opts.redeemFn(stamp, price);
    if (!redeemResult.ok) {
      const errMsg = redeemResult.error;
      const isDoubleSpend =
        errMsg.includes("already spent") ||
        errMsg.includes("Token already spent");
      const isTimeout =
        errMsg.includes("timeout") || errMsg.includes("Timeout");
      // timeout → 504, double-spend → 400, other → 500
      const status: 400 | 500 | 504 = isDoubleSpend ? 400 : isTimeout ? 504 : 500;
      const errorCode = isDoubleSpend
        ? "token_spent"
        : isTimeout
          ? "gateway_timeout"
          : "redeem_failed";
      opts.onMetric?.({
        status, error_code: errorCode,
        model, mint: stamp.mint, ecash_in: stamp.amount, stream: false,
      });
      return c.json(
        {
          error: {
            code: errorCode,
            message: errMsg,
          },
        },
        status
      );
    }

    // 9. Attach stamp, rule, estimated price, Gate's proofs, and change proofs to context
    c.set("stamp", stamp);
    c.set("pricingRule", rule);
    c.set("estimatedPrice", estimatedPrice);       // Estimated price in sats (for per_token mode)
    c.set("redeemKeep", redeemResult.keep);        // Gate's proofs (price amount)
    c.set("redeemChange", redeemResult.change);    // User's change (overpayment)
    c.set("redeemKvKey", redeemResult.kvKey);      // KV key for keep proofs (for cleanup on refund)
    await next();
  };
}

/** Extracted request info for pricing */
interface RequestInfo {
  model: string | null;
  maxTokens: number;
  estimatedInputTokens: number;
}

/** Parse body once and cache on context (avoids double-parsing). */
async function getParsedBody(c: Context): Promise<Record<string, unknown> | null> {
  // Check if body was already parsed and cached
  try {
    const cached = c.get("parsedBody" as never) as Record<string, unknown> | undefined;
    if (cached) return cached;
  } catch {
    // Variable not set yet
  }
  try {
    const body = await c.req.json();
    try { c.set("parsedBody" as never, body); } catch { /* context may not support set */ }
    return body;
  } catch {
    return null;
  }
}

/** Try to extract model and token info from JSON body (non-destructive). */
async function extractRequestInfo(c: Context): Promise<RequestInfo> {
  const body = await getParsedBody(c);
  if (!body) {
    return { model: null, maxTokens: DEFAULT_MAX_TOKENS, estimatedInputTokens: MIN_TOKEN_ESTIMATE };
  }

  const model = (body.model as string) ?? null;
  const maxTokens = (body.max_tokens as number) ?? DEFAULT_MAX_TOKENS;

  // Estimate input tokens from messages
  let estimatedInputTokens = 0;
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (typeof msg?.content === "string") {
        estimatedInputTokens += Math.ceil(msg.content.length / CHARS_PER_TOKEN);
      } else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (part?.type === "text" && typeof part?.text === "string") {
            estimatedInputTokens += Math.ceil(part.text.length / CHARS_PER_TOKEN);
          } else if (part?.type === "image_url") {
            estimatedInputTokens += IMAGE_TOKEN_ESTIMATE;
          }
        }
      }
      estimatedInputTokens += CHARS_PER_TOKEN;
    }
  }

  // Buffer for system overhead
  estimatedInputTokens = Math.ceil(estimatedInputTokens * TOKEN_OVERHEAD_FACTOR);
  estimatedInputTokens = Math.max(MIN_TOKEN_ESTIMATE, estimatedInputTokens);

  return { model, maxTokens, estimatedInputTokens };
}

/** Try to extract model from JSON body (non-destructive). */
async function extractModel(c: Context): Promise<string | null> {
  const body = await getParsedBody(c);
  return (body?.model as string) ?? null;
}

/** Build X-Cashu-Price header from a pricing rule */
function pricingHeaders(rule: PricingRule | null): Record<string, string> {
  if (!rule) return {};
  
  if (rule.mode === "per_token") {
    return {
      "X-Cashu-Price": JSON.stringify({
        mode: "per_token",
        input_per_million: rule.input_per_million ?? 0,
        output_per_million: rule.output_per_million ?? 0,
        unit: "usd",
        model: rule.model,
      }),
    };
  }
  
  // Legacy per_request mode
  return {
    "X-Cashu-Price": JSON.stringify({
      mode: "per_request",
      amount: rule.per_request ?? 0,
      unit: "usd",
      model: rule.model,
    }),
  };
}

/** Hash IP address for privacy-preserving storage */
async function hashIP(ip: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}
