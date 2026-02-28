/**
 * metrics.ts — Metrics recording and querying for Gate monitoring.
 *
 * Each request writes a MetricsRecord to KV with key format:
 *   metrics:{YYYY-MM-DD}:{unix_ms}:{random}
 *
 * To respect CF free tier KV limits (1000 writes/day), we batch
 * metrics into per-minute aggregation buckets when volume is high.
 */
import type { KVNamespace } from "./lib/kv.js";

// ── Types ───────────────────────────────────────────────────────

export interface MetricsRecord {
  ts: number;           // unix ms
  model: string;
  status: number;       // HTTP status code
  ecash_in: number;     // units received (stamp.amount) — 1 USD = 100,000 units
  price: number;        // units charged (pricing rule)
  change: number;       // units returned as change
  refunded: boolean;    // whether X-Cashu-Refund was sent
  upstream_ms: number;  // upstream latency
  error_code?: string;  // error classification
  mint: string;         // which mint the token came from
  stream: boolean;      // was it a streaming request
}

export interface MetricsSummary {
  from: string;
  to: string;
  total_requests: number;
  success_count: number;
  error_count: number;
  ecash_received: number;
  estimated_cost: number;
  error_breakdown: Record<string, number>;
  model_breakdown: Record<string, { count: number; ecash_in: number; errors: number }>;
  avg_latency_ms: number;
}

// ── Write ───────────────────────────────────────────────────────

/**
 * Write a single metrics record to KV.
 * Returns a Promise (caller should use waitUntil to avoid blocking).
 */
export async function writeMetric(
  kv: KVNamespace,
  record: MetricsRecord,
): Promise<void> {
  const date = new Date(record.ts).toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `metrics:${date}:${record.ts}:${rand}`;
  await kv.put(key, JSON.stringify(record), {
    // Auto-expire after 90 days to avoid unbounded growth
    expirationTtl: 90 * 24 * 60 * 60,
  });
}

// ── Read ────────────────────────────────────────────────────────

/**
 * List all metrics records for a given date (YYYY-MM-DD).
 */
export async function getMetricsByDate(
  kv: KVNamespace,
  date: string,
): Promise<MetricsRecord[]> {
  const prefix = `metrics:${date}:`;
  const allKeys: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ prefix, cursor, limit: 1000 });
    for (const key of result.keys) {
      allKeys.push(key.name);
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  // Parallel KV gets in batches of 50 to respect CF concurrency limits
  const BATCH_SIZE = 50;
  const records: MetricsRecord[] = [];

  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    const batch = allKeys.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((key) => kv.get(key)));
    for (const raw of results) {
      if (raw) {
        try {
          records.push(JSON.parse(raw) as MetricsRecord);
        } catch {
          // skip malformed entries
        }
      }
    }
  }

  return records.sort((a, b) => a.ts - b.ts);
}

/**
 * Get only error records for a given date.
 */
export async function getErrorsByDate(
  kv: KVNamespace,
  date: string,
): Promise<MetricsRecord[]> {
  const all = await getMetricsByDate(kv, date);
  return all.filter((r) => !!r.error_code);
}

/**
 * Compute summary statistics for a date range (inclusive).
 */
export async function computeSummary(
  kv: KVNamespace,
  from: string,
  to: string,
): Promise<MetricsSummary> {
  // Collect all dates in range
  const dates: string[] = [];
  const startDate = new Date(from + "T00:00:00Z");
  const endDate = new Date(to + "T00:00:00Z");

  for (
    let d = new Date(startDate);
    d <= endDate;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    dates.push(d.toISOString().slice(0, 10));
  }

  // Parallel fetch all days
  const perDay = await Promise.all(
    dates.map((dateStr) => getMetricsByDate(kv, dateStr)),
  );
  const allRecords: MetricsRecord[] = perDay.flat();

  return summarizeRecords(allRecords, from, to);
}

/**
 * Pure function to summarize an array of metrics records.
 */
export function summarizeRecords(
  records: MetricsRecord[],
  from: string,
  to: string,
): MetricsSummary {
  const summary: MetricsSummary = {
    from,
    to,
    total_requests: records.length,
    success_count: 0,
    error_count: 0,
    ecash_received: 0,
    estimated_cost: 0,
    error_breakdown: {},
    model_breakdown: {},
    avg_latency_ms: 0,
  };

  if (records.length === 0) return summary;

  let totalLatency = 0;

  for (const r of records) {
    if (r.error_code) {
      summary.error_count++;
      summary.error_breakdown[r.error_code] =
        (summary.error_breakdown[r.error_code] ?? 0) + 1;
    } else {
      summary.success_count++;
    }

    summary.ecash_received += r.ecash_in;
    totalLatency += r.upstream_ms;

    // Model breakdown
    if (!summary.model_breakdown[r.model]) {
      summary.model_breakdown[r.model] = { count: 0, ecash_in: 0, errors: 0 };
    }
    const mb = summary.model_breakdown[r.model];
    mb.count++;
    mb.ecash_in += r.ecash_in;
    if (r.error_code) mb.errors++;
  }

  summary.avg_latency_ms = Math.round(totalLatency / records.length);

  // Rough cost estimate: use price field sum as cost proxy
  // (price = what we charged, which should cover upstream cost)
  summary.estimated_cost = records
    .filter((r) => !r.error_code)
    .reduce((sum, r) => sum + r.price, 0);

  return summary;
}
