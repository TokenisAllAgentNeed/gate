/**
 * Admin UI Dashboard tests — GET /homo/ui
 *
 * Tests the unified admin dashboard that combines:
 * - Ecash balance and melt functionality
 * - Metrics overview and charts
 * - Error analysis (API errors + token decode errors)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createAdminUiRoute, renderAdminDashboard } from "../admin-ui.js";

const TEST_ADMIN_TOKEN = "test-admin-token-12345";

describe("renderAdminDashboard", () => {
  it("should return valid HTML with required elements", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Gate Admin");
    expect(html).toContain("token2chat");
  });

  it("should contain balance section", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("Ecash Balance");
    expect(html).toContain("s-balance");
    expect(html).toContain("proof");
  });

  it("should contain melt form", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("Melt to Lightning");
    expect(html).toContain("invoice");
    expect(html).toContain("handleMelt");
    expect(html).toContain("bolt11");
  });

  it("should contain melt button", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("melt-btn");
    expect(html).toContain("Melt All");
  });

  it("should contain history section", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("Session History");
    expect(html).toContain("history-list");
  });

  // Merged dashboard features (from old dashboard.ts)
  it("should contain metrics summary cards", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("Total Requests");
    expect(html).toContain("Success Rate");
    expect(html).toContain("Revenue");
    expect(html).toContain("s-total");
    expect(html).toContain("s-rate");
    expect(html).toContain("s-revenue");
  });

  it("should contain charts section", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("Revenue vs Cost");
    expect(html).toContain("Error Breakdown");
    expect(html).toContain("Model Usage");
    expect(html).toContain("revenue-chart");
    expect(html).toContain("error-chart");
    expect(html).toContain("model-chart");
  });

  it("should contain error analysis section", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("Recent API Errors");
    expect(html).toContain("Token Decode Errors");
    expect(html).toContain("error-list");
    expect(html).toContain("token-error-list");
  });

  it("should contain date range controls", () => {
    const html = renderAdminDashboard();
    expect(html).toContain('type="date"');
    expect(html).toContain("date-from");
    expect(html).toContain("date-to");
  });

  it("should fetch from admin API endpoints", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("/homo/balance");
    expect(html).toContain("/homo/melt");
    expect(html).toContain("/v1/gate/metrics/summary");
    expect(html).toContain("/v1/gate/metrics/errors");
    expect(html).toContain("/v1/gate/token-errors");
  });

  it("should support token from URL query param", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("URLSearchParams");
    expect(html).toContain("get('token')");
  });

  it("should render melt result with all fields", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("renderMeltResult");
    expect(html).toContain("payment_preimage");
    expect(html).toContain("amount_units");
    expect(html).toContain("fee_units");
    expect(html).toContain("input_units");
    expect(html).toContain("change_units");
  });

  it("should include alert banner for token errors", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("token-error-banner");
    expect(html).toContain("token-error-count");
  });

  it("should include token error filter", () => {
    const html = renderAdminDashboard();
    expect(html).toContain("token-error-filter");
    expect(html).toContain("V3 Only");
    expect(html).toContain("V4 Only");
  });
});

describe("GET /homo/ui route", () => {
  it("returns 401 without token", async () => {
    const app = new Hono();
    app.get("/homo/ui", createAdminUiRoute({ adminToken: TEST_ADMIN_TOKEN }));

    const res = await app.request("/homo/ui");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token in header", async () => {
    const app = new Hono();
    app.get("/homo/ui", createAdminUiRoute({ adminToken: TEST_ADMIN_TOKEN }));

    const res = await app.request("/homo/ui", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token in query param", async () => {
    const app = new Hono();
    app.get("/homo/ui", createAdminUiRoute({ adminToken: TEST_ADMIN_TOKEN }));

    const res = await app.request("/homo/ui?token=wrong-token");
    expect(res.status).toBe(401);
  });

  it("returns 503 when admin token not configured", async () => {
    const app = new Hono();
    app.get("/homo/ui", createAdminUiRoute({ adminToken: undefined }));

    const res = await app.request("/homo/ui");
    expect(res.status).toBe(503);
  });

  it("returns HTML with valid token in header", async () => {
    const app = new Hono();
    app.get("/homo/ui", createAdminUiRoute({ adminToken: TEST_ADMIN_TOKEN }));

    const res = await app.request("/homo/ui", {
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("Gate Admin");
    expect(body).toContain("Ecash Balance");
  });

  it("returns HTML with valid token in query param", async () => {
    const app = new Hono();
    app.get("/homo/ui", createAdminUiRoute({ adminToken: TEST_ADMIN_TOKEN }));

    const res = await app.request(`/homo/ui?token=${TEST_ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("Gate Admin");
  });
});

describe("GET /homo/ui integration with createGateApp", () => {
  it("route exists and works with query param auth", async () => {
    const mockKV = {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true }; },
    };

    const { createGateApp } = await import("../create-app.js");
    const app = createGateApp({
      trustedMints: ["https://testnut.cashu.space"],
      upstreams: [{ match: "*", baseUrl: "https://api.example.com", apiKey: "k" }],
      pricing: [{ model: "*", mode: "per_request" as const, per_request: 200 }],
      kvStore: mockKV,
      adminToken: TEST_ADMIN_TOKEN,
      walletAddress: "0xtest",
    });

    // Test with query param auth (browser-friendly)
    const res = await app.fetch(new Request(`http://localhost/homo/ui?token=${TEST_ADMIN_TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("Gate Admin");
    expect(body).toContain("Ecash Balance");
    expect(body).toContain("Melt to Lightning");
    // New merged features
    expect(body).toContain("Total Requests");
    expect(body).toContain("Model Usage");
  });

  it("route requires authentication", async () => {
    const mockKV = {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true }; },
    };

    const { createGateApp } = await import("../create-app.js");
    const app = createGateApp({
      trustedMints: ["https://testnut.cashu.space"],
      upstreams: [{ match: "*", baseUrl: "https://api.example.com", apiKey: "k" }],
      pricing: [{ model: "*", mode: "per_request" as const, per_request: 200 }],
      kvStore: mockKV,
      adminToken: TEST_ADMIN_TOKEN,
      walletAddress: "0xtest",
    });

    // No auth
    const res = await app.fetch(new Request("http://localhost/homo/ui"));
    expect(res.status).toBe(401);
  });

  it("landing page includes homo/ui endpoint", async () => {
    const mockKV = {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true }; },
    };

    const { createGateApp } = await import("../create-app.js");
    const app = createGateApp({
      trustedMints: ["https://testnut.cashu.space"],
      upstreams: [{ match: "*", baseUrl: "https://api.example.com", apiKey: "k" }],
      pricing: [{ model: "*", mode: "per_request" as const, per_request: 200 }],
      kvStore: mockKV,
      adminToken: TEST_ADMIN_TOKEN,
      walletAddress: "0xtest",
    });

    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.endpoints["GET /homo/ui"]).toContain("Admin dashboard");
  });
});
