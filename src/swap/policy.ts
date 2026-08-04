import type { TokenSymbol } from "../tokens.js";
import type { SwapMode } from "./types.js";

export type InventorySnapshot = {
  onchain: number;
  liabilities: number;
  /** Free units that can still be promised to users without going insolvent. */
  free: number;
};

export type HybridDecision = {
  preferredMode: SwapMode;
  canInternal: boolean;
  canOnchain: boolean;
  reason: string;
};

/**
 * Free inventory after liabilities and a protected sats gas reserve.
 * Never negative.
 */
export function computeFreeInventory(
  onchain: number,
  liabilities: number,
  options: { token: TokenSymbol; gasReserveSats: number },
): InventorySnapshot {
  const reserve = options.token === "SATS" ? Math.max(0, options.gasReserveSats) : 0;
  const free = onchain - liabilities - reserve;
  return {
    onchain,
    liabilities,
    free: free > 0 ? free : 0,
  };
}

/**
 * Internal path is allowed only when free inventory covers the full output
 * with a safety buffer (default: use at most maxInternalFraction of free).
 */
export function canFillInternally(
  freeInventory: number,
  requiredOut: number,
  maxInternalFraction: number,
  maxInternalAbsolute: number,
): boolean {
  if (requiredOut <= 0 || freeInventory <= 0) return false;
  if (requiredOut > maxInternalAbsolute) return false;
  const usable = freeInventory * clamp01(maxInternalFraction);
  return requiredOut <= usable + 1e-12;
}

export function decideHybridMode(input: {
  requiredOut: number;
  freeInventory: number;
  hasOnchainRoute: boolean;
  maxInternalFraction: number;
  maxInternalAbsolute: number;
  forceOnchain?: boolean;
}): HybridDecision {
  const canInternal =
    !input.forceOnchain &&
    canFillInternally(
      input.freeInventory,
      input.requiredOut,
      input.maxInternalFraction,
      input.maxInternalAbsolute,
    );
  const canOnchain = input.hasOnchainRoute;

  if (canInternal) {
    return {
      preferredMode: "internal",
      canInternal: true,
      canOnchain,
      reason: "treasury inventory sufficient",
    };
  }
  if (canOnchain) {
    return {
      preferredMode: "onchain",
      canInternal: false,
      canOnchain: true,
      reason: canInternal === false && input.freeInventory > 0
        ? "inventory below internal threshold; using on-chain pool"
        : "no spare inventory; using on-chain pool",
    };
  }
  return {
    preferredMode: "internal",
    canInternal: false,
    canOnchain: false,
    reason: "insufficient inventory and no on-chain route",
  };
}

/** amountOutMin from quoted out and slippage bps. */
export function applySlippageMinOut(quotedOut: number, slippageBps: number): number {
  const bps = Math.min(Math.max(0, slippageBps), 5_000);
  return quotedOut * (1 - bps / 10_000);
}

/** Optional haircut on internal fills so inventory is not arbed at mid. */
export function applyInternalHaircut(quotedOut: number, haircutBps: number): number {
  const bps = Math.min(Math.max(0, haircutBps), 1_000);
  return quotedOut * (1 - bps / 10_000);
}

export function withinDailyLimits(input: {
  swapCount: number;
  volumeSatsProxy: number;
  maxSwapsPerDay: number;
  maxVolumeSatsPerDay: number;
  nextVolumeSats: number;
}): { ok: true } | { ok: false; reason: string } {
  if (input.swapCount >= input.maxSwapsPerDay) {
    return { ok: false, reason: `Daily swap limit reached (${input.maxSwapsPerDay}/day).` };
  }
  if (input.volumeSatsProxy + input.nextVolumeSats > input.maxVolumeSatsPerDay + 1e-9) {
    return {
      ok: false,
      reason: `Daily swap volume limit would be exceeded.`,
    };
  }
  return { ok: true };
}

export function quoteNotExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() > now.getTime();
}

/** Approximate from-side notional in sats for volume accounting. */
export function volumeSatsProxy(fromToken: TokenSymbol, fromAmount: number, quotedToSatsIfKnown?: number): number {
  if (fromToken === "SATS") return fromAmount;
  if (quotedToSatsIfKnown != null && quotedToSatsIfKnown > 0) return quotedToSatsIfKnown;
  // Stablecoins ≈ $1; without BTC price use a conservative placeholder only for limits.
  // Callers should pass quotedToSatsIfKnown when swapping into/out of SATS.
  return fromAmount * 100_000; // ~$1 → 100k sats proxy if BTC ~$100k
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Whether a background rebalance should run for a short token.
 * Rebalance when free inventory falls below minFree and another token has excess.
 */
export function shouldRebalance(input: {
  freeShort: number;
  minFree: number;
  freeLong: number;
  minLongExcess: number;
}): boolean {
  return input.freeShort < input.minFree && input.freeLong >= input.minLongExcess;
}
