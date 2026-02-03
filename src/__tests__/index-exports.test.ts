/**
 * Verify src/index.ts re-exports are accessible.
 */
import { describe, test, expect } from "vitest";
import {
  createGateApp,
  stampGate,
  createRedeemFn,
  resolveUpstream,
  proxyToUpstream,
  PRICING,
  loadPricing,
  mergePricing,
  meltProofs,
  fetchOpenRouterPricing,
  getCachedOpenRouterPricing,
  convertToPricingRules,
  clearPricingCache,
  USD_TO_UNITS,
  getPrice,
  validateAmount,
  estimateMaxCost,
  calculateActualCost,
  DEFAULT_MAX_TOKENS,
} from "../index.js";

describe("index.ts re-exports", () => {
  test("all named exports are defined", () => {
    expect(createGateApp).toBeDefined();
    expect(stampGate).toBeDefined();
    expect(createRedeemFn).toBeDefined();
    expect(resolveUpstream).toBeDefined();
    expect(proxyToUpstream).toBeDefined();
    expect(PRICING).toBeDefined();
    expect(loadPricing).toBeDefined();
    expect(mergePricing).toBeDefined();
    expect(meltProofs).toBeDefined();
    expect(fetchOpenRouterPricing).toBeDefined();
    expect(getCachedOpenRouterPricing).toBeDefined();
    expect(convertToPricingRules).toBeDefined();
    expect(clearPricingCache).toBeDefined();
    expect(USD_TO_UNITS).toBe(100000);
    expect(getPrice).toBeDefined();
    expect(validateAmount).toBeDefined();
    expect(estimateMaxCost).toBeDefined();
    expect(calculateActualCost).toBeDefined();
    expect(DEFAULT_MAX_TOKENS).toBeDefined();
  });
});
