import { describe, it, expect, beforeEach } from "vitest";
import {
  storeProofs,
  listAllProofs,
  getBalance,
  deleteKeys,
  type StoredProof,
} from "../ecash-store.js";
import { createMockKV } from "./helpers.js";

const MINT = "https://mint.example.com";

function makeProofs(amounts: number[]): StoredProof[] {
  return amounts.map((amount, i) => ({
    amount,
    id: "009a1f293253e41e",
    secret: `secret_${i}_${Math.random().toString(36).slice(2)}`,
    C: "02" + "ab".repeat(32),
  }));
}

describe("ecash-store", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    kv = createMockKV();
  });

  describe("storeProofs", () => {
    it("should store proofs and return a key with proofs: prefix", async () => {
      const proofs = makeProofs([100, 200]);
      const key = await storeProofs(kv, MINT, proofs);
      expect(key).toMatch(/^proofs:\d+:/);

      const raw = await kv.get(key);
      expect(raw).not.toBeNull();
      const data = JSON.parse(raw!);
      expect(data.mintUrl).toBe(MINT);
      expect(data.proofs).toHaveLength(2);
      expect(data.proofs[0].amount).toBe(100);
    });
  });

  describe("listAllProofs", () => {
    it("should return empty array when no proofs stored", async () => {
      const entries = await listAllProofs(kv);
      expect(entries).toEqual([]);
    });

    it("should return all stored proof entries", async () => {
      await storeProofs(kv, MINT, makeProofs([100]));
      await storeProofs(kv, MINT, makeProofs([200, 300]));

      const entries = await listAllProofs(kv);
      expect(entries).toHaveLength(2);
      expect(entries[0].mintUrl).toBe(MINT);
    });
  });

  describe("getBalance", () => {
    it("should return 0 when no proofs stored", async () => {
      expect(await getBalance(kv)).toBe(0);
    });

    it("should sum all proof amounts", async () => {
      await storeProofs(kv, MINT, makeProofs([100, 200]));
      await storeProofs(kv, MINT, makeProofs([50]));

      expect(await getBalance(kv)).toBe(350);
    });
  });

  describe("deleteKeys", () => {
    it("should remove specified keys", async () => {
      const k1 = await storeProofs(kv, MINT, makeProofs([100]));
      const k2 = await storeProofs(kv, MINT, makeProofs([200]));

      await deleteKeys(kv, [k1]);

      const entries = await listAllProofs(kv);
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe(k2);
    });

    it("should result in 0 balance after deleting all", async () => {
      const k1 = await storeProofs(kv, MINT, makeProofs([100]));
      const k2 = await storeProofs(kv, MINT, makeProofs([200]));

      await deleteKeys(kv, [k1, k2]);
      expect(await getBalance(kv)).toBe(0);
    });
  });
});
