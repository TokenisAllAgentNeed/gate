/**
 * Melt ecash proofs → on-chain transfer via the Cashu mint.
 *
 * Extracted from the inline /v1/gate/melt route handler.
 */
import {
  listAllProofs,
  deleteKeys,
  storeProofs,
  type KVNamespace,
} from "./ecash-store.js";

export interface MeltConfig {
  kv: KVNamespace;
  mintUrl: string;
  walletAddress: string;
}

export interface MeltSuccess {
  ok: true;
  melted: boolean;
  amount_units: number;
  tx_hash: string | null;
  address: string;
  /** Amount of change proofs returned by the mint (fee overpayment). 0 if none. */
  change_units: number;
}

export interface MeltFailure {
  ok: false;
  error: string;
  status: number;
}

export type MeltResult = MeltSuccess | MeltFailure;

/**
 * Collect all stored proofs, request a melt quote, submit to mint,
 * and clear KV on success.
 */
export async function meltProofs(config: MeltConfig): Promise<MeltResult> {
  const { kv, mintUrl, walletAddress } = config;

  // 1. Collect all stored proofs
  const entries = await listAllProofs(kv);
  if (entries.length === 0) {
    return { ok: false, error: "No proofs to melt", status: 400 };
  }

  const allProofs = entries.flatMap((e) => e.proofs);
  const totalSats = allProofs.reduce((s, p) => s + p.amount, 0);

  if (totalSats <= 0) {
    return { ok: false, error: "No balance to melt", status: 400 };
  }

  // 2. Request melt quote from mint
  const quoteRes = await fetch(`${mintUrl}/v1/melt/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: totalSats,
      address: walletAddress,
      chain: "base",
    }),
  });

  if (!quoteRes.ok) {
    console.error("Melt quote failed:", quoteRes.status, await quoteRes.text());
    return { ok: false, error: "Melt quote failed", status: 502 };
  }

  const quote = (await quoteRes.json()) as {
    quote: string;
    amount_sats: number;
    fee_sats: number;
  };

  // 3. Submit proofs to melt
  const meltRes = await fetch(`${mintUrl}/v1/melt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quote: quote.quote,
      inputs: allProofs,
    }),
  });

  if (!meltRes.ok) {
    console.error("Melt transfer failed:", meltRes.status, await meltRes.text());
    return { ok: false, error: "Melt transfer failed", status: 502 };
  }

  const meltResult = (await meltRes.json()) as {
    paid: boolean;
    tx_hash?: string;
    change?: Array<{ amount: number; id: string; C: string; secret: string }>;
  };

  const changeProofs = meltResult.change ?? [];
  const changeSats = changeProofs.reduce((s, p) => s + p.amount, 0);

  // 4. On success: store change proofs FIRST, then delete old entries
  if (meltResult.paid) {
    // Store change proofs back to KV (if any) — must happen before deleting old keys
    if (changeProofs.length > 0) {
      await storeProofs(kv, mintUrl, changeProofs);
    }

    await deleteKeys(
      kv,
      entries.map((e) => e.key),
    );
  }

  return {
    ok: true,
    melted: meltResult.paid,
    amount_units: totalSats,
    tx_hash: meltResult.tx_hash ?? null,
    address: walletAddress,
    change_units: changeSats,
  };
}
