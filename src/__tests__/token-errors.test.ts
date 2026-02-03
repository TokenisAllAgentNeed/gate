/**
 * Unit tests for token-errors.ts — writeTokenError, getTokenErrorsByDate,
 * getRecentTokenErrors, getTokenErrorSummary.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  writeTokenError,
  getTokenErrorsByDate,
  getRecentTokenErrors,
  getTokenErrorSummary,
} from "../token-errors.js";
import type { DecodeDiagnostics } from "../lib/decode.js";
import { createMockKV } from "./helpers.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeDiagnostics(overrides?: Partial<DecodeDiagnostics>): DecodeDiagnostics {
  return {
    tokenVersion: "V4",
    rawPrefix: "cashuBtest",
    decodeTimeMs: 5,
    proofCount: 0,
    error: "CBOR decode error",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("writeTokenError", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("writes with correct key format: token_error:{date}:{ts}:{rand}", async () => {
    await writeTokenError(kv, makeDiagnostics(), "cashuBtoken123");

    const keys = await kv.list({ prefix: "token_error:" });
    expect(keys.keys).toHaveLength(1);

    const keyName = keys.keys[0].name;
    const parts = keyName.split(":");
    expect(parts[0]).toBe("token_error");
    // parts[1] = date YYYY-MM-DD
    expect(parts[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // parts[2] = timestamp
    expect(Number(parts[2])).toBeGreaterThan(0);
    // parts[3] = random
    expect(parts[3].length).toBeGreaterThan(0);
  });

  it("truncates token longer than 2000 chars", async () => {
    const longToken = "x".repeat(3000);
    await writeTokenError(kv, makeDiagnostics(), longToken);

    const keys = await kv.list({ prefix: "token_error:" });
    const raw = await kv.get(keys.keys[0].name);
    const record = JSON.parse(raw!);
    expect(record.rawToken.length).toBeLessThan(3000);
    expect(record.rawToken).toContain("...[truncated]");
  });

  it("stores short token without truncation", async () => {
    await writeTokenError(kv, makeDiagnostics(), "short_token");

    const keys = await kv.list({ prefix: "token_error:" });
    const raw = await kv.get(keys.keys[0].name);
    const record = JSON.parse(raw!);
    expect(record.rawToken).toBe("short_token");
  });

  it("includes metadata (ipHash, userAgent)", async () => {
    await writeTokenError(kv, makeDiagnostics(), "token", {
      ipHash: "abc123",
      userAgent: "TestBot/1.0",
    });

    const keys = await kv.list({ prefix: "token_error:" });
    const raw = await kv.get(keys.keys[0].name);
    const record = JSON.parse(raw!);
    expect(record.ipHash).toBe("abc123");
    expect(record.userAgent).toBe("TestBot/1.0");
  });

  it("stores correct fields from diagnostics", async () => {
    const diag = makeDiagnostics({
      tokenVersion: "V3",
      error: "Base64 decode error",
      rawPrefix: "cashuAabc",
      decodeTimeMs: 12,
      rawCborStructure: "{cbor}",
    });
    await writeTokenError(kv, diag, "token123");

    const keys = await kv.list({ prefix: "token_error:" });
    const raw = await kv.get(keys.keys[0].name);
    const record = JSON.parse(raw!);
    expect(record.tokenVersion).toBe("V3");
    expect(record.error).toBe("Base64 decode error");
    expect(record.rawPrefix).toBe("cashuAabc");
    expect(record.decodeTimeMs).toBe(12);
    expect(record.rawCborStructure).toBe("{cbor}");
  });
});

describe("getTokenErrorsByDate", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("returns empty array when no errors exist", async () => {
    const errors = await getTokenErrorsByDate(kv, "2026-01-01");
    expect(errors).toEqual([]);
  });

  it("returns errors for the specified date only", async () => {
    // Write errors for two different dates
    const today = new Date().toISOString().slice(0, 10);
    await writeTokenError(kv, makeDiagnostics(), "token1");

    // Manually write an error for a different date
    const otherDate = "2020-01-01";
    const record = {
      ts: Date.now(),
      tokenVersion: "V4",
      error: "test",
      rawPrefix: "cashu",
      rawToken: "tok",
      decodeTimeMs: 1,
    };
    await kv.put(`token_error:${otherDate}:123:abc`, JSON.stringify(record));

    const todayErrors = await getTokenErrorsByDate(kv, today);
    expect(todayErrors).toHaveLength(1);

    const otherErrors = await getTokenErrorsByDate(kv, otherDate);
    expect(otherErrors).toHaveLength(1);
  });

  it("returns errors sorted by timestamp descending (newest first)", async () => {
    const date = "2026-02-01";
    const older = { ts: 1000, tokenVersion: "V4", error: "e1", rawPrefix: "a", decodeTimeMs: 1 };
    const newer = { ts: 2000, tokenVersion: "V4", error: "e2", rawPrefix: "b", decodeTimeMs: 1 };
    await kv.put(`token_error:${date}:1000:aaa`, JSON.stringify(older));
    await kv.put(`token_error:${date}:2000:bbb`, JSON.stringify(newer));

    const errors = await getTokenErrorsByDate(kv, date);
    expect(errors).toHaveLength(2);
    expect(errors[0].ts).toBe(2000);
    expect(errors[1].ts).toBe(1000);
  });

  it("skips malformed JSON entries without throwing", async () => {
    const date = "2026-02-01";
    const validRecord = { ts: 1000, tokenVersion: "V4", error: "valid", rawPrefix: "a", decodeTimeMs: 1 };
    
    // Write one valid and one malformed entry
    await kv.put(`token_error:${date}:1000:aaa`, JSON.stringify(validRecord));
    await kv.put(`token_error:${date}:2000:bbb`, "not valid json {{{");
    
    // Should return only the valid entry, silently skipping malformed
    const errors = await getTokenErrorsByDate(kv, date);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("valid");
  });
});

describe("getRecentTokenErrors", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("combines today and yesterday errors", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const rec1 = { ts: Date.now(), tokenVersion: "V4", error: "e1", rawPrefix: "a", decodeTimeMs: 1 };
    const rec2 = { ts: Date.now() - 100000, tokenVersion: "V3", error: "e2", rawPrefix: "b", decodeTimeMs: 2 };

    await kv.put(`token_error:${today}:${rec1.ts}:aaa`, JSON.stringify(rec1));
    await kv.put(`token_error:${yesterday}:${rec2.ts}:bbb`, JSON.stringify(rec2));

    const errors = await getRecentTokenErrors(kv);
    expect(errors).toHaveLength(2);
    // Should be sorted newest first
    expect(errors[0].ts).toBeGreaterThanOrEqual(errors[1].ts);
  });

  it("respects limit parameter", async () => {
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 5; i++) {
      const rec = { ts: Date.now() + i, tokenVersion: "V4", error: `e${i}`, rawPrefix: "a", decodeTimeMs: 1 };
      await kv.put(`token_error:${today}:${rec.ts}:${i}aa`, JSON.stringify(rec));
    }

    const errors = await getRecentTokenErrors(kv, 3);
    expect(errors).toHaveLength(3);
  });
});

describe("getTokenErrorSummary", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  it("returns correct version counts", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ts = Date.now();

    const rec1 = { ts, tokenVersion: "V3", error: "CBOR err", rawPrefix: "a", decodeTimeMs: 1 };
    const rec2 = { ts: ts + 1, tokenVersion: "V4", error: "Base64 err", rawPrefix: "b", decodeTimeMs: 2 };
    const rec3 = { ts: ts + 2, tokenVersion: "V4", error: "CBOR err", rawPrefix: "c", decodeTimeMs: 3 };

    await kv.put(`token_error:${today}:${ts}:aaa`, JSON.stringify(rec1));
    await kv.put(`token_error:${today}:${ts + 1}:bbb`, JSON.stringify(rec2));
    await kv.put(`token_error:${today}:${ts + 2}:ccc`, JSON.stringify(rec3));

    const summary = await getTokenErrorSummary(kv);
    expect(summary.totalErrors).toBe(3);
    expect(summary.byVersion["V3"]).toBe(1);
    expect(summary.byVersion["V4"]).toBe(2);
  });

  it("returns correct error type counts", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ts = Date.now();

    const rec1 = { ts, tokenVersion: "V4", error: "CBOR decode failed", rawPrefix: "a", decodeTimeMs: 1 };
    const rec2 = { ts: ts + 1, tokenVersion: "V4", error: "Base64 decode failed", rawPrefix: "b", decodeTimeMs: 1 };
    const rec3 = { ts: ts + 2, tokenVersion: "V4", error: "CBOR another issue", rawPrefix: "c", decodeTimeMs: 1 };

    await kv.put(`token_error:${today}:${ts}:aaa`, JSON.stringify(rec1));
    await kv.put(`token_error:${today}:${ts + 1}:bbb`, JSON.stringify(rec2));
    await kv.put(`token_error:${today}:${ts + 2}:ccc`, JSON.stringify(rec3));

    const summary = await getTokenErrorSummary(kv);
    expect(summary.byError["CBOR decode"]).toBe(2);
    expect(summary.byError["Base64 decode"]).toBe(1);
  });

  it("returns correct 24h count", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    // Recent record (within 24h)
    const rec1 = { ts: now - 1000, tokenVersion: "V4", error: "err", rawPrefix: "a", decodeTimeMs: 1 };
    // Old record (outside 24h) — use 23h for date key so it always lands on
    // today or yesterday (never 2+ days ago near UTC midnight), and 25h for ts
    // so the record's timestamp is reliably outside the 24h recentCount window.
    const yesterday = new Date(now - 23 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rec2 = { ts: now - 25 * 60 * 60 * 1000, tokenVersion: "V4", error: "err", rawPrefix: "b", decodeTimeMs: 1 };

    await kv.put(`token_error:${today}:${rec1.ts}:aaa`, JSON.stringify(rec1));
    await kv.put(`token_error:${yesterday}:${rec2.ts}:bbb`, JSON.stringify(rec2));

    const summary = await getTokenErrorSummary(kv);
    expect(summary.totalErrors).toBe(2);
    expect(summary.recentCount24h).toBe(1);
  });

  it("returns zero counts when no errors exist", async () => {
    const summary = await getTokenErrorSummary(kv);
    expect(summary.totalErrors).toBe(0);
    expect(summary.recentCount24h).toBe(0);
    expect(summary.byVersion).toEqual({});
    expect(summary.byError).toEqual({});
  });
});
