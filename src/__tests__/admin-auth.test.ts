/**
 * admin-auth.test.ts — Tests for /v1/gate/* admin endpoint authentication
 *
 * Requirements:
 * 1. Bearer token auth via GATE_ADMIN_TOKEN environment variable
 * 2. If token NOT configured → 503 (service unavailable)
 * 3. If token configured but request missing/mismatched → 401
 * 4. If token configured and matches → proceed (200)
 */
import { describe, it, expect } from "vitest";
import type { KVNamespace } from "../lib/kv.js";
import { createGateApp, type GateAppConfig } from "../create-app.js";
import { createMockKV } from "./helpers.js";

function makeBaseConfig(kv: KVNamespace): Omit<GateAppConfig, "adminToken"> {
  return {
    trustedMints: ["https://testnut.cashu.space"],
    upstreams: [
      { match: "*", baseUrl: "https://api.example.com", apiKey: "test-key" },
    ],
    pricing: [{ model: "*", mode: "per_request" as const, per_request: 200 }],
    kvStore: kv,
    walletAddress: "0xtest",
  };
}

// All admin endpoints to test (dashboard is public, auth via JS)
const ADMIN_ENDPOINTS = [
  { method: "GET", path: "/v1/gate/balance" },
  { method: "POST", path: "/v1/gate/melt" },
  { method: "GET", path: "/v1/gate/metrics?date=2026-02-03" },
  { method: "GET", path: "/v1/gate/metrics/summary?from=2026-02-01&to=2026-02-03" },
  { method: "GET", path: "/v1/gate/metrics/errors?date=2026-02-03" },
];

// ── Tests: Token NOT configured → 503 ───────────────────────────

describe("Admin auth: token not configured", () => {
  for (const { method, path } of ADMIN_ENDPOINTS) {
    it(`${method} ${path.split("?")[0]} should return 503 when GATE_ADMIN_TOKEN not set`, async () => {
      const kv = createMockKV();
      const config: GateAppConfig = {
        ...makeBaseConfig(kv),
        adminToken: undefined, // NOT configured
      };
      const app = createGateApp(config);

      const res = await app.fetch(
        new Request(`http://localhost${path}`, { method }),
      );

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/not available|unavailable/i);
    });
  }
});

// ── Tests: Token configured but missing in request → 401 ────────

describe("Admin auth: token configured, missing Authorization header", () => {
  for (const { method, path } of ADMIN_ENDPOINTS) {
    it(`${method} ${path.split("?")[0]} should return 401 when no Authorization header`, async () => {
      const kv = createMockKV();
      const config: GateAppConfig = {
        ...makeBaseConfig(kv),
        adminToken: "secret-admin-token",
      };
      const app = createGateApp(config);

      const res = await app.fetch(
        new Request(`http://localhost${path}`, { method }),
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/unauthorized/i);
    });
  }
});

// ── Tests: Token configured but wrong token → 401 ───────────────

describe("Admin auth: token configured, wrong token", () => {
  for (const { method, path } of ADMIN_ENDPOINTS) {
    it(`${method} ${path.split("?")[0]} should return 401 when token doesn't match`, async () => {
      const kv = createMockKV();
      const config: GateAppConfig = {
        ...makeBaseConfig(kv),
        adminToken: "secret-admin-token",
      };
      const app = createGateApp(config);

      const res = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { Authorization: "Bearer wrong-token" },
        }),
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/unauthorized/i);
    });
  }
});

// ── Tests: Token configured and correct → success ───────────────

describe("Admin auth: token configured and correct", () => {
  it("GET /v1/gate/balance should return 200 with correct token", async () => {
    const kv = createMockKV();
    const config: GateAppConfig = {
      ...makeBaseConfig(kv),
      adminToken: "secret-admin-token",
    };
    const app = createGateApp(config);

    const res = await app.fetch(
      new Request("http://localhost/v1/gate/balance", {
        method: "GET",
        headers: { Authorization: "Bearer secret-admin-token" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance_units: number };
    expect(body.balance_units).toBeDefined();
  });

  it("GET /homo/ui should return 200 with auth (protected dashboard)", async () => {
    const kv = createMockKV();
    const config: GateAppConfig = {
      ...makeBaseConfig(kv),
      adminToken: "secret-admin-token",
    };
    const app = createGateApp(config);

    // Dashboard requires auth via query param or header
    const res = await app.fetch(
      new Request("http://localhost/homo/ui?token=secret-admin-token", {
        method: "GET",
      }),
    );

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toMatch(/text\/html/);
  });

  it("GET /homo/ui should return 401 without auth", async () => {
    const kv = createMockKV();
    const config: GateAppConfig = {
      ...makeBaseConfig(kv),
      adminToken: "secret-admin-token",
    };
    const app = createGateApp(config);

    const res = await app.fetch(
      new Request("http://localhost/homo/ui", {
        method: "GET",
      }),
    );

    expect(res.status).toBe(401);
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe("Admin auth: edge cases", () => {
  it("should reject malformed Authorization header (no Bearer prefix)", async () => {
    const kv = createMockKV();
    const config: GateAppConfig = {
      ...makeBaseConfig(kv),
      adminToken: "secret-admin-token",
    };
    const app = createGateApp(config);

    const res = await app.fetch(
      new Request("http://localhost/v1/gate/balance", {
        method: "GET",
        headers: { Authorization: "secret-admin-token" }, // Missing "Bearer "
      }),
    );

    expect(res.status).toBe(401);
  });

  it("should reject empty adminToken config as unconfigured (503)", async () => {
    const kv = createMockKV();
    const config: GateAppConfig = {
      ...makeBaseConfig(kv),
      adminToken: "", // Empty string = unconfigured
    };
    const app = createGateApp(config);

    const res = await app.fetch(
      new Request("http://localhost/v1/gate/balance", {
        method: "GET",
        headers: { Authorization: "Bearer " },
      }),
    );

    expect(res.status).toBe(503);
  });
});
