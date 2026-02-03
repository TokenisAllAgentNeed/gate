/**
 * Tests for pricing-config.ts — loadPricing() and mergePricing().
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { loadPricing, mergePricing, PRICING } from "../pricing-config.js";
import type { PricingRule } from "../lib/types.js";

describe("PRICING defaults", () => {
  test("exports a non-empty array of PricingRule", () => {
    expect(Array.isArray(PRICING)).toBe(true);
    expect(PRICING.length).toBeGreaterThan(0);
  });

  test("all default rules are per_token mode", () => {
    for (const rule of PRICING) {
      expect(rule.mode).toBe("per_token");
    }
  });

  test("includes a wildcard catch-all rule", () => {
    expect(PRICING.some((r) => r.model === "*")).toBe(true);
  });
});

describe("loadPricing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("returns defaults when called with undefined", () => {
    expect(loadPricing(undefined)).toBe(PRICING);
  });

  test("returns defaults when called with null", () => {
    expect(loadPricing(null)).toBe(PRICING);
  });

  test("returns defaults when called with empty string", () => {
    expect(loadPricing("")).toBe(PRICING);
  });

  test("returns defaults when called with whitespace-only string", () => {
    expect(loadPricing("   ")).toBe(PRICING);
  });

  test("parses valid JSON array of PricingRule", () => {
    const custom: PricingRule[] = [
      { model: "custom/model", mode: "per_token", input_per_million: 1000, output_per_million: 2000 },
    ];
    const result = loadPricing(JSON.stringify(custom));
    expect(result).toEqual(custom);
  });

  test("returns defaults for invalid JSON and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadPricing("{not valid json");
    expect(result).toBe(PRICING);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse PRICING_JSON")
    );
  });

  test("returns defaults when JSON is an empty array and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadPricing("[]");
    expect(result).toBe(PRICING);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("PRICING_JSON is not a non-empty array")
    );
  });

  test("returns defaults when JSON is not an array and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = loadPricing('{"model": "x"}');
    expect(result).toBe(PRICING);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("PRICING_JSON is not a non-empty array")
    );
  });
});

describe("mergePricing", () => {
  test("returns custom rules + non-overlapping OpenRouter rules", () => {
    const openRouter: PricingRule[] = [
      { model: "openai/gpt-4o", mode: "per_token", input_per_million: 250000, output_per_million: 1000000 },
      { model: "anthropic/claude-3-opus", mode: "per_token", input_per_million: 1500000, output_per_million: 7500000 },
    ];
    const custom: PricingRule[] = [
      { model: "openai/gpt-4o", mode: "per_token", input_per_million: 200000, output_per_million: 800000 },
    ];

    const merged = mergePricing(openRouter, custom);
    expect(merged).toHaveLength(2);
    // Custom rule takes precedence
    expect(merged[0]).toBe(custom[0]);
    // Non-overlapping OpenRouter rule is included
    expect(merged[1]).toBe(openRouter[1]);
  });

  test("returns only custom rules when all models overlap", () => {
    const openRouter: PricingRule[] = [
      { model: "model-a", mode: "per_token", input_per_million: 100, output_per_million: 200 },
    ];
    const custom: PricingRule[] = [
      { model: "model-a", mode: "per_token", input_per_million: 50, output_per_million: 100 },
    ];

    const merged = mergePricing(openRouter, custom);
    expect(merged).toHaveLength(1);
    expect(merged[0].input_per_million).toBe(50);
  });

  test("returns all rules when no overlap", () => {
    const openRouter: PricingRule[] = [
      { model: "or-model", mode: "per_token", input_per_million: 100, output_per_million: 200 },
    ];
    const custom: PricingRule[] = [
      { model: "custom-model", mode: "per_token", input_per_million: 50, output_per_million: 100 },
    ];

    const merged = mergePricing(openRouter, custom);
    expect(merged).toHaveLength(2);
    expect(merged[0].model).toBe("custom-model");
    expect(merged[1].model).toBe("or-model");
  });

  test("handles empty OpenRouter rules", () => {
    const custom: PricingRule[] = [
      { model: "x", mode: "per_token", input_per_million: 1, output_per_million: 2 },
    ];
    const merged = mergePricing([], custom);
    expect(merged).toEqual(custom);
  });

  test("handles empty custom rules", () => {
    const openRouter: PricingRule[] = [
      { model: "y", mode: "per_token", input_per_million: 1, output_per_million: 2 },
    ];
    const merged = mergePricing(openRouter, []);
    expect(merged).toEqual(openRouter);
  });
});
