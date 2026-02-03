import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeMetric, type MetricsRecord } from "../metrics.js";
import { createGateApp, type GateAppConfig } from "../create-app.js";
import { createMockKV } from "./helpers.js";

function makeRecord(overrides: Partial<MetricsRecord> = {}): MetricsRecord {
  return {
    ts: Date.now(),
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

function makeConfig(kv: KVNamespace | null): GateAppConfig {
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

function authedRequest(url: string): Request {
  return new Request(url, {
    headers: { Authorization: "Bearer test-admin-token" },
  });
}

describe("GET /stats", () => {
  let realDate: DateConstructor;

  beforeEach(() => {
    realDate = globalThis.Date;
  });

  afterEach(() => {
    globalThis.Date = realDate;
  });

  it("should require admin auth (401 without token)", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(new Request("http://localhost/stats"));
    expect(res.status).toBe(401);
  });

  it("should return 500 when storage not available", async () => {
    const app = createGateApp(makeConfig(null));
    const res = await app.fetch(authedRequest("http://localhost/stats"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/Storage not available/);
  });

  it("should return today and last_7_days summaries", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(authedRequest("http://localhost/stats"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body).toHaveProperty("generated_at");
    expect(body).toHaveProperty("today");
    expect(body).toHaveProperty("last_7_days");

    // Verify summary structure
    expect(body.today).toHaveProperty("total_requests");
    expect(body.today).toHaveProperty("success_count");
    expect(body.today).toHaveProperty("error_count");
    expect(body.today).toHaveProperty("ecash_received");
    expect(body.today).toHaveProperty("model_breakdown");

    expect(body.last_7_days).toHaveProperty("total_requests");
  });

  it("should include metrics from today in both summaries", async () => {
    const kv = createMockKV();
    // Write a metric for "today"
    await writeMetric(kv, makeRecord({ ecash_in: 500 }));

    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(authedRequest("http://localhost/stats"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.today.total_requests).toBe(1);
    expect(body.today.ecash_received).toBe(500);
    expect(body.last_7_days.total_requests).toBe(1);
    expect(body.last_7_days.ecash_received).toBe(500);
  });

  it("should aggregate metrics across 7 days", async () => {
    const kv = createMockKV();

    // Write metrics for multiple days
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    // Today
    await writeMetric(kv, makeRecord({ ts: now, ecash_in: 100 }));
    // 2 days ago
    await writeMetric(kv, makeRecord({ ts: now - 2 * oneDay, ecash_in: 200 }));
    // 5 days ago
    await writeMetric(kv, makeRecord({ ts: now - 5 * oneDay, ecash_in: 300 }));

    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(authedRequest("http://localhost/stats"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    // Today only has 1 request
    expect(body.today.total_requests).toBe(1);
    expect(body.today.ecash_received).toBe(100);

    // Last 7 days has all 3
    expect(body.last_7_days.total_requests).toBe(3);
    expect(body.last_7_days.ecash_received).toBe(600);
  });

  it("should include error breakdown in summaries", async () => {
    const kv = createMockKV();

    await writeMetric(kv, makeRecord({ status: 200 }));
    await writeMetric(
      kv,
      makeRecord({ status: 502, error_code: "upstream_error" }),
    );
    await writeMetric(
      kv,
      makeRecord({ status: 400, error_code: "invalid_token" }),
    );

    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(authedRequest("http://localhost/stats"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.today.success_count).toBe(1);
    expect(body.today.error_count).toBe(2);
    expect(body.today.error_breakdown).toEqual({
      upstream_error: 1,
      invalid_token: 1,
    });
  });

  it("should include model breakdown in summaries", async () => {
    const kv = createMockKV();

    await writeMetric(kv, makeRecord({ model: "gpt-4o-mini", ecash_in: 100 }));
    await writeMetric(kv, makeRecord({ model: "gpt-4o-mini", ecash_in: 150 }));
    await writeMetric(kv, makeRecord({ model: "claude-3-opus", ecash_in: 500 }));

    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(authedRequest("http://localhost/stats"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.today.model_breakdown["gpt-4o-mini"]).toEqual({
      count: 2,
      ecash_in: 250,
      errors: 0,
    });
    expect(body.today.model_breakdown["claude-3-opus"]).toEqual({
      count: 1,
      ecash_in: 500,
      errors: 0,
    });
  });

  it("should return empty summaries when no metrics exist", async () => {
    const kv = createMockKV();
    const app = createGateApp(makeConfig(kv));
    const res = await app.fetch(authedRequest("http://localhost/stats"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.today.total_requests).toBe(0);
    expect(body.today.success_count).toBe(0);
    expect(body.today.error_count).toBe(0);
    expect(body.last_7_days.total_requests).toBe(0);
  });
});
