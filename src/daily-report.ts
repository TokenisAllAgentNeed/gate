/**
 * daily-report.ts — Generate a daily markdown summary from metrics.
 *
 * Export a single function for external cron to call.
 */
import type { KVNamespace } from "./lib/kv.js";
import { getMetricsByDate, summarizeRecords, type MetricsRecord } from "./metrics.js";

/**
 * Generate a markdown daily report for the given date.
 *
 * @param kv - KV namespace with metrics data
 * @param date - Date string in YYYY-MM-DD format
 * @returns Markdown-formatted report string
 */
export async function generateDailyReport(
  kv: KVNamespace,
  date: string,
): Promise<string> {
  const records = await getMetricsByDate(kv, date);
  return formatReport(records, date);
}

/**
 * Pure function to format a report from records.
 * Exported for testing.
 */
export function formatReport(records: MetricsRecord[], date: string): string {
  const summary = summarizeRecords(records, date, date);
  const lines: string[] = [];

  lines.push(`# 📊 Gate Daily Report — ${date}`);
  lines.push("");

  if (records.length === 0) {
    lines.push("No requests recorded for this date.");
    return lines.join("\n");
  }

  // ── Overview
  const rate =
    summary.total_requests > 0
      ? ((summary.success_count / summary.total_requests) * 100).toFixed(1)
      : "0.0";
  const profit = summary.ecash_received - summary.estimated_cost;

  lines.push("## 📈 Overview");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Requests | ${summary.total_requests} |`);
  lines.push(`| Successful | ${summary.success_count} |`);
  lines.push(`| Errors | ${summary.error_count} |`);
  lines.push(`| Success Rate | ${rate}% |`);
  lines.push(`| Avg Latency | ${summary.avg_latency_ms}ms |`);
  lines.push("");

  // ── Revenue
  lines.push("## 💰 Revenue");
  lines.push("");
  lines.push(`| Metric | Sats |`);
  lines.push(`|--------|------|`);
  lines.push(`| Ecash Received | ${summary.ecash_received} |`);
  lines.push(`| Estimated Cost | ${summary.estimated_cost} |`);
  lines.push(`| Profit | ${profit} |`);
  lines.push("");

  // ── Model Breakdown
  if (Object.keys(summary.model_breakdown).length > 0) {
    lines.push("## 🤖 Model Usage");
    lines.push("");
    lines.push("| Model | Requests | Revenue (sats) | Errors |");
    lines.push("|-------|----------|----------------|--------|");
    for (const [model, data] of Object.entries(summary.model_breakdown)) {
      lines.push(`| ${model} | ${data.count} | ${data.ecash_in} | ${data.errors} |`);
    }
    lines.push("");
  }

  // ── Error Breakdown
  if (Object.keys(summary.error_breakdown).length > 0) {
    lines.push("## ❌ Error Breakdown");
    lines.push("");
    lines.push("| Error Code | Count |");
    lines.push("|------------|-------|");
    for (const [code, count] of Object.entries(summary.error_breakdown)) {
      lines.push(`| ${code} | ${count} |`);
    }
    lines.push("");
  }

  // ── Hourly distribution
  const hourBuckets = new Map<number, number>();
  for (const r of records) {
    const hour = new Date(r.ts).getUTCHours();
    hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
  }
  if (hourBuckets.size > 0) {
    lines.push("## 🕐 Hourly Distribution (UTC)");
    lines.push("");
    const maxCount = Math.max(...hourBuckets.values());
    for (let h = 0; h < 24; h++) {
      const count = hourBuckets.get(h) ?? 0;
      if (count === 0) continue;
      const bar = "█".repeat(Math.ceil((count / maxCount) * 20));
      lines.push(`\`${String(h).padStart(2, "0")}:00\` ${bar} ${count}`);
    }
    lines.push("");
  }

  // ── Top mints
  const mintCounts = new Map<string, number>();
  for (const r of records) {
    if (r.mint) mintCounts.set(r.mint, (mintCounts.get(r.mint) ?? 0) + 1);
  }
  if (mintCounts.size > 0) {
    lines.push("## 🏦 Mints");
    lines.push("");
    for (const [mint, count] of mintCounts.entries()) {
      lines.push(`- ${mint}: ${count} requests`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Generated at ${new Date().toISOString()}*`);

  return lines.join("\n");
}
