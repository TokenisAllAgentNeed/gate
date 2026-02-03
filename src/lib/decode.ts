import { getDecodedToken } from "@cashu/cashu-ts";
import {
  detectTokenVersion,
  extractCborStructure,
  type DecodeDiagnostics,
} from "@token2chat/agent-wallet";
import type { Stamp } from "./types.js";

// Re-export for backward compatibility
export { detectTokenVersion, type DecodeDiagnostics };

/** Global debug flag - set to true to enable verbose logging */
export let DEBUG_DECODE = false;

/** Set decode debug mode */
export function setDebugDecode(enabled: boolean): void {
  DEBUG_DECODE = enabled;
}

/**
 * Decode a serialized Cashu token (V3 or V4) into a Stamp.
 *
 * @param header - The raw token string from X-Cashu header (e.g. "cashuB...")
 * @returns Parsed Stamp object
 * @throws Error if token is empty, malformed, or contains no proofs
 */
export function decodeStamp(header: string): Stamp {
  if (!header || header.trim() === "") {
    throw new Error("Empty token");
  }

  const trimmed = header.trim();

  let token;
  try {
    token = getDecodedToken(trimmed);
  } catch (e) {
    throw new Error(
      `Invalid Cashu token: ${e instanceof Error ? e.message : "decode failed"}`
    );
  }

  // Extract mint URL and proofs
  const mint = token.mint;
  const proofs = token.proofs;

  if (!mint) {
    throw new Error("Invalid Cashu token: missing mint URL");
  }

  if (!proofs || proofs.length === 0) {
    throw new Error("Invalid Cashu token: no proofs");
  }

  if (proofs.length > 256) {
    throw new Error(`Too many proofs: ${proofs.length} (max 256)`);
  }

  // Sum up the total amount from all proofs
  const amount = proofs.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0);

  return {
    raw: trimmed,
    token,
    mint,
    amount,
    proofs,
  };
}

/**
 * Decode with diagnostics - returns both the stamp and diagnostic info.
 * Useful for debugging CBOR issues in workerd environments.
 */
export function decodeStampWithDiagnostics(header: string): {
  stamp: Stamp | null;
  diagnostics: DecodeDiagnostics;
} {
  const startTime = performance.now();
  const diagnostics: DecodeDiagnostics = {
    tokenVersion: "unknown",
    rawPrefix: header?.slice(0, 10) ?? "",
    decodeTimeMs: 0,
    proofCount: 0,
  };

  if (!header || header.trim() === "") {
    diagnostics.error = "Empty token";
    diagnostics.decodeTimeMs = performance.now() - startTime;
    return { stamp: null, diagnostics };
  }

  const trimmed = header.trim();
  diagnostics.tokenVersion = detectTokenVersion(trimmed);
  diagnostics.rawPrefix = trimmed.slice(0, 15);

  let token;
  try {
    token = getDecodedToken(trimmed);
  } catch (e) {
    diagnostics.error = e instanceof Error ? e.message : "decode failed";
    diagnostics.decodeTimeMs = performance.now() - startTime;
    
    // For V4 tokens, try to extract raw CBOR info for debugging
    if (diagnostics.tokenVersion === "V4" && DEBUG_DECODE) {
      try {
        diagnostics.rawCborStructure = extractCborStructure(trimmed);
      } catch {
        diagnostics.rawCborStructure = "Failed to extract CBOR structure";
      }
    }
    
    return { stamp: null, diagnostics };
  }

  const mint = token.mint;
  const proofs = token.proofs;
  diagnostics.proofCount = proofs?.length ?? 0;
  diagnostics.decodeTimeMs = performance.now() - startTime;

  if (!mint) {
    diagnostics.error = "Missing mint URL";
    return { stamp: null, diagnostics };
  }

  if (!proofs || proofs.length === 0) {
    diagnostics.error = "No proofs";
    return { stamp: null, diagnostics };
  }

  if (proofs.length > 256) {
    diagnostics.error = `Too many proofs: ${proofs.length} (max 256)`;
    return { stamp: null, diagnostics };
  }

  const amount = proofs.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0);

  return {
    stamp: {
      raw: trimmed,
      token,
      mint,
      amount,
      proofs,
    },
    diagnostics,
  };
}
