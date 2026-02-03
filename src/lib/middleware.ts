/**
 * Shared middleware factories for Hono-based token2chat services.
 *
 * Uses structural typing instead of importing Hono directly so that
 * @token2chat/core doesn't need hono as a dependency.
 */
import type { KVNamespace } from "./kv.js";

/** Minimal Hono-compatible context shape */
interface HonoContext {
  req: { header(name: string): string | undefined };
  res: { headers: { set(name: string, value: string): void } };
  json(data: unknown, status?: number): Response | Promise<Response>;
  env: unknown;
}

type NextFn = () => Promise<void>;

export interface CorsOptions {
  /** Comma-separated origins or "*" */
  allowedOrigins?: string;
  /** Additional allowed headers beyond the defaults */
  extraHeaders?: string[];
}

/**
 * CORS middleware factory — handles preflight and response headers.
 *
 * @param getOriginConfig - Function to extract ALLOWED_ORIGINS from env at request time
 */
export function corsMiddleware<C extends HonoContext>(getOriginConfig: (c: C) => string) {
  return async (c: C, next: NextFn) => {
    const allowedRaw = getOriginConfig(c) ?? "*";
    const origin = c.req.header("Origin") ?? "";

    await next();

    if (allowedRaw === "*") {
      c.res.headers.set("Access-Control-Allow-Origin", "*");
    } else {
      const allowed = allowedRaw.split(",").map((s) => s.trim());
      if (allowed.includes(origin)) {
        c.res.headers.set("Access-Control-Allow-Origin", origin);
      }
    }
    c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.res.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Cashu"
    );
    c.res.headers.set("Access-Control-Max-Age", "86400");
  };
}

export interface RateLimitOptions {
  /** Max requests per minute per IP (default: 60) */
  maxPerMinute?: number;
  /** TTL for the counter key in seconds (default: 120) */
  ttlSeconds?: number;
}

/**
 * IP-based rate limiting middleware factory using KV counters.
 *
 * @param getKV - Function to extract KV namespace from env at request time (return null to skip)
 */
export function rateLimitMiddleware<C extends HonoContext>(
  getKV: (c: C) => KVNamespace | null | undefined,
  opts?: RateLimitOptions
) {
  const maxPerMinute = opts?.maxPerMinute ?? 60;
  const ttlSeconds = opts?.ttlSeconds ?? 120;

  return async (c: C, next: NextFn) => {
    const kv = getKV(c);
    if (!kv) return next();

    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For") ??
      "unknown";
    const minute = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:${ip}:${minute}`;

    const current = parseInt((await kv.get(key)) ?? "0", 10);
    if (current >= maxPerMinute) {
      return c.json(
        { error: "Too many requests", code: "RATE_LIMITED" },
        429
      );
    }

    await kv.put(key, String(current + 1), { expirationTtl: ttlSeconds });
    return next();
  };
}
