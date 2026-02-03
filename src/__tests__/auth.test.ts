/**
 * Unit tests for lib/auth.ts — timingSafeEqual + requireAdmin.
 */
import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "../lib/auth.js";

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeEqual("hello", "world")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(timingSafeEqual("short", "longer-string")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false for single char difference", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });

  it("handles special characters", () => {
    const token = "Bearer sk-abc123!@#$%^&*()";
    expect(timingSafeEqual(token, token)).toBe(true);
    expect(timingSafeEqual(token, token + "x")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(timingSafeEqual("ABC", "abc")).toBe(false);
  });
});
