import type { TokenSymbol } from "../tokens.js";
import type { MezoRouteHop } from "./types.js";

/** Mezo native BTC system token used by Mezo Pools (dual of native gas BTC). */
export const MEZO_BTC_TOKEN = "0x7b7C000000000000000000000000000000000000";

/** Mainnet defaults (overridable via env). */
export const DEFAULT_POOL_FACTORY = "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248";
export const DEFAULT_ROUTER = "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706";

export function getPoolFactory(): string {
  // Prefer env; config.swap.poolFactory is the same default when config is loaded.
  return process.env.MEZO_POOLS_FACTORY?.trim() || DEFAULT_POOL_FACTORY;
}

export function getRouterAddress(): string {
  return process.env.MEZO_POOLS_ROUTER?.trim() || DEFAULT_ROUTER;
}

/**
 * Tokens that can be swapped via Mezo Pools (direct or multi-hop).
 * MEZO is intentionally excluded until a liquid pool exists.
 */
export const SWAPPABLE_TOKENS: readonly TokenSymbol[] = ["SATS", "MUSD", "MUSDC"];

export function isSwappableToken(symbol: TokenSymbol): boolean {
  return (SWAPPABLE_TOKENS as readonly string[]).includes(symbol);
}

function tokenAddr(symbol: TokenSymbol): string {
  if (symbol === "SATS") return MEZO_BTC_TOKEN;
  if (symbol === "MUSD") {
    return process.env.MUSD_TOKEN_CONTRACT?.trim() || "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
  }
  if (symbol === "MUSDC") {
    return process.env.MUSDC_TOKEN_CONTRACT?.trim() || "0x04671C72Aab5AC02A03c1098314b1BB6B560c197";
  }
  throw new Error(`No on-chain pool token address for ${symbol}`);
}

/**
 * Build the hop path for a from→to swap on Mezo basic pools.
 * Known pools: BTC/MUSD volatile, MUSD/mUSDC stable.
 */
export function buildSwapRoutes(from: TokenSymbol, to: TokenSymbol): MezoRouteHop[] {
  if (from === to) throw new Error("Cannot swap a token for itself");
  if (!isSwappableToken(from) || !isSwappableToken(to)) {
    throw new Error(`No on-chain route for ${from} → ${to}`);
  }

  const factory = getPoolFactory();
  const fromAddr = tokenAddr(from);
  const toAddr = tokenAddr(to);
  const musd = tokenAddr("MUSD");

  if (
    (from === "SATS" && to === "MUSD") ||
    (from === "MUSD" && to === "SATS")
  ) {
    return [{ from: fromAddr, to: toAddr, stable: false, factory }];
  }
  if (
    (from === "MUSD" && to === "MUSDC") ||
    (from === "MUSDC" && to === "MUSD")
  ) {
    return [{ from: fromAddr, to: toAddr, stable: true, factory }];
  }

  if (from === "SATS" && to === "MUSDC") {
    return [
      { from: fromAddr, to: musd, stable: false, factory },
      { from: musd, to: toAddr, stable: true, factory },
    ];
  }
  if (from === "MUSDC" && to === "SATS") {
    return [
      { from: fromAddr, to: musd, stable: true, factory },
      { from: musd, to: toAddr, stable: false, factory },
    ];
  }

  throw new Error(`No on-chain route for ${from} → ${to}`);
}

export function routeStableDefaultSlippageBps(routes: MezoRouteHop[]): number {
  if (routes.length === 0) return 100;
  return routes.every((r) => r.stable) ? 50 : 100;
}
