import { describe, it, expect } from "vitest";
import { writeMetric, type MetricsRecord } from "../metrics.js";
import { generateDailyReport, formatReport } from "../daily-report.js";
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

describe("formatReport (pure)", () => {
  it("should handle empty records", () => {
    const report = formatReport([], "2026-02-03");
    expect(report).toContain("# 📊 Gate Daily Report — 2026-02-03");
    expect(report).toContain("No requests recorded");
  });

  it("should include overview section with correct stats", () => {
    const records = [
      makeRecord({ ecash_in: 300, price: 200 }),
      makeRecord({ ecash_in: 500, price: 200, ts: Date.UTC(2026, 1, 3, 11, 0, 0) }),
      makeRecord({
        ecash_in: 0, price: 0, status: 402,
        error_code: "payment_required",
        ts: Date.UTC(2026, 1, 3, 12, 0, 0),
      }),
    ];
    const report = formatReport(records, "2026-02-03");

    expect(report).toContain("## 📈 Overview");
    expect(report).toContain("| Total Requests | 3 |");
    expect(report).toContain("| Successful | 2 |");
    expect(report).toContain("| Errors | 1 |");
    expect(report).toContain("66.7%");
  });

  it("should include revenue section", () => {
    const records = [
      makeRecord({ ecash_in: 300, price: 200 }),
    ];
    const report = formatReport(records, "2026-02-03");

    expect(report).toContain("## 💰 Revenue");
    expect(report).toContain("| Ecash Received | 300 |");
    expect(report).toContain("| Estimated Cost | 200 |");
    expect(report).toContain("| Profit | 100 |");
  });

  it("should include model breakdown", () => {
    const records = [
      makeRecord({ model: "gpt-4o-mini", ecash_in: 300 }),
      makeRecord({ model: "gpt-4o", ecash_in: 2000, ts: Date.UTC(2026, 1, 3, 11, 0, 0) }),
    ];
    const report = formatReport(records, "2026-02-03");

    expect(report).toContain("## 🤖 Model Usage");
    expect(report).toContain("gpt-4o-mini");
    expect(report).toContain("gpt-4o");
  });

  it("should include error breakdown when errors exist", () => {
    const records = [
      makeRecord({ status: 500, error_code: "redeem_failed" }),
      makeRecord({ status: 500, error_code: "redeem_failed", ts: Date.UTC(2026, 1, 3, 11, 0, 0) }),
      makeRecord({ status: 502, error_code: "upstream_error", ts: Date.UTC(2026, 1, 3, 12, 0, 0) }),
    ];
    const report = formatReport(records, "2026-02-03");

    expect(report).toContain("## ❌ Error Breakdown");
    expect(report).toContain("| redeem_failed | 2 |");
    expect(report).toContain("| upstream_error | 1 |");
  });

  it("should include hourly distribution", () => {
    const records = [
      makeRecord({ ts: Date.UTC(2026, 1, 3, 10, 0, 0) }),
      makeRecord({ ts: Date.UTC(2026, 1, 3, 10, 30, 0) }),
      makeRecord({ ts: Date.UTC(2026, 1, 3, 14, 0, 0) }),
    ];
    const report = formatReport(records, "2026-02-03");

    expect(report).toContain("## 🕐 Hourly Distribution");
    expect(report).toContain("`10:00`");
    expect(report).toContain("`14:00`");
  });

  it("should include mint information", () => {
    const records = [
      makeRecord({ mint: "https://mint.example.com" }),
    ];
    const report = formatReport(records, "2026-02-03");

    expect(report).toContain("## 🏦 Mints");
    expect(report).toContain("https://mint.example.com: 1 requests");
  });
});

describe("generateDailyReport (with KV)", () => {
  it("should generate report from KV data", async () => {
    const kv = createMockKV();
    await writeMetric(kv, makeRecord({ ecash_in: 300, price: 200 }));
    await writeMetric(kv, makeRecord({
      ts: Date.UTC(2026, 1, 3, 11, 0, 0),
      ecash_in: 500,
      price: 200,
      model: "gpt-4o",
    }));

    const report = await generateDailyReport(kv, "2026-02-03");
    expect(report).toContain("# 📊 Gate Daily Report — 2026-02-03");
    expect(report).toContain("| Total Requests | 2 |");
    expect(report).toContain("| Ecash Received | 800 |");
  });

  it("should handle date with no data", async () => {
    const kv = createMockKV();
    const report = await generateDailyReport(kv, "2026-02-03");
    expect(report).toContain("No requests recorded");
  });
});
