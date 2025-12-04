// src/risk.ts
import { Connection, PublicKey } from "@solana/web3.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export interface RiskAssessment {
  mint: string;
  score: number; // 0–100
  level: RiskLevel;
  tags: string[];
  reasons: string[];
}

export interface MintContext {
  mint: string;
  sig?: string;
  slot?: number;
}

/**
 * Build a Connection if RPC_ENDPOINT is set.
 * If not, we still return risk with "UNKNOWN" but no chain data.
 */
export function buildConnectionFromEnv(): Connection | null {
  const endpoint = process.env.RPC_ENDPOINT;
  if (!endpoint) return null;
  return new Connection(endpoint, "confirmed");
}

/**
 * Fetch parsed mint info from RPC if possible.
 */
async function fetchMintInfo(
  connection: Connection,
  mint: string
): Promise<any | null> {
  try {
    const pubkey = new PublicKey(mint);
    const acc = await connection.getParsedAccountInfo(pubkey);
    if (!acc.value) return null;
    const data: any = acc.value.data;
    if (!data || data.program !== "spl-token") return null;
    if (data.parsed?.type !== "mint") return null;
    return data.parsed.info;
  } catch {
    return null;
  }
}

/**
 * Core scoring logic.
 * Super simple v1 heuristics, but structured so we can evolve it later.
 */
export async function assessMintRisk(
  ctx: MintContext,
  connection: Connection | null
): Promise<RiskAssessment> {
  const tags: string[] = [];
  const reasons: string[] = [];
  let score = 50; // neutral baseline

  const mint = ctx.mint;

  // 1. Obvious special cases
  if (mint === "So11111111111111111111111111111111111111112") {
    // Native SOL "mint"
    score = 10;
    tags.push("NATIVE_SOL");
    reasons.push("This is the wrapped SOL mint, not a memecoin.");
    return buildResult(mint, score, tags, reasons);
  }

  // Pump.fun-style mint naming pattern
  if (mint.endsWith("pump")) {
    tags.push("PUMP_FUN_STYLE");
    reasons.push("Mint address ends with 'pump' (pump.fun style mint).");
    score += 10;
  }

  // If no RPC, we can only do string-based heuristics
  if (!connection) {
    tags.push("NO_RPC");
    reasons.push("RPC_ENDPOINT not set; on-chain metadata not checked.");
    return buildResult(mint, score, tags, reasons);
  }

  // 2. Chain-based heuristics via parsed mint info
  const info = await fetchMintInfo(connection, mint);

  if (!info) {
    score += 20;
    tags.push("MINT_UNKNOWN");
    reasons.push("Mint account not found or not SPL Token mint.");
    return buildResult(mint, score, tags, reasons);
  }

  const decimals = Number(info.decimals ?? 0);
  const supplyStr = info.supply ?? "0";
  const supply = Number(supplyStr);
  const mintAuthority = info.mintAuthority ?? null;
  const freezeAuthority = info.freezeAuthority ?? null;
  const isInitialized = !!info.isInitialized;

  if (!isInitialized) {
    score += 25;
    tags.push("UNINITIALIZED_MINT");
    reasons.push("Mint account is not initialized.");
  }

  // Mint authority / freeze authority
  if (!mintAuthority && !freezeAuthority) {
    score -= 15;
    tags.push("RENOUNCED");
    reasons.push("No mintAuthority or freezeAuthority (looks renounced).");
  } else {
    if (mintAuthority) {
      score += 15;
      tags.push("MINT_AUTHORITY_SET");
      reasons.push("Mint authority is still set (can mint more tokens).");
    }
    if (freezeAuthority) {
      score += 10;
      tags.push("FREEZE_AUTHORITY_SET");
      reasons.push("Freeze authority is set (tokens can potentially be frozen).");
    }
  }

  // Decimals heuristic
  if (decimals === 9) {
    tags.push("DECIMALS_9");
    reasons.push("Standard 9 decimal token (common on Solana).");
  } else if (decimals > 9) {
    score += 10;
    tags.push("WEIRD_DECIMALS");
    reasons.push(`Unusual decimals (${decimals}) – non-standard configuration.`);
  }

  // Supply heuristic (very rough)
  if (supply === 0) {
    score += 20;
    tags.push("ZERO_SUPPLY");
    reasons.push("Total supply is zero; may not be fully launched.");
  }

  return buildResult(mint, score, tags, reasons);
}

function buildResult(
  mint: string,
  rawScore: number,
  tags: string[],
  reasons: string[]
): RiskAssessment {
  const score = Math.max(0, Math.min(100, rawScore));

  let level: RiskLevel = "MEDIUM";
  if (score < 40) level = "LOW";
  else if (score > 70) level = "HIGH";

  return {
    mint,
    score,
    level,
    tags: Array.from(new Set(tags)),
    reasons,
  };
}
