/**
 * ecash-store.ts — Persist and retrieve Cashu proofs in Cloudflare KV.
 *
 * Key schema: proofs:{timestamp}:{random}
 * Value: JSON array of Cashu Proof objects
 */

import type { KVNamespace } from "./lib/kv.js";
export type { KVNamespace };

export interface StoredProof {
  amount: number;
  id: string;
  secret: string;
  C: string;
}

export interface ProofEntry {
  key: string;
  mintUrl: string;
  proofs: StoredProof[];
}

/**
 * Store proofs in KV under a timestamped key.
 */
export async function storeProofs(
  kv: KVNamespace,
  mintUrl: string,
  proofs: StoredProof[],
): Promise<string> {
  const key = `proofs:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await kv.put(key, JSON.stringify({ mintUrl, proofs }));
  return key;
}

/**
 * List all stored proof entries from KV.
 */
export async function listAllProofs(kv: KVNamespace): Promise<ProofEntry[]> {
  const entries: ProofEntry[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ prefix: "proofs:", cursor, limit: 1000 });
    for (const { name } of result.keys) {
      const raw = await kv.get(name);
      if (!raw) continue;
      try {
        const data = JSON.parse(raw) as { mintUrl: string; proofs: StoredProof[] };
        entries.push({ key: name, mintUrl: data.mintUrl, proofs: data.proofs });
      } catch {
        // skip corrupt entries
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return entries;
}

/**
 * Calculate total balance across all stored proofs.
 */
export async function getBalance(kv: KVNamespace): Promise<number> {
  const entries = await listAllProofs(kv);
  return entries.reduce(
    (sum, e) => sum + e.proofs.reduce((s, p) => s + p.amount, 0),
    0,
  );
}

/**
 * Delete specific KV keys (after successful melt).
 */
export async function deleteKeys(kv: KVNamespace, keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => kv.delete(k)));
}
