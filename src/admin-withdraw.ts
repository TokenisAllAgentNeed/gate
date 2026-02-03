/**
 * admin-withdraw.ts — Withdraw ecash from Gate to an external wallet.
 *
 * Safety: uses mint swap to atomically split proofs.
 * Original proofs are only deleted from KV after swap succeeds.
 */
import type { Context, Handler } from "hono";
import {
  CashuMint,
  CashuWallet,
  getEncodedTokenV4,
  type Proof,
} from "@cashu/cashu-ts";
import {
  listAllProofs,
  storeProofs,
  deleteKeys,
  type KVNamespace,
  type StoredProof,
} from "./ecash-store.js";

export interface AdminWithdrawConfig {
  adminToken?: string;
  kvStore?: KVNamespace | null;
  mintUrl: string;
}

import { requireAdmin } from "./lib/auth.js";

/**
 * Select proofs totalling at least `amount` sats (greedy descending).
 * Returns { selected, remaining, selectedEntryKeys }.
 */
function selectProofs(
  entries: Array<{ key: string; mintUrl: string; proofs: StoredProof[] }>,
  amount: number,
): {
  selected: StoredProof[];
  totalSelected: number;
  affectedEntryKeys: string[];
  remainingProofsPerEntry: Map<string, StoredProof[]>;
} {
  // Flatten all proofs with entry key tracking
  const all: Array<{ proof: StoredProof; entryKey: string }> = [];
  for (const e of entries) {
    for (const p of e.proofs) {
      all.push({ proof: p, entryKey: e.key });
    }
  }

  // Sort descending by amount for greedy selection
  all.sort((a, b) => b.proof.amount - a.proof.amount);

  const selected: StoredProof[] = [];
  const usedFromEntry = new Map<string, Set<string>>(); // entryKey → set of secrets
  let total = 0;

  for (const { proof, entryKey } of all) {
    if (total >= amount) break;
    selected.push(proof);
    total += proof.amount;

    if (!usedFromEntry.has(entryKey)) usedFromEntry.set(entryKey, new Set());
    const secretStr = typeof proof.secret === "string" ? proof.secret : JSON.stringify(proof.secret);
    usedFromEntry.get(entryKey)!.add(secretStr);
  }

  // Figure out which entries are fully consumed vs partially
  const affectedEntryKeys: string[] = [];
  const remainingProofsPerEntry = new Map<string, StoredProof[]>();

  for (const e of entries) {
    const usedSecrets = usedFromEntry.get(e.key);
    if (!usedSecrets) continue; // entry not touched

    affectedEntryKeys.push(e.key);
    const remaining = e.proofs.filter((p) => {
      const s = typeof p.secret === "string" ? p.secret : JSON.stringify(p.secret);
      return !usedSecrets.has(s);
    });
    if (remaining.length > 0) {
      remainingProofsPerEntry.set(e.key, remaining);
    }
  }

  return { selected, totalSelected: total, affectedEntryKeys, remainingProofsPerEntry };
}

/**
 * POST /homo/withdraw
 *
 * Body: { amount: number }  (sats to withdraw)
 *
 * Flow:
 *   1. Select proofs >= amount
 *   2. Swap at mint → get withdrawProofs (= amount) + changeProofs (= overpay)
 *   3. Store changeProofs back to KV
 *   4. Delete original entries from KV
 *   5. Return encoded token with withdrawProofs
 */
export function createAdminWithdrawRoute(config: AdminWithdrawConfig): Handler {
  const { adminToken, kvStore, mintUrl } = config;

  return async (c) => {
    const authErr = requireAdmin(c, adminToken);
    if (authErr) return authErr;
    if (!kvStore) return c.json({ error: "Storage not available" }, 500);

    // Parse body
    let body: { amount?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { amount } = body;
    if (!amount || typeof amount !== "number" || amount <= 0 || !Number.isInteger(amount)) {
      return c.json({ error: "Missing or invalid 'amount' (positive integer sats)" }, 400);
    }

    // 1. Load all proofs
    const entries = await listAllProofs(kvStore);
    const totalBalance = entries.reduce(
      (sum, e) => sum + e.proofs.reduce((s, p) => s + p.amount, 0),
      0,
    );

    if (totalBalance < amount) {
      return c.json({
        error: `Insufficient balance: have ${totalBalance} units, requested ${amount} units`,
        balance_units: totalBalance,
      }, 400);
    }

    // 2. Select proofs
    const { selected, totalSelected, affectedEntryKeys, remainingProofsPerEntry } =
      selectProofs(entries, amount);

    if (totalSelected < amount) {
      return c.json({ error: "Failed to select enough proofs" }, 500);
    }

    // 3. Swap at mint to get exact split
    let withdrawProofs: Proof[];
    let changeProofs: Proof[];

    try {
      const cashuMint = new CashuMint(mintUrl);
      const wallet = new CashuWallet(cashuMint, { unit: "usd" });
      await wallet.loadMint();

      // swap: send all selected proofs, request `amount` back + change
      const result = await wallet.swap(amount, selected as Proof[]);
      withdrawProofs = result.send;       // exactly `amount` sats
      changeProofs = result.keep;         // overpay returned
    } catch (e) {
      // Swap failed — original proofs in KV are untouched, no money lost
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({
        error: `Mint swap failed — no funds lost, original proofs intact`,
        details: msg,
      }, 502);
    }

    // 4. Swap succeeded — original selected proofs are now spent at the mint.
    //    Store change proofs back to KV (if any).
    if (changeProofs.length > 0) {
      // Determine the mint URL from the first affected entry
      const entryMint = entries.find((e) => affectedEntryKeys.includes(e.key))?.mintUrl ?? mintUrl;
      await storeProofs(kvStore, entryMint, changeProofs as StoredProof[]);
    }

    // 5. Update KV: for partially-used entries, rewrite with remaining proofs.
    //    For fully-used entries, delete.
    const keysToDelete: string[] = [];
    for (const key of affectedEntryKeys) {
      const remaining = remainingProofsPerEntry.get(key);
      if (remaining && remaining.length > 0) {
        // Rewrite entry with only remaining proofs
        const entryMint = entries.find((e) => e.key === key)?.mintUrl ?? mintUrl;
        await kvStore.put(key, JSON.stringify({ mintUrl: entryMint, proofs: remaining }));
      } else {
        keysToDelete.push(key);
      }
    }
    if (keysToDelete.length > 0) {
      await deleteKeys(kvStore, keysToDelete);
    }

    // 6. Encode withdraw proofs as Cashu token
    const token = getEncodedTokenV4({
      mint: mintUrl,
      proofs: withdrawProofs,
      unit: "usd",
    });

    const withdrawAmount = withdrawProofs.reduce((s, p) => s + p.amount, 0);
    const changeAmount = changeProofs.reduce((s, p) => s + p.amount, 0);

    return c.json({
      success: true,
      token,
      amount_units: withdrawAmount,
      change_units: changeAmount,
      remaining_balance_units: totalBalance - withdrawAmount,
    });
  };
}
