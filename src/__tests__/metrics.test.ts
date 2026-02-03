import { describe, it, expect } from "vitest";
import {
  writeMetric,
  getMetricsByDate,
  getErrorsByDate,
  computeSummary,
  summarizeRecords,
  type MetricsRecord,
} from "../metrics.js";
import { createMockKV } from "./helpers.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeRecord(overrides: Partial<MetricsRecord> = {}): MetricsRecord {
  return {
    ts: Date.UTC(2026, 1, 3, 10, 0, 0), // 2026-02-03T10:00:00Z
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

// ── writeMetric ─────────────────────────────────────────────────

describe("writeMetric", () => {
  it("should write a record with correct key prefix", async () => {
    const kv = createMockKV();
    const record = makeRecord();
    await writeMetric(kv, record);

    const keys = [...kv._store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^metrics:2026-02-03:\d+:/);

    const stored = JSON.parse(kv._store.get(keys[0])!);
    expect(stored.model).toBe("gpt-4o-mini");
    expect(stored.ecash_in).toBe(300);
  });

  it("should write multiple records with unique keys", async () => {
    const kv = createMockKV();
    await writeMetric(kv, makeRecord());
    await writeMetric(kv, makeRecord({ ts: Date.UTC(2026, 1, 3, 10, 0, 1) }));

    expect(kv._store.size).toBe(2);
  });

  it("should use correct date for key from record timestamp", async () => {
    const kv = createMockKV();
    // Record from Feb 5
    await writeMetric(
      kv,
      makeRecord({ ts: Date.UTC(2026, 1, 5, 15, 30, 0) }),
    );

    const keys = [...kv._store.keys()];
    expect(keys[0]).toMatch(/^metrics:2026-02-05:/);
  });
});

// ── getMetricsByDate ────────────────────────────────────────────

describe("getMetricsByDate", () => {
  it("should return empty array for date with no records", async () => {
    const kv = createMockKV();
    const result = await getMetricsByDate(kv, "2026-02-03");
    expect(result).toEqual([]);
  });

  it("should return all records for given date sorted by ts", async () => {
    const kv = createMockKV();
    const r1 = makeRecord({ ts: Date.UTC(2026, 1, 3, 12, 0, 0), model: "gpt-4o" });
    const r2 = makeRecord({ ts: Date.UTC(2026, 1, 3, 10, 0, 0), model: "gpt-4o-mini" });
    await writeMetric(kv, r1);
    await writeMetric(kv, r2);

    const result = await getMetricsByDate(kv, "2026-02-03");
    expect(result).toHaveLength(2);
    expect(result[0].model).toBe("gpt-4o-mini"); // earlier timestamp first
    expect(result[1].model).toBe("gpt-4o");
  });

  it("should not return records from other dates", async () => {
    const kv = createMockKV();
    await writeMetric(kv, makeRecord({ ts: Date.UTC(2026, 1, 3, 10, 0, 0) }));
    await writeMetric(kv, makeRecord({ ts: Date.UTC(2026, 1, 4, 10, 0, 0) }));

    const result = await getMetricsByDate(kv, "2026-02-03");
    expect(result).toHaveLength(1);
  });
});

// ── getErrorsByDate ─────────────────────────────────────────────

describe("getErrorsByDate", () => {
  it("should return only error records", async () => {
    const kv = createMockKV();
    await writeMetric(kv, makeRecord()); // success
    await writeMetric(
      kv,
      makeRecord({
        ts: Date.UTC(2026, 1, 3, 11, 0, 0),
        status: 402,
        error_code: "payment_required",
      }),
    );
    await writeMetric(
      kv,
      makeRecord({
        ts: Date.UTC(2026, 1, 3, 12, 0, 0),
        status: 500,
        error_code: "redeem_failed",
      }),
    );

    const errors = await getErrorsByDate(kv, "2026-02-03");
    expect(errors).toHaveLength(2);
    expect(errors[0].error_code).toBe("payment_required");
    expect(errors[1].error_code).toBe("redeem_failed");
  });

  it("should return empty array when no errors", async () => {
    const kv = createMockKV();
    await writeMetric(kv, makeRecord());

    const errors = await getErrorsByDate(kv, "2026-02-03");
    expect(errors).toEqual([]);
  });
});

// ── summarizeRecords (pure function) ────────────────────────────

describe("summarizeRecords", () => {
  it("should return zeros for empty records", () => {
    const summary = summarizeRecords([], "2026-02-03", "2026-02-03");
    expect(summary.total_requests).toBe(0);
    expect(summary.success_count).toBe(0);
    expect(summary.error_count).toBe(0);
    expect(summary.ecash_received).toBe(0);
  });

  it("should compute correct counts and sums", () => {
    const records: MetricsRecord[] = [
      makeRecord({ ecash_in: 300, price: 200, upstream_ms: 400 }),
      makeRecord({ ecash_in: 500, price: 200, upstream_ms: 600 }),
      makeRecord({
        ecash_in: 0,
        price: 0,
        upstream_ms: 0,
        status: 402,
        error_code: "payment_required",
      }),
    ];

    const summary = summarizeRecords(records, "2026-02-03", "2026-02-03");
    expect(summary.total_requests).toBe(3);
    expect(summary.success_count).toBe(2);
    expect(summary.error_count).toBe(1);
    expect(summary.ecash_received).toBe(800); // 300 + 500
    expect(summary.estimated_cost).toBe(400); // 200 + 200 (successful only)
    expect(summary.avg_latency_ms).toBe(333); // (400+600+0)/3 rounded
    expect(summary.error_breakdown).toEqual({ payment_required: 1 });
  });

  it("should compute model breakdown correctly", () => {
    const records: MetricsRecord[] = [
      makeRecord({ model: "gpt-4o-mini", ecash_in: 300 }),
      makeRecord({ model: "gpt-4o-mini", ecash_in: 300 }),
      makeRecord({ model: "gpt-4o", ecash_in: 2000 }),
      makeRecord({
        model: "gpt-4o",
        ecash_in: 0,
        error_code: "upstream_error",
      }),
    ];

    const summary = summarizeRecords(records, "2026-02-03", "2026-02-03");
    expect(summary.model_breakdown["gpt-4o-mini"]).toEqual({
      count: 2,
      ecash_in: 600,
      errors: 0,
    });
    expect(summary.model_breakdown["gpt-4o"]).toEqual({
      count: 2,
      ecash_in: 2000,
      errors: 1,
    });
  });
});

// ── computeSummary (integration with KV) ────────────────────────

describe("computeSummary", () => {
  it("should aggregate across multiple dates", async () => {
    const kv = createMockKV();
    await writeMetric(
      kv,
      makeRecord({ ts: Date.UTC(2026, 1, 1, 10, 0, 0), ecash_in: 100 }),
    );
    await writeMetric(
      kv,
      makeRecord({ ts: Date.UTC(2026, 1, 2, 10, 0, 0), ecash_in: 200 }),
    );
    await writeMetric(
      kv,
      makeRecord({ ts: Date.UTC(2026, 1, 3, 10, 0, 0), ecash_in: 300 }),
    );

    const summary = await computeSummary(kv, "2026-02-01", "2026-02-03");
    expect(summary.total_requests).toBe(3);
    expect(summary.ecash_received).toBe(600);
    expect(summary.from).toBe("2026-02-01");
    expect(summary.to).toBe("2026-02-03");
  });

  it("should handle single-day range", async () => {
    const kv = createMockKV();
    await writeMetric(kv, makeRecord());

    const summary = await computeSummary(kv, "2026-02-03", "2026-02-03");
    expect(summary.total_requests).toBe(1);
  });
});
