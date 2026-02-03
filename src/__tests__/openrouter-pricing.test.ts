/**
 * Tests for OpenRouter pricing fetcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchOpenRouterPricing,
  convertToPricingRules,
  getCachedOpenRouterPricing,
  clearPricingCache,
  USD_TO_UNITS,
  type OpenRouterModel,
} from "../openrouter-pricing.js";

describe("USD_TO_UNITS conversion rate", () => {
  it("should be 100000 units per USD", () => {
    expect(USD_TO_UNITS).toBe(100000);
  });
});

describe("convertToPricingRules", () => {
  it("should convert OpenRouter model to PricingRule", () => {
    const models: OpenRouterModel[] = [
      {
        id: "openai/gpt-4o-mini",
        pricing: {
          prompt: "0.00000015",   // $0.15/1M tokens
          completion: "0.0000006", // $0.60/1M tokens
        },
      },
    ];
    
    const rules = convertToPricingRules(models);
    expect(rules).toHaveLength(1);
    
    const rule = rules[0];
    expect(rule.model).toBe("openai/gpt-4o-mini");
    expect(rule.mode).toBe("per_token");
    // $0.15/1M * 100000 units/$ = 15000 units/1M
    expect(rule.input_per_million).toBe(15000);
    // $0.60/1M * 100000 units/$ = 60000 units/1M
    expect(rule.output_per_million).toBe(60000);
  });

  it("should handle expensive models", () => {
    const models: OpenRouterModel[] = [
      {
        id: "anthropic/claude-opus-4-20250514",
        pricing: {
          prompt: "0.000015",    // $15/1M
          completion: "0.000075", // $75/1M
        },
      },
    ];
    
    const rules = convertToPricingRules(models);
    const rule = rules[0];
    
    // $15/1M * 100000 = 1500000 units/1M
    expect(rule.input_per_million).toBe(1500000);
    // $75/1M * 100000 = 7500000 units/1M
    expect(rule.output_per_million).toBe(7500000);
  });

  it("should handle free models (zero pricing)", () => {
    const models: OpenRouterModel[] = [
      {
        id: "meta-llama/llama-3.2-1b-instruct:free",
        pricing: {
          prompt: "0",
          completion: "0",
        },
      },
    ];
    
    const rules = convertToPricingRules(models);
    const rule = rules[0];
    
    expect(rule.input_per_million).toBe(0);
    expect(rule.output_per_million).toBe(0);
  });

  it("should filter out models with missing pricing", () => {
    const models: OpenRouterModel[] = [
      {
        id: "valid-model",
        pricing: { prompt: "0.0001", completion: "0.0002" },
      },
      {
        id: "no-pricing-model",
        // No pricing field
      } as OpenRouterModel,
    ];
    
    const rules = convertToPricingRules(models);
    expect(rules).toHaveLength(1);
    expect(rules[0].model).toBe("valid-model");
  });

  it("should use modelIdTransform when provided", () => {
    const models: OpenRouterModel[] = [
      {
        id: "openai/gpt-4o-mini",
        pricing: { prompt: "0.00000015", completion: "0.0000006" },
      },
    ];
    
    // Transform: remove provider prefix
    const rules = convertToPricingRules(models, {
      modelIdTransform: (id) => id.split("/").pop()!,
    });
    
    expect(rules[0].model).toBe("gpt-4o-mini");
  });

  it("should filter models using modelFilter", () => {
    const models: OpenRouterModel[] = [
      { id: "openai/gpt-4o-mini", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
      { id: "anthropic/claude-3-opus", pricing: { prompt: "0.000015", completion: "0.000075" } },
      { id: "some/other-model", pricing: { prompt: "0.0001", completion: "0.0002" } },
    ];
    
    // Only include OpenAI models
    const rules = convertToPricingRules(models, {
      modelFilter: (id) => id.startsWith("openai/"),
    });
    
    expect(rules).toHaveLength(1);
    expect(rules[0].model).toBe("openai/gpt-4o-mini");
  });
});

describe("fetchOpenRouterPricing", () => {
  const originalFetch = globalThis.fetch;
  
  beforeEach(() => {
    vi.resetAllMocks();
  });
  
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should fetch and convert pricing from OpenRouter API", async () => {
    const mockResponse = {
      data: [
        {
          id: "openai/gpt-4o-mini",
          pricing: { prompt: "0.00000015", completion: "0.0000006" },
        },
        {
          id: "anthropic/claude-sonnet-4-20250514",
          pricing: { prompt: "0.000003", completion: "0.000015" },
        },
      ],
    };
    
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify(mockResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    ));
    
    const rules = await fetchOpenRouterPricing();
    
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ method: "GET" })
    );
    
    expect(rules).toHaveLength(2);
    expect(rules[0].model).toBe("openai/gpt-4o-mini");
    expect(rules[0].input_per_million).toBe(15000);
  });

  it("should throw on fetch failure", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      "Service unavailable",
      { status: 503 }
    ));
    
    await expect(fetchOpenRouterPricing()).rejects.toThrow(/Failed to fetch/);
  });

  it("should throw on invalid JSON response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      "not json",
      { status: 200 }
    ));
    
    await expect(fetchOpenRouterPricing()).rejects.toThrow();
  });
});

describe("getCachedOpenRouterPricing", () => {
  const originalFetch = globalThis.fetch;
  
  beforeEach(() => {
    vi.resetAllMocks();
    clearPricingCache();
  });
  
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearPricingCache();
  });

  it("should cache results and not refetch within TTL", async () => {
    const mockResponse = {
      data: [
        { id: "model-1", pricing: { prompt: "0.0001", completion: "0.0002" } },
      ],
    };
    
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify(mockResponse),
      { status: 200 }
    ));
    
    // First call - should fetch
    const result1 = await getCachedOpenRouterPricing();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    
    // Second call - should use cache
    const result2 = await getCachedOpenRouterPricing();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // Still 1
    expect(result2).toEqual(result1);
  });

  it("should bypass cache when options are provided", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          data: [
            { id: `openai/model-${callCount}`, pricing: { prompt: "0.0001", completion: "0.0002" } },
            { id: `anthropic/model-${callCount}`, pricing: { prompt: "0.0001", completion: "0.0002" } },
          ],
        }),
        { status: 200 }
      );
    });
    
    // First call without options - caches
    const result1 = await getCachedOpenRouterPricing();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result1).toHaveLength(2);
    
    // Second call WITH options - should bypass cache and refetch
    const result2 = await getCachedOpenRouterPricing({
      modelFilter: (id) => id.startsWith("openai/"),
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // Should have the filtered result
    expect(result2).toHaveLength(1);
    expect(result2[0].model).toContain("openai/");
  });

  it("should use stale cache on fetch error", async () => {
    const mockResponse = {
      data: [
        { id: "model-1", pricing: { prompt: "0.0001", completion: "0.0002" } },
      ],
    };

    // First call succeeds — populates cache
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify(mockResponse),
      { status: 200 }
    ));

    const result1 = await getCachedOpenRouterPricing();
    expect(result1).toHaveLength(1);

    // Advance time past TTL (1 hour) so cache is stale
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60 * 60 * 1000; // +2 hours

    // Now make fetch fail — should fall back to stale cache
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Network error");
    });

    const result2 = await getCachedOpenRouterPricing();
    expect(result2).toEqual(result1); // stale cache returned
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to refresh"),
      expect.anything()
    );

    // Restore Date.now
    Date.now = realNow;
    warnSpy.mockRestore();
  });

  it("should throw on fetch error when no stale cache exists", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Network error");
    });

    await expect(getCachedOpenRouterPricing()).rejects.toThrow("Network error");
  });

  it("should filter out models with NaN pricing", async () => {
    const models: OpenRouterModel[] = [
      {
        id: "valid-model",
        pricing: { prompt: "0.0001", completion: "0.0002" },
      },
      {
        id: "nan-model",
        pricing: { prompt: "not-a-number", completion: "0.0002" },
      },
    ];
    const rules = convertToPricingRules(models);
    expect(rules).toHaveLength(1);
    expect(rules[0].model).toBe("valid-model");
  });
});
