/**
 * token-errors.ts — Token decode error persistence and querying.
 *
 * Stores failed token decode attempts for debugging and investigation.
 * Key format: token_error:{YYYY-MM-DD}:{unix_ms}:{random}
 *
 * Retention: 24 hours (auto-expire via KV TTL)
 * Limit: ~100 most recent errors (older ones auto-expire)
 */
import type { KVNamespace } from "./lib/kv.js";
import type { DecodeDiagnostics } from "./lib/decode.js";

// ── Types ───────────────────────────────────────────────────────

export interface TokenDecodeError {
  ts: number;              // Unix ms timestamp
  tokenVersion: string;    // V3, V4, or unknown
  error: string;           // Error message
  rawPrefix: string;       // First N chars of token (for identification)
  rawToken?: string;       // Full token (for investigation) - truncated if too long
  decodeTimeMs: number;    // How long decode took
  rawCborStructure?: string; // CBOR structure (V4 only)
  ipHash?: string;         // Hashed IP for rate limiting abuse detection
  userAgent?: string;      // Client user agent
}

// ── Constants ───────────────────────────────────────────────────

const KEY_PREFIX = "token_error";
const TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_TOKEN_LENGTH = 2000;    // Truncate tokens longer than this

// ── Write ───────────────────────────────────────────────────────

/**
 * Store a token decode error.
 * Returns a Promise (caller should use waitUntil to avoid blocking).
 */
export async function writeTokenError(
  kv: KVNamespace,
  diagnostics: DecodeDiagnostics,
  rawToken: string,
  metadata?: { ipHash?: string; userAgent?: string },
): Promise<void> {
  const ts = Date.now();
  const date = new Date(ts).toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `${KEY_PREFIX}:${date}:${ts}:${rand}`;

  const record: TokenDecodeError = {
    ts,
    tokenVersion: diagnostics.tokenVersion,
    error: diagnostics.error ?? "Unknown error",
    rawPrefix: diagnostics.rawPrefix,
    rawToken: rawToken.length > MAX_TOKEN_LENGTH
      ? rawToken.slice(0, MAX_TOKEN_LENGTH) + "...[truncated]"
      : rawToken,
    decodeTimeMs: diagnostics.decodeTimeMs,
    rawCborStructure: diagnostics.rawCborStructure,
    ipHash: metadata?.ipHash,
    userAgent: metadata?.userAgent,
  };

  await kv.put(key, JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
  });
}

// ── Read ────────────────────────────────────────────────────────

/**
 * Get token decode errors for a specific date (YYYY-MM-DD).
 * Returns errors sorted by timestamp (newest first).
 */
export async function getTokenErrorsByDate(
  kv: KVNamespace,
  date: string,
): Promise<TokenDecodeError[]> {
  const prefix = `${KEY_PREFIX}:${date}:`;
  const errors: TokenDecodeError[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ prefix, cursor, limit: 200 });
    for (const key of result.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        try {
          errors.push(JSON.parse(raw) as TokenDecodeError);
        } catch {
          // skip malformed entries
        }
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  // Sort by timestamp descending (newest first)
  return errors.sort((a, b) => b.ts - a.ts);
}

/**
 * Get recent token decode errors across all dates.
 * Searches today and yesterday, returns up to `limit` errors.
 */
export async function getRecentTokenErrors(
  kv: KVNamespace,
  limit = 50,
): Promise<TokenDecodeError[]> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [todayErrors, yesterdayErrors] = await Promise.all([
    getTokenErrorsByDate(kv, today),
    getTokenErrorsByDate(kv, yesterday),
  ]);

  // Combine and sort by timestamp descending
  const combined = [...todayErrors, ...yesterdayErrors]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);

  return combined;
}

/**
 * Get token error summary statistics.
 */
export async function getTokenErrorSummary(
  kv: KVNamespace,
): Promise<{
  totalErrors: number;
  byVersion: Record<string, number>;
  byError: Record<string, number>;
  recentCount24h: number;
}> {
  const errors = await getRecentTokenErrors(kv, 200);

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const summary = {
    totalErrors: errors.length,
    byVersion: {} as Record<string, number>,
    byError: {} as Record<string, number>,
    recentCount24h: 0,
  };

  for (const err of errors) {
    // By version
    summary.byVersion[err.tokenVersion] =
      (summary.byVersion[err.tokenVersion] ?? 0) + 1;

    // By error type (simplified)
    const errorType = simplifyErrorType(err.error);
    summary.byError[errorType] = (summary.byError[errorType] ?? 0) + 1;

    // Count last 24h
    if (err.ts >= oneDayAgo) {
      summary.recentCount24h++;
    }
  }

  return summary;
}

/**
 * Simplify error message to a category.
 */
function simplifyErrorType(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("cbor")) return "CBOR decode";
  if (lower.includes("base64")) return "Base64 decode";
  if (lower.includes("empty")) return "Empty token";
  if (lower.includes("mint")) return "Missing mint";
  if (lower.includes("proof")) return "Missing proofs";
  if (lower.includes("invalid")) return "Invalid format";
  return "Other";
}
