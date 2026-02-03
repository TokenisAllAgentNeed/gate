/**
 * Factory for building a Gate Hono app for E2E tests.
 *
 * Accepts trustedMints, redeemFn, and a mock upstream fetch function.
 */
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { stampGate } from "../../middleware.js";
import { createReceipt } from "../../lib/receipt.js";
import { getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import type { PricingRule, Stamp } from "../../lib/types.js";
import type { RedeemResult } from "../../redeem.js";

export type Variables = {
  stamp: Stamp;
  pricingRule: PricingRule;
  redeemKeep: Proof[];
  redeemChange: Proof[];
};

export interface GateAppOptions {
  trustedMints: string[];
  pricing: PricingRule[];
  redeemFn: (stamp: Stamp, price?: number) => Promise<RedeemResult>;
  /** Upstream fetch — called instead of real HTTP */
  upstreamFetch: (req: Request) => Promise<Response>;
}

export function createGateApp(opts: GateAppOptions) {
  const app = new Hono<{ Variables: Variables }>();

  const gateMiddleware = stampGate({
    trustedMints: opts.trustedMints,
    pricing: opts.pricing,
    redeemFn: opts.redeemFn,
  });

  app.post("/v1/chat/completions", gateMiddleware, async (c) => {
    const stamp = c.get("stamp");
    const rule = c.get("pricingRule");
    const redeemKeep = c.get("redeemKeep") as Proof[];
    const redeemChange = c.get("redeemChange") as Proof[];
    const body = await c.req.json();
    const model = body.model as string;

    const encodeToken = (proofs: Proof[]) =>
      getEncodedTokenV4({ mint: stamp.mint, proofs, unit: "usd" });
    const buildRefundToken = () =>
      encodeToken([...redeemKeep, ...redeemChange]);
    const buildChangeToken = () =>
      redeemChange.length > 0 ? encodeToken(redeemChange) : "";

    // Proxy to mock upstream
    const upstreamReq = new Request("http://mock/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const upstreamRes = await opts.upstreamFetch(upstreamReq);

    const contentType = upstreamRes.headers.get("content-type") ?? "";
    const isStream = contentType.includes("text/event-stream");

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.json().catch(() => ({
        error: { code: "upstream_error", message: "LLM API error" },
      }));
      return c.json(
        {
          error: {
            code: "upstream_error",
            message: errBody?.error?.message ?? "LLM error",
          },
        },
        502 as any,
        { "X-Cashu-Refund": buildRefundToken() }
      );
    }

    const receipt = await createReceipt(stamp, model, rule.per_request ?? 0);
    const receiptHeader = JSON.stringify(receipt);
    const changeToken = buildChangeToken();

    if (isStream && upstreamRes.body) {
      // SSE streaming — receipt in header, change via SSE event
      c.header("Content-Type", "text/event-stream");
      c.header("X-Cashu-Receipt", receiptHeader);
      const encoder = new TextEncoder();
      return honoStream(c, async (s) => {
        const reader = upstreamRes.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await s.write(value);
          }
        } finally {
          reader.releaseLock();
        }
        // Emit change via SSE event after stream ends
        if (changeToken) {
          await s.write(encoder.encode(`event: cashu-change\ndata: ${changeToken}\n\n`));
        }
      });
    }

    // Non-streaming — change in header
    const successHeaders: Record<string, string> = {
      "X-Cashu-Receipt": receiptHeader,
    };
    if (changeToken) successHeaders["X-Cashu-Change"] = changeToken;
    return c.json(await upstreamRes.json(), 200, successHeaders);
  });

  return app;
}

/** Helper to make a request to the gate app */
export function makeRequest(
  app: Hono<{ Variables: Variables }>,
  opts: { token?: string; model?: string; stream?: boolean }
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers["X-Cashu"] = opts.token;
  return app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model ?? "mock-ok",
        messages: [{ role: "user", content: "Hello" }],
        ...(opts.stream ? { stream: true } : {}),
      }),
    })
  );
}
