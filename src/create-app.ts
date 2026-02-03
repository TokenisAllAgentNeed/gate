/**
 * create-app.ts — Shared Hono application factory for the Gate.
 *
 * Both worker.ts (Cloudflare Workers) and server.ts (standalone Node)
 * call createGateApp(config) to build the same app with identical routes.
 */
import { Hono, type Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { stampGate } from "./middleware.js";
import { createRedeemFn } from "./redeem.js";
import { createReceipt } from "./lib/receipt.js";
import { corsMiddleware, rateLimitMiddleware } from "./lib/middleware.js";
import type { PricingRule, Stamp } from "./lib/types.js";
import type { KVNamespace } from "./lib/kv.js";
import type { RedeemResult } from "./redeem.js";
import {
  resolveUpstream,
  proxyToUpstream,
  type UpstreamEntry,
  type ChatCompletionRequest,
} from "./upstream.js";
import { getBalance, deleteKeys } from "./ecash-store.js";
import { meltProofs } from "./melt.js";
import {
  writeMetric,
  getMetricsByDate,
  getErrorsByDate,
  computeSummary,
  type MetricsRecord,
} from "./metrics.js";
import {
  writeTokenError,
  getTokenErrorsByDate,
  getRecentTokenErrors,
  getTokenErrorSummary,
} from "./token-errors.js";
import { VERSION_INFO } from "./version.js";
import {
  createAdminMeltLnRoute,
  createAdminBalanceLnRoute,
} from "./admin-melt-ln.js";
import { createAdminUiRoute } from "./admin-ui.js";
import { createAdminWithdrawRoute } from "./admin-withdraw.js";
import { createAdminCleanupRoute } from "./admin-cleanup.js";

// ── Config ────────────────────────────────────────────────────────

export interface GateAppConfig {
  trustedMints: string[];
  upstreams: UpstreamEntry[];
  pricing: PricingRule[];

  /** Optional KV store for ecash proof persistence (CF Workers KV or compatible) */
  kvStore?: KVNamespace | null;
  /** Bearer token for admin-only endpoints (/v1/gate/balance, /v1/gate/melt) */
  adminToken?: string;
  /** Mint URL for melt operations */
  mintUrl?: string;
  /** On-chain wallet address for melt payouts */
  walletAddress?: string;
  /** Comma-separated allowed CORS origins, or "*" */
  allowedOrigins?: string;

  /**
   * Custom redeem function. If not provided, a default one is created
   * that swaps at the mint and optionally persists to kvStore.
   */
  redeemFn?: (stamp: Stamp, price?: number) => Promise<RedeemResult>;
}

// ── Variables set by middleware ────────────────────────────────────

export type Variables = {
  stamp: Stamp;
  pricingRule: PricingRule;
  /** Estimated price in units (for per_token mode) */
  estimatedPrice: number;
  /** Proofs the Gate keeps (= price amount) */
  redeemKeep: Proof[];
  /** Change proofs to return to user (empty if exact payment) */
  redeemChange: Proof[];
  /** KV key where keep proofs were stored (for cleanup on refund) */
  redeemKvKey?: string;
  /** Parsed request body (set once, reused to avoid double-parsing) */
  parsedBody?: Record<string, unknown>;
};

// ── Helpers ───────────────────────────────────────────────────

/** Validate YYYY-MM-DD date string */
function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T00:00:00Z").getTime());
}

import { timingSafeEqual } from "./lib/auth.js";

// ── App factory ───────────────────────────────────────────────────

export function createGateApp(config: GateAppConfig) {
  const {
    trustedMints,
    upstreams,
    pricing,
    kvStore,
    adminToken,
    mintUrl = "https://mint.token2chat.com",
    walletAddress,
    allowedOrigins = "*",
  } = config;

  if (!walletAddress) {
    throw new Error("walletAddress is required in GateAppConfig (set GATE_WALLET_ADDRESS env var)");
  }

  // Build redeemFn — use provided one or create default with KV persistence
  const redeemFn =
    config.redeemFn ??
    createRedeemFn({
      onRedeem: kvStore
        ? async (mint, proofs) => {
            const { storeProofs } = await import("./ecash-store.js");
            return await storeProofs(kvStore, mint, proofs);
          }
        : undefined,
    });

  const app = new Hono<{ Variables: Variables }>();

  // ── CORS ──────────────────────────────────────────────────────
  app.use("*", corsMiddleware(() => allowedOrigins));
  app.options("*", (c) => c.body(null, 204));

  // ── Version header on all responses ───────────────────────────
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Gate-Version", VERSION_INFO.version);
  });

  // ── Rate limiting (only when KV is available) ─────────────────
  app.use("*", rateLimitMiddleware(() => kvStore ?? null));

  // ── Landing page ──────────────────────────────────────────────
  app.get("/", (c) =>
    c.json({
      service: VERSION_INFO.name,
      version: VERSION_INFO.version,
      description:
        "Pay-per-call LLM API. Attach a Cashu ecash token to any request — no accounts, no KYC.",
      protocol: {
        method: "POST",
        endpoint: "/v1/chat/completions",
        auth: 'X-Cashu header with a valid Cashu token (cashuA... or cashuB...)',
        body: "OpenAI-compatible chat completions format",
        streaming: true,
      },
      endpoints: {
        "GET /": "You are here",
        "GET /health": "Service health + upstream status",
        "GET /stats": "Request statistics (admin, today + 7d summary)",
        "GET /v1/info": "Version information",
        "GET /v1/pricing": "Per-model pricing in units",
        "POST /v1/chat/completions": "Send a stamped chat request",
        "GET /v1/gate/balance": "Gate wallet ecash balance",
        "POST /v1/gate/melt": "Melt ecash → USDC via mint (on-chain)",
        "POST /homo/melt": "Melt ecash → Lightning invoice",
        "GET /homo/balance": "Gate ecash balance (for Lightning melt)",
        "POST /homo/withdraw": "Withdraw ecash from Gate (specify amount)",
        "GET /homo/ui": "Admin dashboard (metrics, melt, errors — supports ?token= auth)",
      },
      quick_start: [
        "1. Get Cashu tokens from a supported mint",
        "2. POST /v1/chat/completions with X-Cashu header + OpenAI-format body",
        "3. Receive chat completion + X-Cashu-Receipt header",
      ],
      example: {
        request: {
          method: "POST",
          url: "/v1/chat/completions",
          headers: {
            "Content-Type": "application/json",
            "X-Cashu": "cashuB...<your_token>",
          },
          body: {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "Hello" }],
          },
        },
        cost: "200 sat (gpt-4o-mini per request)",
      },
      mints: trustedMints,
      pricing_url: "/v1/pricing",
      source: "https://github.com/TokenisAllAgentNeed/token2chat",
    }),
  );

  // ── Health ────────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      mints: trustedMints,
      models: pricing.map((p) => p.model),
      upstreams: upstreams.map((u) => ({
        match: u.match,
        baseUrl: u.baseUrl,
      })),
    }),
  );

  // ── Version info ──────────────────────────────────────────────
  app.get("/v1/info", (c) => c.json(VERSION_INFO));

  // ── Stats (admin) ─────────────────────────────────────────────
  app.get("/stats", async (c) => {
    const authErr = await requireAdmin(c);
    if (authErr) return authErr;
    if (!kvStore) {
      return c.json({ error: "Storage not available" }, 500);
    }

    // Calculate today and 7 days ago
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // Compute summaries in parallel
    const [todaySummary, weekSummary] = await Promise.all([
      computeSummary(kvStore, today, today),
      computeSummary(kvStore, sevenDaysAgo, today),
    ]);

    return c.json({
      generated_at: now.toISOString(),
      today: todaySummary,
      last_7_days: weekSummary,
    });
  });

  // ── Pricing ───────────────────────────────────────────────────
  app.get("/v1/pricing", (c) =>
    c.json({
      unit: "usd",
      mints: trustedMints,
      // Default mode for the gate
      pricing_mode: "per_token",
      // Exchange rate info
      exchange_rate: {
        usd_to_units: 100000,
        description: "1 USD = 100,000 units",
      },
      // Per-model pricing
      models: Object.fromEntries(
        pricing.map((p) => {
          if (p.mode === "per_token") {
            return [
              p.model,
              {
                mode: "per_token",
                input_per_million: p.input_per_million ?? 0,
                output_per_million: p.output_per_million ?? 0,
              },
            ];
          }
          // Legacy per_request mode (deprecated)
          return [
            p.model,
            {
              mode: "per_request",
              per_request: p.per_request ?? 0,
              deprecated: true,
            },
          ];
        }),
      ),
    }),
  );

  // ── Admin auth helper with brute-force protection ────────────
  const adminFailCounts = new Map<string, { count: number; resetAt: number }>();
  const adminLockouts = new Map<string, number>();
  const ADMIN_MAX_FAILURES = 5;
  const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;
  const ADMIN_WINDOW_MS = 60 * 1000;

  async function requireAdmin(c: Context): Promise<Response | null> {
    if (!adminToken) {
      return c.json({ error: "Admin endpoint not available" }, 503);
    }

    const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "unknown";

    // Check lockout
    const lockoutExpiry = adminLockouts.get(ip);
    if (lockoutExpiry && Date.now() < lockoutExpiry) {
      return c.json({ error: "Too many failed attempts. Try again later." }, 429);
    }
    if (lockoutExpiry) adminLockouts.delete(ip);

    const auth = c.req.header("Authorization");
    const expected = `Bearer ${adminToken}`;
    if (!auth || !timingSafeEqual(auth, expected)) {
      const now = Date.now();
      const entry = adminFailCounts.get(ip);
      if (!entry || now > entry.resetAt) {
        adminFailCounts.set(ip, { count: 1, resetAt: now + ADMIN_WINDOW_MS });
      } else {
        entry.count += 1;
        if (entry.count >= ADMIN_MAX_FAILURES) {
          adminLockouts.set(ip, now + ADMIN_LOCKOUT_MS);
          adminFailCounts.delete(ip);
          return c.json({ error: "Too many failed attempts. Try again later." }, 429);
        }
      }
      return c.json({ error: "Unauthorized — admin only" }, 401);
    }

    adminFailCounts.delete(ip);
    return null;
  }

  // ── Balance ───────────────────────────────────────────────────
  app.get("/v1/gate/balance", async (c) => {
    const authErr = await requireAdmin(c);
    if (authErr) return authErr;
    if (!kvStore) {
      return c.json({ error: "Storage not available" }, 500);
    }
    const balance = await getBalance(kvStore);
    return c.json({ balance_units: balance, unit: "usd" });
  });

  // ── Melt (on-chain) ────────────────────────────────────────────
  app.post("/v1/gate/melt", async (c) => {
    const authErr = await requireAdmin(c);
    if (authErr) return authErr;
    if (!kvStore) {
      return c.json({ error: "Storage not available" }, 500);
    }
    const result = await meltProofs({
      kv: kvStore,
      mintUrl,
      walletAddress,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 500 | 502 | 504);
    }
    return c.json({
      melted: result.melted,
      amount_units: result.amount_units,
      tx_hash: result.tx_hash,
      address: result.address,
      change_units: result.change_units,
    });
  });

  // ── Melt to Lightning ─────────────────────────────────────────
  app.post("/homo/melt", createAdminMeltLnRoute({
    adminToken,
    kvStore,
    mintUrl,
  }));

  // Alias: /v1/gate/melt-ln for consistency
  app.post("/v1/gate/melt-ln", createAdminMeltLnRoute({
    adminToken,
    kvStore,
    mintUrl,
  }));

  // ── Withdraw ecash (admin → external wallet) ──────────────────
  app.post("/homo/withdraw", createAdminWithdrawRoute({
    adminToken,
    kvStore,
    mintUrl,
  }));

  // ── Cleanup spent proofs ────────────────────────────────────────
  app.post("/homo/cleanup", createAdminCleanupRoute({
    adminToken,
    kvStore,
    mintUrl,
  }));

  // ── Lightning balance (ecash available to melt) ───────────────
  app.get("/homo/balance", createAdminBalanceLnRoute({
    adminToken,
    kvStore,
  }));

  // ── Admin UI Dashboard ────────────────────────────────────────
  app.get("/homo/ui", createAdminUiRoute({
    adminToken,
  }));

  // ── Metrics API (admin only) ──────────────────────────────────

  app.get("/v1/gate/metrics/summary", async (c) => {
    const authErr = await requireAdmin(c);
    if (authErr) return authErr;
    if (!kvStore) return c.json({ error: "Storage not available" }, 500);

    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) {
      return c.json({ error: "Missing 'from' and 'to' query params (YYYY-MM-DD)" }, 400);
    }
    if (!isValidDate(from) || !isValidDate(to)) {
      return c.json({ error: "Invalid date format. Expected YYYY-MM-DD" }, 400);
    }

    const summary = await computeSummary(kvStore, from, to);
    return c.json(summary);
  });

  app.get("/v1/gate/metrics/errors", async (c) => {
    const authErr = await requireAdmin(c);
    if (authErr) return authErr;
    if (!kvStore) return c.json({ error: "Storage not available" }, 500);

    const date = c.req.query("date");
    if (!date) {
      return c.json({ error: "Missing 'date' query param (YYYY-MM-DD)" }, 400);
    }

    const errors = await getErrorsByDate(kvStore, date);
    return c.json({ date, errors });
  });

  app.get("/v1/gate/metrics", async (c) => {
    const authErr = await requireAdmin(c);
    if (authErr) return authErr;
    if (!kvStore) return c.json({ error: "Storage not available" }, 500);

    const date = c.req.query("date");
    if (!date) {
      return c.json({ error: "Missing 'date' query param (YYYY-MM-DD)" }, 400);
    }

    const records = await getMetricsByDate(kvStore, date);
    return c.json({ date, records });
  });

  // ── Token Decode Errors API (admin only) ───────────────────────

  app.get("/v1/gate/token-errors", async (c) => {
    const authErr = await requireAdmin(c);
    if (authErr) return authErr;
    if (!kvStore) return c.json({ error: "Storage not available" }, 500);

    const date = c.req.query("date");
    const limit = parseInt(c.req.query("limit") || "50", 10);

    if (date) {
      // Get errors for a specific date
      const errors = await getTokenErrorsByDate(kvStore, date);
      return c.json({ date, errors, count: errors.length });
    }

    // Get recent errors (last 24h)
    const errors = await getRecentTokenErrors(kvStore, Math.min(limit, 100));
    return c.json({ errors, count: errors.length });
  });

  app.get("/v1/gate/token-errors/summary", async (c) => {
    const authErr = await requireAdmin(c);
    if (authErr) return authErr;
    if (!kvStore) return c.json({ error: "Storage not available" }, 500);

    const summary = await getTokenErrorSummary(kvStore);
    return c.json(summary);
  });

  // ── Chat completions (stamped) ────────────────────────────────
  /** Write a middleware-level error metric (non-blocking). */
  const writeMiddlewareMetric = kvStore
    ? (metric: import("./middleware.js").MiddlewareMetric) => {
        const record: MetricsRecord = {
          ts: Date.now(),
          model: metric.model,
          status: metric.status,
          ecash_in: metric.ecash_in,
          price: 0,
          change: 0,
          refunded: false,
          upstream_ms: 0,
          error_code: metric.error_code,
          mint: metric.mint,
          stream: metric.stream,
        };
        writeMetric(kvStore, record).catch(() => {});
      }
    : undefined;

  /** Write token decode error (non-blocking). */
  const writeTokenDecodeError = kvStore
    ? (
        diagnostics: import("./lib/decode.js").DecodeDiagnostics,
        rawToken: string,
        metadata: { ipHash?: string; userAgent?: string }
      ) => {
        writeTokenError(kvStore, diagnostics, rawToken, metadata).catch(() => {});
      }
    : undefined;

  const gateMiddleware = stampGate({
    trustedMints,
    pricing,
    redeemFn,
    onMetric: writeMiddlewareMetric,
    onTokenError: writeTokenDecodeError,
  });

  app.post("/v1/chat/completions", gateMiddleware, async (c) => {
    const requestStart = Date.now();
    const stamp = c.get("stamp");
    const rule = c.get("pricingRule");
    const estimatedPrice = c.get("estimatedPrice") as number;
    const redeemKeep = c.get("redeemKeep") as Proof[];
    const redeemChange = c.get("redeemChange") as Proof[];
    const body = ((c.get("parsedBody") as Record<string, unknown>) ?? await c.req.json()) as ChatCompletionRequest;
    const model = body.model as string;
    const isStreamReq = body.stream === true;

    // Helper: encode proofs as cashu token string
    const encodeToken = (proofs: Proof[]) =>
      getEncodedTokenV4({ mint: stamp.mint, proofs, unit: "usd" });

    // Helper: full refund (Gate's proofs + change proofs back to user)
    const buildRefundToken = () => encodeToken([...redeemKeep, ...redeemChange]);

    // Helper: change token (only overpayment, empty string if no change)
    const buildChangeToken = () =>
      redeemChange.length > 0 ? encodeToken(redeemChange) : "";

    // Helper: record metrics (non-blocking)
    const recordMetric = (status: number, errorCode?: string, refunded = false) => {
      if (!kvStore) return;
      const changeAmount = redeemChange.reduce((s, p) => s + p.amount, 0);
      const record: MetricsRecord = {
        ts: Date.now(),
        model,
        status,
        ecash_in: stamp.amount,
        price: estimatedPrice, // Use estimated price (per_token or per_request)
        change: changeAmount,
        refunded,
        upstream_ms: Date.now() - requestStart,
        error_code: errorCode,
        mint: stamp.mint,
        stream: isStreamReq,
      };
      const writePromise = writeMetric(kvStore, record);
      // Use waitUntil if available (CF Workers), otherwise fire-and-forget
      try {
        if (c.executionCtx?.waitUntil) {
          c.executionCtx.waitUntil(writePromise);
          return;
        }
      } catch {
        // executionCtx getter throws outside CF Workers — fall through
      }
      writePromise.catch(() => {}); // swallow errors silently
    };

    // Helper: clean up stored keep proofs from KV on refund
    const cleanupKvOnRefund = async () => {
      const redeemKvKey = c.get("redeemKvKey") as string | undefined;
      if (kvStore && redeemKvKey) {
        try {
          await deleteKeys(kvStore, [redeemKvKey]);
        } catch (e) {
          console.error("Failed to delete keep proofs from KV on refund:", e);
        }
      }
    };

    // Resolve upstream
    const upstream = resolveUpstream(model, upstreams);
    if (!upstream) {
      recordMetric(502, "no_upstream", true);
      await cleanupKvOnRefund();
      return c.json(
        {
          error: {
            code: "no_upstream",
            message: `No upstream configured for model: ${model}`,
          },
        },
        502,
        { "X-Cashu-Refund": buildRefundToken() },
      );
    }

    // Proxy to upstream
    const result = await proxyToUpstream(upstream, body);

    // Upstream failed — full refund (keep + change) via X-Cashu-Refund
    if (!result.isStream && result.status !== 200) {
      recordMetric(result.status, "upstream_error", true);
      await cleanupKvOnRefund();
      return c.json(result.body, result.status as 400 | 500 | 502 | 504, {
        "X-Cashu-Refund": buildRefundToken(),
      });
    }

    // Upstream succeeded — create receipt + optional change
    const receipt = await createReceipt(stamp, model, estimatedPrice);
    const receiptHeader = JSON.stringify(receipt);
    const changeToken = buildChangeToken();

    // Record success metric
    recordMetric(200);

    if (result.isStream && result.stream) {
      // SSE streaming response — receipt in headers, change via SSE event
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("X-Cashu-Receipt", receiptHeader);

      const encoder = new TextEncoder();
      return honoStream(
        c,
        async (s) => {
          const reader = result.stream!.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await s.write(value);
            }
          } finally {
            reader.releaseLock();
          }

          // After upstream stream ends, emit change via SSE event
          if (changeToken) {
            await s.write(encoder.encode(`event: cashu-change\ndata: ${changeToken}\n\n`));
          }
        },
        async (_err, s) => {
          s.abort();
        },
      );
    }

    // Non-streaming success — change in header
    const successHeaders: Record<string, string> = {
      "X-Cashu-Receipt": receiptHeader,
    };
    if (changeToken) {
      successHeaders["X-Cashu-Change"] = changeToken;
    }
    return c.json(result.body, 200, successHeaders);
  });

  return app;
}
