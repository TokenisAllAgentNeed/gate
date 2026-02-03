/**
 * Circuit breaker for mint swap operations.
 *
 * States: CLOSED → OPEN (after threshold failures) → HALF_OPEN (after cooldown).
 * Prevents cascading failures when a mint is unresponsive.
 */

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of failures before opening circuit (default: 3) */
  failureThreshold?: number;
  /** Window in ms to count failures (default: 60_000) */
  failureWindowMs?: number;
  /** Cooldown in ms before trying again (default: 30_000) */
  cooldownMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures: number[] = [];
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly cooldownMs: number;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold = opts?.failureThreshold ?? 3;
    this.failureWindowMs = opts?.failureWindowMs ?? 60_000;
    this.cooldownMs = opts?.cooldownMs ?? 30_000;
  }

  /** Check if a call is allowed */
  canCall(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      // Check if cooldown has elapsed
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = "HALF_OPEN";
        return true;
      }
      return false;
    }
    // HALF_OPEN: allow one trial call
    return true;
  }

  /** Record a successful call */
  onSuccess(): void {
    this.failures = [];
    this.state = "CLOSED";
  }

  /** Record a failed call */
  onFailure(): void {
    const now = Date.now();

    if (this.state === "HALF_OPEN") {
      // Trial call failed — reopen
      this.state = "OPEN";
      this.openedAt = now;
      return;
    }

    // CLOSED state: track failures within window
    this.failures.push(now);
    this.failures = this.failures.filter((t) => now - t < this.failureWindowMs);

    if (this.failures.length >= this.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = now;
      this.failures = [];
    }
  }

  /** Current circuit state (for diagnostics) */
  getState(): CircuitState {
    return this.state;
  }
}
