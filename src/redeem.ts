import { CashuMint, CashuWallet, type Proof } from "@cashu/cashu-ts";
import type { Stamp } from "./lib/types.js";
import { CircuitBreaker } from "./circuit-breaker.js";

export interface RedeemSuccess {
  ok: true;
  /** Proofs the Gate keeps (= price amount) */
  keep: Proof[];
  /** Change proofs to return to user (= overpayment). Empty if exact payment. */
  change: Proof[];
  /** KV key where keep proofs were stored (returned by onRedeem). Used for cleanup on refund. */
  kvKey?: string;
}

export interface RedeemFailure {
  ok: false;
  error: string;
}

export type RedeemResult = RedeemSuccess | RedeemFailure;

/**
 * Create a redeemFn that swaps (receives) Cashu proofs at the real mint,
 * splitting into Gate's share and user's change.
 *
 * Uses wallet.swap(price, proofs) which returns:
 *   - send: proofs matching the price (Gate keeps)
 *   - keep: overpayment proofs (change for user)
 *
 * If price is not provided (0 or undefined), all proofs go to Gate (no change).
 *
 * @param onRedeem - Optional callback with the Gate's proofs (for storage/melting).
 *   May return a KV key string for later cleanup (e.g. on refund).
 * @param timeoutMs - Timeout for mint swap operations (default: 10000ms).
 */
export function createRedeemFn(opts?: {
  onRedeem?: (mintUrl: string, proofs: Proof[]) => string | void | Promise<string | void>;
  timeoutMs?: number;
}) {
  // Cache wallets per mint URL to avoid re-loading keys every request
  const walletCache = new Map<string, CashuWallet>();
  // Circuit breaker per mint URL
  const breakers = new Map<string, CircuitBreaker>();

  function getBreaker(mintUrl: string): CircuitBreaker {
    let breaker = breakers.get(mintUrl);
    if (!breaker) {
      breaker = new CircuitBreaker();
      breakers.set(mintUrl, breaker);
    }
    return breaker;
  }

  async function getWallet(mintUrl: string): Promise<CashuWallet> {
    const cached = walletCache.get(mintUrl);
    if (cached) return cached;

    const mint = new CashuMint(mintUrl);
    const wallet = new CashuWallet(mint, { unit: "usd" });
    await wallet.loadMint();
    walletCache.set(mintUrl, wallet);
    return wallet;
  }

  const swapTimeout = opts?.timeoutMs ?? 10_000;

  return async (stamp: Stamp, price?: number): Promise<RedeemResult> => {
    // Check circuit breaker before attempting swap
    const breaker = getBreaker(stamp.mint);
    if (!breaker.canCall()) {
      return { ok: false, error: "Mint temporarily unavailable (circuit open)" };
    }

    try {
      const wallet = await getWallet(stamp.mint);

      let keep: Proof[];  // Gate's proofs
      let change: Proof[]; // User's change

      // Wrap swap/receive in a timeout to prevent hanging on unresponsive mints
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Mint swap timeout")), swapTimeout)
      );

      if (price && price > 0 && price < stamp.amount) {
        // Overpayment: swap with amount split
        // wallet.swap(amount, proofs) → { send: amount-worth, keep: remainder }
        const result = await Promise.race([
          wallet.swap(price, stamp.proofs),
          timeoutPromise,
        ]);
        keep = result.send;     // Gate keeps price amount
        change = result.keep;   // User gets change
      } else {
        // Exact payment or no price specified: receive all
        const newProofs = await Promise.race([
          wallet.receive(stamp.raw),
          timeoutPromise,
        ]);
        if (!newProofs || newProofs.length === 0) {
          return { ok: false, error: "Swap returned no proofs" };
        }
        keep = newProofs;
        change = [];
      }

      // Notify the gate about its proofs (for storage/melting)
      let kvKey: string | undefined;
      try {
        const result = await opts?.onRedeem?.(stamp.mint, keep);
        if (typeof result === "string") {
          kvKey = result;
        }
      } catch (e) {
        console.error("onRedeem callback failed:", e);
      }

      breaker.onSuccess();
      return { ok: true, keep, change, kvKey };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Common Cashu errors for spent tokens
      if (
        msg.includes("already spent") ||
        msg.includes("Token already spent") ||
        msg.includes("PROOF_ALREADY_USED") ||
        msg.includes("11001")
      ) {
        return { ok: false, error: "Token already spent" };
      }
      breaker.onFailure();
      console.error("Redeem failed:", msg);
      return { ok: false, error: "Redeem failed" };
    }
  };
}
