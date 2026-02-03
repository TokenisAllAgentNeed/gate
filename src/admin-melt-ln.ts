/**
 * Admin melt to Lightning — melt Gate ecash to a Lightning invoice.
 *
 * Uses CashuWallet.meltProofs() which handles blind signature → proof
 * conversion for change proofs automatically.
 */
import type { Context, Handler } from "hono";
import { CashuMint, CashuWallet, type Proof } from "@cashu/cashu-ts";
import { listAllProofs, deleteKeys, storeProofs, type KVNamespace, type StoredProof } from "./ecash-store.js";

export interface AdminMeltLnConfig {
  adminToken?: string;
  kvStore?: KVNamespace | null;
  mintUrl: string;
}

export interface AdminBalanceConfig {
  adminToken?: string;
  kvStore?: KVNamespace | null;
}

import { timingSafeEqual } from "./lib/auth.js";

/** Per-IP brute force tracking */
const adminFailCounts = new Map<string, { count: number; resetAt: number }>();
const adminLockouts = new Map<string, number>(); // ip → lockout expiry timestamp
const ADMIN_MAX_FAILURES = 5;
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const ADMIN_WINDOW_MS = 60 * 1000; // 1 minute window

/**
 * Admin authentication helper with brute-force protection.
 */
async function requireAdmin(c: Context, adminToken?: string): Promise<Response | null> {
  if (!adminToken) {
    return c.json({ error: "Admin endpoint not available" }, 503);
  }

  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "unknown";

  // Check lockout
  const lockoutExpiry = adminLockouts.get(ip);
  if (lockoutExpiry && Date.now() < lockoutExpiry) {
    return c.json({ error: "Too many failed attempts. Try again later." }, 429);
  }
  if (lockoutExpiry) adminLockouts.delete(ip);

  const auth = c.req.header("Authorization");
  const expected = `Bearer ${adminToken}`;
  if (!auth || !timingSafeEqual(auth, expected)) {
    // Track failure
    const now = Date.now();
    const entry = adminFailCounts.get(ip);
    if (!entry || now > entry.resetAt) {
      adminFailCounts.set(ip, { count: 1, resetAt: now + ADMIN_WINDOW_MS });
    } else {
      entry.count += 1;
      if (entry.count >= ADMIN_MAX_FAILURES) {
        adminLockouts.set(ip, now + ADMIN_LOCKOUT_MS);
        adminFailCounts.delete(ip);
        return c.json({ error: "Too many failed attempts. Try again later." }, 429);
      }
    }
    return c.json({ error: "Unauthorized — admin only" }, 401);
  }

  // Success — clear any failure tracking
  adminFailCounts.delete(ip);
  return null;
}

/**
 * Create the POST /admin/melt-ln handler.
 *
 * Melts Gate ecash to a specified Lightning invoice.
 *
 * Uses CashuWallet.meltProofs() so that change proofs (from fee overpayment)
 * are properly constructed as full Proof objects and stored back to KV.
 */
export function createAdminMeltLnRoute(config: AdminMeltLnConfig): Handler {
  const { adminToken, kvStore, mintUrl } = config;

  return async (c) => {
    // Auth check
    const authErr = await requireAdmin(c, adminToken);
    if (authErr) return authErr;

    // KV check
    if (!kvStore) {
      return c.json({ error: "Storage not available" }, 500);
    }

    // Parse request body
    let body: { invoice?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { invoice } = body;
    if (!invoice) {
      return c.json({ error: "Missing 'invoice' field — provide a bolt11 invoice" }, 400);
    }

    // 1. Collect all stored proofs
    const entries = await listAllProofs(kvStore);
    if (entries.length === 0) {
      return c.json({ error: "No proofs to melt" }, 400);
    }

    const allProofs = entries.flatMap((e) => e.proofs);
    const totalSats = allProofs.reduce((s, p) => s + p.amount, 0);

    if (totalSats <= 0) {
      return c.json({ error: "No balance to melt" }, 400);
    }

    // 2. Init CashuWallet and get melt quote
    const cashuMint = new CashuMint(mintUrl);
    const wallet = new CashuWallet(cashuMint, { unit: "usd" });
    await wallet.loadMint();

    let meltQuote;
    try {
      meltQuote = await wallet.createMeltQuote(invoice);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Melt quote failed:", msg);
      return c.json({ error: "Melt quote failed", details: msg }, 502);
    }

    // Check if we have enough proofs
    const requiredAmount = meltQuote.amount + meltQuote.fee_reserve;
    if (totalSats < requiredAmount) {
      return c.json({
        error: `Insufficient balance: have ${totalSats} units, need ${requiredAmount} units (invoice ${meltQuote.amount} + fee ${meltQuote.fee_reserve})`,
        balance_units: totalSats,
        required_units: requiredAmount,
      }, 400);
    }

    // 3. Melt proofs via CashuWallet — handles change proof construction
    let meltResult;
    try {
      meltResult = await wallet.meltProofs(meltQuote, allProofs as Proof[]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Melt transfer failed:", msg);
      return c.json({ error: "Melt transfer failed", details: msg }, 502);
    }

    const isPaid = meltResult.quote.state === "PAID";
    const changeProofs = meltResult.change ?? [];
    const changeAmount = changeProofs.reduce((s, p) => s + p.amount, 0);

    // 4. On success: store change proofs FIRST, then delete old entries
    if (isPaid) {
      // Store change proofs back to KV (these are full Proof objects from SDK)
      if (changeProofs.length > 0) {
        const entryMint = entries[0]?.mintUrl ?? mintUrl;
        await storeProofs(kvStore, entryMint, changeProofs as StoredProof[]);
      }

      // Now safe to delete old entries
      await deleteKeys(
        kvStore,
        entries.map((e) => e.key),
      );
    }

    return c.json({
      success: isPaid,
      amount_units: meltQuote.amount,
      fee_units: meltQuote.fee_reserve - changeAmount,
      input_units: totalSats,
      change_units: changeAmount,
      payment_preimage: meltResult.quote.payment_preimage ?? null,
    });
  };
}

/**
 * Create the GET /admin/balance-ln handler.
 *
 * Returns the Gate's ecash balance (what can be melted).
 */
export function createAdminBalanceLnRoute(config: AdminBalanceConfig): Handler {
  const { adminToken, kvStore } = config;

  return async (c) => {
    // Auth check
    const authErr = await requireAdmin(c, adminToken);
    if (authErr) return authErr;

    // KV check
    if (!kvStore) {
      return c.json({ error: "Storage not available" }, 500);
    }

    // Get all proofs and calculate balance
    const entries = await listAllProofs(kvStore);
    const allProofs = entries.flatMap((e) => e.proofs);
    const totalSats = allProofs.reduce((s, p) => s + p.amount, 0);

    return c.json({
      balance_units: totalSats,
      proof_count: allProofs.length,
      entry_count: entries.length,
    });
  };
}
