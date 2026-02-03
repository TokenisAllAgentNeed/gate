/**
 * admin-cleanup.ts — Verify and clean up spent/invalid proofs from Gate KV.
 *
 * Checks each proof batch against the mint to find already-spent proofs,
 * then removes them from KV.
 */
import type { Context, Handler } from "hono";
import { CashuMint, CashuWallet, type Proof } from "@cashu/cashu-ts";
import {
  listAllProofs,
  storeProofs,
  deleteKeys,
  type KVNamespace,
  type StoredProof,
} from "./ecash-store.js";

export interface AdminCleanupConfig {
  adminToken?: string;
  kvStore?: KVNamespace | null;
  mintUrl: string;
}

import { requireAdmin } from "./lib/auth.js";

/**
 * POST /homo/cleanup
 *
 * Verify all stored proofs by attempting a self-swap at the mint.
 * Spent proofs are removed; valid proofs are re-stored as fresh proofs.
 *
 * This is a heavy operation — processes entries in batches.
 */
export function createAdminCleanupRoute(config: AdminCleanupConfig): Handler {
  const { adminToken, kvStore, mintUrl } = config;

  return async (c) => {
    const authErr = requireAdmin(c, adminToken);
    if (authErr) return authErr;
    if (!kvStore) return c.json({ error: "Storage not available" }, 500);

    const entries = await listAllProofs(kvStore);
    if (entries.length === 0) {
      return c.json({ message: "No proofs to clean", cleaned: 0, kept: 0 });
    }

    const cashuMint = new CashuMint(mintUrl);
    const wallet = new CashuWallet(cashuMint, { unit: "usd" });
    await wallet.loadMint();

    let totalCleaned = 0;
    let totalKeptSats = 0;
    let totalRemovedSats = 0;
    const keysToDelete: string[] = [];

    // Process each entry: try to swap its proofs
    for (const entry of entries) {
      const entryAmount = entry.proofs.reduce((s, p) => s + p.amount, 0);

      try {
        // Self-swap: send all proofs, ask for same amount back
        const result = await wallet.swap(entryAmount, entry.proofs as Proof[]);
        const freshProofs = [...result.send, ...result.keep];
        const freshAmount = freshProofs.reduce((s, p) => s + p.amount, 0);

        // Swap succeeded — store fresh proofs, mark old entry for deletion
        if (freshProofs.length > 0) {
          await storeProofs(kvStore, entry.mintUrl, freshProofs as StoredProof[]);
          totalKeptSats += freshAmount;
        }
        keysToDelete.push(entry.key);
      } catch (e) {
        // Swap failed — some or all proofs in this entry are spent
        // Try individual proofs to salvage what we can
        const validProofs: StoredProof[] = [];

        for (const proof of entry.proofs) {
          try {
            const result = await wallet.swap(proof.amount, [proof as Proof]);
            const fresh = [...result.send, ...result.keep];
            validProofs.push(...(fresh as StoredProof[]));
          } catch {
            // This individual proof is spent
            totalRemovedSats += proof.amount;
            totalCleaned++;
          }
        }

        // Rewrite entry with only valid proofs (or delete if empty)
        if (validProofs.length > 0) {
          await storeProofs(kvStore, entry.mintUrl, validProofs);
          totalKeptSats += validProofs.reduce((s, p) => s + p.amount, 0);
        }
        keysToDelete.push(entry.key);
      }
    }

    // Delete all old entries (they've been replaced with fresh ones)
    if (keysToDelete.length > 0) {
      await deleteKeys(kvStore, keysToDelete);
    }

    return c.json({
      message: "Cleanup complete",
      entries_processed: entries.length,
      proofs_removed: totalCleaned,
      units_removed: totalRemovedSats,
      units_kept: totalKeptSats,
    });
  };
}
