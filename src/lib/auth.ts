/**
 * Shared admin authentication helpers for Gate admin endpoints.
 */
import type { Context } from "hono";

/**
 * Constant-time string comparison to prevent timing attacks.
 * Does not short-circuit on length mismatch to avoid leaking length info.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Basic admin auth check via Authorization: Bearer header.
 * Returns a 401/503 Response on failure, or null on success.
 */
export function requireAdmin(c: Context, adminToken?: string): Response | null {
  if (!adminToken) {
    return c.json({ error: "Admin endpoint not available" }, 503);
  }
  const auth = c.req.header("Authorization");
  const expected = `Bearer ${adminToken}`;
  if (!auth || !timingSafeEqual(auth, expected)) {
    return c.json({ error: "Unauthorized — admin only" }, 401);
  }
  return null;
}
