/**
 * Tests for src/lib/middleware.ts coverage gaps:
 * - CORS non-wildcard origin matching
 * - Rate limit exceeded path
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { corsMiddleware, rateLimitMiddleware } from "../lib/middleware.js";
import { createMockKV } from "./helpers.js";

describe("corsMiddleware", () => {
  it("allows matching origin from comma-separated list", async () => {
    const app = new Hono();
    app.use("*", corsMiddleware(() => "https://a.com,https://b.com"));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test", {
      headers: { Origin: "https://b.com" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://b.com");
  });

  it("does not set origin header for non-matching origin", async () => {
    const app = new Hono();
    app.use("*", corsMiddleware(() => "https://a.com"));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test", {
      headers: { Origin: "https://evil.com" },
    });
    // Should NOT have Allow-Origin set to evil.com
    const header = res.headers.get("Access-Control-Allow-Origin");
    expect(header).not.toBe("https://evil.com");
  });

  it("uses wildcard when config returns *", async () => {
    const app = new Hono();
    app.use("*", corsMiddleware(() => "*"));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("rateLimitMiddleware", () => {
  it("returns 429 when rate limit exceeded", async () => {
    const kv = createMockKV();
    const app = new Hono();
    app.use("*", rateLimitMiddleware(() => kv, { maxPerMinute: 2 }));
    app.get("/test", (c) => c.text("ok"));

    // First 2 requests succeed
    const res1 = await app.request("/test");
    expect(res1.status).toBe(200);
    const res2 = await app.request("/test");
    expect(res2.status).toBe(200);

    // Third should be rate limited
    const res3 = await app.request("/test");
    expect(res3.status).toBe(429);
    const body = await res3.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("skips rate limiting when no KV available", async () => {
    const app = new Hono();
    app.use("*", rateLimitMiddleware(() => null));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});
