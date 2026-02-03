/**
 * Shared test helpers for Gate tests.
 */
import type { KVNamespace } from "../lib/kv.js";

/** In-memory mock of Cloudflare KV with optional exposed store. */
export function createMockKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
      const prefix = opts?.prefix ?? "";
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}
