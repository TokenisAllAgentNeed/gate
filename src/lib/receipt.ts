import type { Receipt, Stamp } from "./types.js";

/**
 * SHA-256 hash using Web Crypto API (works in Node, CF Workers, Deno, browsers).
 * Falls back to sync node:crypto if subtle not available.
 */
async function sha256hex(input: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const buf = new TextEncoder().encode(input);
    const hash = await globalThis.crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Fallback for older Node without subtle
  const { createHash } = await import(/* @vite-ignore */ "node:crypto" as string) as
    { createHash: (algorithm: string) => { update(data: string): { digest(encoding: string): string } } };
  return createHash("sha256").update(input).digest("hex");
}

/** Generate UUID using Web Crypto API */
function uuid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Create a payment receipt from a validated stamp.
 *
 * @param stamp - The stamp that was consumed
 * @param model - The model that was used
 * @param amount - The actual amount consumed (sat)
 * @returns A Receipt object
 */
export async function createReceipt(
  stamp: Stamp,
  model: string,
  amount: number
): Promise<Receipt> {
  // Hash the proof secrets for audit trail (never store raw secrets)
  const secretsConcat = stamp.proofs
    .map((p) =>
      typeof p.secret === "string" ? p.secret : JSON.stringify(p.secret)
    )
    .join("|");
  const fullHash = await sha256hex(secretsConcat);
  const token_hash = fullHash.slice(0, 16); // truncated, for reference only

  return {
    id: uuid(),
    timestamp: new Date().toISOString(),
    amount,
    unit: "usd",
    model,
    token_hash,
  };
}
