/**
 * Unit tests for circuit-breaker.ts — CircuitBreaker state machine.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CircuitBreaker } from "../circuit-breaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in CLOSED state, allows calls", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canCall()).toBe(true);
  });

  it("stays CLOSED when failures are below threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canCall()).toBe(true);
  });

  it("opens after reaching failure threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.onFailure();
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canCall()).toBe(false);
  });

  it("drops old failures outside the window", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      failureWindowMs: 10_000,
    });

    cb.onFailure(); // t=0
    cb.onFailure(); // t=0

    // Advance past window so first two failures expire
    vi.advanceTimersByTime(11_000);

    cb.onFailure(); // t=11000 — only 1 failure in window now

    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canCall()).toBe(true);
  });

  it("transitions OPEN → HALF_OPEN after cooldown", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 5_000,
    });

    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canCall()).toBe(false);

    // Advance past cooldown
    vi.advanceTimersByTime(5_000);

    expect(cb.canCall()).toBe(true);
    expect(cb.getState()).toBe("HALF_OPEN");
  });

  it("does not transition OPEN → HALF_OPEN before cooldown", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 5_000,
    });

    cb.onFailure();
    cb.onFailure();

    vi.advanceTimersByTime(4_999);

    expect(cb.canCall()).toBe(false);
    expect(cb.getState()).toBe("OPEN");
  });

  it("HALF_OPEN success → resets to CLOSED", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
    });

    cb.onFailure();
    cb.onFailure();
    vi.advanceTimersByTime(1_000);
    cb.canCall(); // triggers HALF_OPEN

    cb.onSuccess();

    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canCall()).toBe(true);
  });

  it("HALF_OPEN failure → reopens to OPEN", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
    });

    cb.onFailure();
    cb.onFailure();
    vi.advanceTimersByTime(1_000);
    cb.canCall(); // triggers HALF_OPEN
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.onFailure();

    expect(cb.getState()).toBe("OPEN");
    expect(cb.canCall()).toBe(false);
  });

  it("onSuccess in CLOSED state clears failure history", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    cb.onFailure();
    cb.onFailure();
    cb.onSuccess(); // clears failures

    cb.onFailure();
    cb.onFailure();
    // Only 2 failures since reset, not 4
    expect(cb.getState()).toBe("CLOSED");
  });

  it("HALF_OPEN allows calls (trial call)", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
    });

    cb.onFailure();
    cb.onFailure();
    vi.advanceTimersByTime(1_000);
    cb.canCall(); // triggers HALF_OPEN

    // Should still allow calls in HALF_OPEN
    expect(cb.canCall()).toBe(true);
  });

  it("uses default options when none provided", () => {
    const cb = new CircuitBreaker();

    // Default threshold is 3
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe("CLOSED");
    cb.onFailure();
    expect(cb.getState()).toBe("OPEN");

    // Default cooldown is 30_000
    vi.advanceTimersByTime(29_999);
    expect(cb.canCall()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(cb.canCall()).toBe(true);
  });

  it("OPEN → HALF_OPEN → fail → OPEN → HALF_OPEN → success → CLOSED cycle", () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1_000,
    });

    // Open it
    cb.onFailure();
    cb.onFailure();
    expect(cb.getState()).toBe("OPEN");

    // Cooldown → HALF_OPEN → fail → OPEN again
    vi.advanceTimersByTime(1_000);
    cb.canCall();
    cb.onFailure();
    expect(cb.getState()).toBe("OPEN");

    // Another cooldown → HALF_OPEN → success → CLOSED
    vi.advanceTimersByTime(1_000);
    cb.canCall();
    cb.onSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canCall()).toBe(true);
  });
});
