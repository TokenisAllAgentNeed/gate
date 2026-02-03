/**
 * Shared KVNamespace interface — compatible with Cloudflare Workers KV.
 *
 * Used by both gate/ecash-store and mint/types to avoid duplicate definitions.
 */
export interface KVNamespace {
  get(key: string, options?: { type?: string }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}
