/**
 * Pricing tests for per-token billing mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPrice, validateAmount, estimateMaxCost, calculateActualCost } from "../lib/pricing.js";
import type { PricingRule } from "../lib/types.js";

describe("getPrice", () => {
  const rules: PricingRule[] = [
    { model: "gpt-4o-mini", mode: "per_token", input_per_million: 15000, output_per_million: 60000 },
    { model: "claude-sonnet-4-20250514", mode: "per_token", input_per_million: 300000, output_per_million: 1500000 },
    { model: "legacy-model", mode: "per_request", per_request: 500 },
    { model: "*", mode: "per_token", input_per_million: 100000, output_per_million: 500000 },
  ];

  it("should find exact match", () => {
    const rule = getPrice("gpt-4o-mini", rules);
    expect(rule).toBeDefined();
    expect(rule!.model).toBe("gpt-4o-mini");
    expect(rule!.input_per_million).toBe(15000);
  });

  it("should fall back to wildcard when no exact match", () => {
    const rule = getPrice("unknown-model", rules);
    expect(rule).toBeDefined();
    expect(rule!.model).toBe("unknown-model"); // Wildcard inherits requested model name
    expect(rule!.input_per_million).toBe(100000);
  });

  it("should return null when no wildcard and no match", () => {
    const noWildcard: PricingRule[] = [
      { model: "gpt-4o-mini", mode: "per_token", input_per_million: 15000, output_per_million: 60000 },
    ];
    const rule = getPrice("unknown-model", noWildcard);
    expect(rule).toBeNull();
  });
});

describe("estimateMaxCost", () => {
  it("should estimate cost based on input tokens + max_tokens", () => {
    const rule: PricingRule = {
      model: "gpt-4o-mini",
      mode: "per_token",
      input_per_million: 15000,  // 0.15 USD = 15000 units per 1M
      output_per_million: 60000, // 0.60 USD = 60000 units per 1M
    };

    // 1000 input tokens + 500 max output tokens
    // Input: 1000 / 1M * 15000 = 15 units
    // Output: 500 / 1M * 60000 = 30 units
    // Total = 45 units
    const cost = estimateMaxCost(rule, 1000, 500);
    expect(cost).toBe(45);
  });

  it("should handle large token counts", () => {
    const rule: PricingRule = {
      model: "claude-opus-4-20250514",
      mode: "per_token",
      input_per_million: 1500000,  // $15/1M = 1500000 units/1M
      output_per_million: 7500000, // $75/1M = 7500000 units/1M
    };

    // 10000 input + 4096 max output
    // Input: 10000 / 1M * 1500000 = 15000 units
    // Output: 4096 / 1M * 7500000 = 30720 units
    // Total = 45720
    const cost = estimateMaxCost(rule, 10000, 4096);
    expect(cost).toBe(45720);
  });

  it("should use default max_tokens when not specified", () => {
    const rule: PricingRule = {
      model: "gpt-4o-mini",
      mode: "per_token",
      input_per_million: 15000,
      output_per_million: 60000,
    };

    // With default max_tokens of 4096
    // Input: 1000 / 1M * 15000 = 15
    // Output: 4096 / 1M * 60000 = 245.76
    // Total = 260.76 → ceil to 261
    const cost = estimateMaxCost(rule, 1000);
    expect(cost).toBe(261);
  });

  it("should throw for per_request mode", () => {
    const rule: PricingRule = {
      model: "legacy",
      mode: "per_request",
      per_request: 500,
    };
    expect(() => estimateMaxCost(rule, 1000, 500)).toThrow(/per_token/);
  });
});

describe("calculateActualCost", () => {
  it("should calculate cost based on actual usage", () => {
    const rule: PricingRule = {
      model: "gpt-4o-mini",
      mode: "per_token",
      input_per_million: 15000,
      output_per_million: 60000,
    };

    const usage = { prompt_tokens: 100, completion_tokens: 50 };
    // Input: 100 / 1M * 15000 = 1.5
    // Output: 50 / 1M * 60000 = 3
    // Total = 4.5 → ceil to 5 units
    const cost = calculateActualCost(rule, usage);
    expect(cost).toBe(5);
  });

  it("should calculate larger amounts correctly", () => {
    const rule: PricingRule = {
      model: "claude-opus-4-20250514",
      mode: "per_token",
      input_per_million: 1500000,
      output_per_million: 7500000,
    };

    const usage = { prompt_tokens: 5000, completion_tokens: 2000 };
    // Input: 5000 / 1M * 1500000 = 7500
    // Output: 2000 / 1M * 7500000 = 15000
    // Total = 22500
    const cost = calculateActualCost(rule, usage);
    expect(cost).toBe(22500);
  });

  it("should handle zero completion tokens", () => {
    const rule: PricingRule = {
      model: "gpt-4o-mini",
      mode: "per_token",
      input_per_million: 15000,
      output_per_million: 60000,
    };

    const usage = { prompt_tokens: 10000, completion_tokens: 0 };
    // Input: 10000 / 1M * 15000 = 150 units
    const cost = calculateActualCost(rule, usage);
    expect(cost).toBe(150);
  });
});

describe("validateAmount for per_token mode", () => {
  it("should validate against estimated max cost", () => {
    const rule: PricingRule = {
      model: "gpt-4o-mini",
      mode: "per_token",
      input_per_million: 15000,
      output_per_million: 60000,
    };

    // Estimate for 1000 input + 500 max output = 45 units
    const validation = validateAmount(
      { amount: 50 },
      rule,
      { inputTokens: 1000, maxOutputTokens: 500 }
    );

    expect(validation.ok).toBe(true);
    expect(validation.required).toBe(45);
    expect(validation.provided).toBe(50);
  });

  it("should fail when amount is insufficient", () => {
    const rule: PricingRule = {
      model: "claude-opus-4-20250514",
      mode: "per_token",
      input_per_million: 1500000,
      output_per_million: 7500000,
    };

    // 10000 input + 4096 output = 45720 units required
    const validation = validateAmount(
      { amount: 100 },
      rule,
      { inputTokens: 10000, maxOutputTokens: 4096 }
    );

    expect(validation.ok).toBe(false);
    expect(validation.required).toBe(45720);
    expect(validation.provided).toBe(100);
  });
});

describe("validateAmount for per_request mode (deprecated)", () => {
  it("should still work for per_request mode", () => {
    const rule: PricingRule = {
      model: "legacy",
      mode: "per_request",
      per_request: 500,
    };
    
    const validation = validateAmount({ amount: 500 }, rule);
    expect(validation.ok).toBe(true);
    expect(validation.required).toBe(500);
  });

  it("should fail when amount is less than per_request", () => {
    const rule: PricingRule = {
      model: "legacy",
      mode: "per_request",
      per_request: 500,
    };
    
    const validation = validateAmount({ amount: 100 }, rule);
    expect(validation.ok).toBe(false);
    expect(validation.required).toBe(500);
  });
});
