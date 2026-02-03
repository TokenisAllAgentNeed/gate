import { describe, it, expect } from "vitest";
import { writeMetric, type MetricsRecord } from "../metrics.js";
import { createGateApp, type GateAppConfig } from "../create-app.js";
import { createMockKV } from "./helpers.js";

function makeRecord(overrides: Partial<MetricsRecord> = {}): MetricsRecord {
  return {
    ts: Date.UTC(2026, 1, 3, 10, 0, 0),
    model: "gpt-4o-mini",
    status: 200,
    ecash_in: 300,
    price: 200,
    change: 100,
    refunded: false,
    upstream_ms: 450,
    mint: "https://testnut.cashu.space",
    stream: false,
    ...overrides,
  };
}

function makeConfig(kv: KVNamespace): GateAppConfig {
  return {
    trustedMints: ["https://testnut.cashu.space"],
    upstreams: [
      { match: "*", baseUrl: "https://api.example.com", apiKey: "test-key" },
    ],
    pricing: [{ model: "*", mode: "per_request" as const, per_request: 200 }],
    kvStore: kv,
    adminToken: "test-admin-token",
    walletAddress: "0xtest",
  };
}

function adminHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-admin-token" };
}

// ── GET /v1/gate/metrics ────────────────────────────────────────

describe("GET /v1/gate/metrics", () => {
  it("should require admin auth", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request("http://localhost/v1/gate/metrics?date=2026-02-03"),
    );
    expect(res.status).toBe(401);
  });

  it("should return 400 if date param missing", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request("http://localhost/v1/gate/metrics", {
        headers: adminHeaders(),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("should return metrics for given date", async () => {
    const kv = createMockKV();
    await writeMetric(kv, makeRecord());
    await writeMetric(
      kv,
      makeRecord({
        ts: Date.UTC(2026, 1, 3, 11, 0, 0),
        model: "gpt-4o",
        error_code: "upstream_error",
        status: 502,
      }),
    );

    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request("http://localhost/v1/gate/metrics?date=2026-02-03", {
        headers: adminHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.date).toBe("2026-02-03");
    expect(body.records).toHaveLength(2);
    expect(body.records[0].model).toBe("gpt-4o-mini");
  });
});

// ── GET /v1/gate/metrics/summary ────────────────────────────────

describe("GET /v1/gate/metrics/summary", () => {
  it("should require admin auth", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request(
        "http://localhost/v1/gate/metrics/summary?from=2026-02-01&to=2026-02-03",
      ),
    );
    expect(res.status).toBe(401);
  });

  it("should return 400 if from/to missing", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request("http://localhost/v1/gate/metrics/summary", {
        headers: adminHeaders(),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("should return aggregated summary", async () => {
    const kv = createMockKV();
    await writeMetric(
      kv,
      makeRecord({ ts: Date.UTC(2026, 1, 1, 10, 0, 0), ecash_in: 300 }),
    );
    await writeMetric(
      kv,
      makeRecord({ ts: Date.UTC(2026, 1, 2, 10, 0, 0), ecash_in: 500 }),
    );

    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request(
        "http://localhost/v1/gate/metrics/summary?from=2026-02-01&to=2026-02-03",
        { headers: adminHeaders() },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.total_requests).toBe(2);
    expect(body.ecash_received).toBe(800);
    expect(body.success_count).toBe(2);
  });
});

// ── GET /v1/gate/metrics/summary — date validation ──────────────

describe("GET /v1/gate/metrics/summary date validation", () => {
  it("should return 400 for invalid date format", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request(
        "http://localhost/v1/gate/metrics/summary?from=foo&to=bar",
        { headers: adminHeaders() },
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ── GET /v1/gate/metrics/errors ─────────────────────────────────

describe("GET /v1/gate/metrics/errors", () => {
  it("should require admin auth", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request("http://localhost/v1/gate/metrics/errors?date=2026-02-03"),
    );
    expect(res.status).toBe(401);
  });

  it("should return only error records", async () => {
    const kv = createMockKV();
    await writeMetric(kv, makeRecord()); // success
    await writeMetric(
      kv,
      makeRecord({
        ts: Date.UTC(2026, 1, 3, 11, 0, 0),
        status: 500,
        error_code: "redeem_failed",
      }),
    );

    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(
      new Request("http://localhost/v1/gate/metrics/errors?date=2026-02-03", {
        headers: adminHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.date).toBe("2026-02-03");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].error_code).toBe("redeem_failed");
  });
});
