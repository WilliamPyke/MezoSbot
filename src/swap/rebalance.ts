import { config } from "../config.js";
import { TOKEN_SYMBOLS, tokenAmountToUnits, tokenUnitsToAmount, type TokenSymbol } from "../tokens.js";
import { shouldRebalance } from "./policy.js";
import {
  buildBestSwapRoutes,
  computeLegMinimums,
  executeTreasuryRouterSwap,
  quoteRouterAmountsOut,
  routerOutToTokenAmount,
} from "./router.js";
import { getFreeInventory } from "./service.js";
import { treasurySignerAvailable } from "../evm.js";

let rebalanceTimer: ReturnType<typeof setInterval> | null = null;
let rebalanceRunning = false;

/**
 * MEZO is excluded from protocol rebalancing (neither bought nor sold) until
 * explicitly enabled. Planned config: SWAP_REBALANCE_MEZO_ENABLED (default false).
 */
export const REBALANCE_MEZO_ENABLED = false;
/** Slippage applied to every rebalance leg (bps). */
const REBALANCE_SLIPPAGE_BPS = 100;

/** Tokens the rebalance worker may buy or sell (exported for tests). */
export function rebalanceTokens(mezoEnabled: boolean = REBALANCE_MEZO_ENABLED): TokenSymbol[] {
  return TOKEN_SYMBOLS.filter((t) => mezoEnabled || t !== "MEZO");
}

function minFreeFor(token: TokenSymbol): number {
  if (token === "SATS") return config.swap.rebalanceMinFreeSats;
  if (token === "MUSD") return config.swap.rebalanceMinFreeMusd;
  if (token === "MUSDC") return config.swap.rebalanceMinFreeMusdc;
  if (token === "MEZO") return REBALANCE_MEZO_ENABLED ? config.swap.rebalanceMinFreeMezo : 0;
  const _exhaustive: never = token;
  return _exhaustive;
}

function probeSize(token: TokenSymbol, free: number): number {
  if (token === "SATS") return Math.min(free * 0.1, 50_000);
  if (token === "MEZO") return Math.min(free * 0.1, 5_000);
  return Math.min(free * 0.1, 25);
}

function minProbe(token: TokenSymbol): number {
  if (token === "SATS") return 1_000;
  if (token === "MEZO") return 10;
  return 1;
}

/**
 * Protocol-owned inventory rebalance: when free inventory of a swappable
 * token is short and another has excess, run a small on-chain swap from the
 * long asset into the short one. Never touches user balances.
 */
export async function runInventoryRebalance(): Promise<void> {
  if (!config.swap.enabled || !config.swap.rebalanceEnabled) return;
  // Rebalancing signs with the treasury key: legacy mode only.
  if (!treasurySignerAvailable()) return;
  if (rebalanceRunning) return;
  rebalanceRunning = true;
  try {
    const { supabase } = await import("../db.js");
    const { count } = await supabase
      .from("swaps")
      .select("id", { count: "exact", head: true })
      .in("status", ["reserved", "submitted"]);
    if ((count ?? 0) > 0) {
      console.log(`[Swap rebalance] skip: ${count} in-flight user swap(s)`);
      return;
    }

    const tokens: TokenSymbol[] = rebalanceTokens();
    const free = Object.fromEntries(
      await Promise.all(tokens.map(async (t) => [t, await getFreeInventory(t)] as const)),
    ) as Partial<Record<TokenSymbol, Awaited<ReturnType<typeof getFreeInventory>>>>;

    const minFree = Object.fromEntries(
      tokens.map((t) => [t, minFreeFor(t)] as const),
    ) as Partial<Record<TokenSymbol, number>>;

    for (const short of tokens) {
      for (const long of tokens) {
        if (short === long) continue;
        const minLong = minFree[long]! * 2;
        if (
          !shouldRebalance({
            freeShort: free[short]!.free,
            minFree: minFree[short]!,
            freeLong: free[long]!.free,
            minLongExcess: minLong,
          })
        ) {
          continue;
        }

        const shortfall = Math.max(0, minFree[short]! - free[short]!.free);
        if (shortfall <= 0) continue;

        let probeFrom = probeSize(long, free[long]!.free);
        probeFrom = Math.max(probeFrom, minProbe(long));
        if (probeFrom > free[long]!.free * 0.25) continue;

        let routes;
        try {
          routes = await buildBestSwapRoutes(long, short, probeFrom);
        } catch {
          continue;
        }

        let quote;
        try {
          quote = await quoteRouterAmountsOut(long, short, probeFrom, routes);
        } catch (err) {
          console.warn(`[Swap rebalance] quote ${long}→${short} failed:`, (err as Error).message);
          continue;
        }
        const probeOut = routerOutToTokenAmount(quote.amountOut, short);
        if (probeOut <= 0) continue;

        const scale = Math.min(shortfall / probeOut, (free[long]!.free * 0.25) / probeFrom);
        if (scale <= 0) continue;
        const fromAmount = probeFrom * Math.min(scale, 1);
        if (fromAmount <= 0) continue;

        const live = await quoteRouterAmountsOut(long, short, fromAmount, routes);
        const amountIn = tokenAmountToUnits(fromAmount, long);
        const legMinOuts = computeLegMinimums(live.legOuts, REBALANCE_SLIPPAGE_BPS);
        const minOut = legMinOuts[legMinOuts.length - 1]!;

        console.log(
          `[Swap rebalance] ${fromAmount} ${long} → ${short} (short free=${free[short]!.free})`,
        );
        const result = await executeTreasuryRouterSwap({
          fromToken: long,
          toToken: short,
          amountIn,
          amountOutMin: minOut,
          routes,
          legMinOuts,
        });
        if (!result.confirmed) {
          console.warn(`[Swap rebalance] failed: ${result.error}`);
          return;
        }
        console.log(
          `[Swap rebalance] ok tx=${result.txHash} out≈${tokenUnitsToAmount(result.amountOut, short)} ${short}`,
        );
        return;
      }
    }
  } finally {
    rebalanceRunning = false;
  }
}

export function startSwapRebalanceWorker(): void {
  if (!config.swap.enabled || !config.swap.rebalanceEnabled) return;
  if (rebalanceTimer) return;
  const interval = Math.max(60_000, config.swap.rebalanceIntervalMs);
  rebalanceTimer = setInterval(() => {
    runInventoryRebalance().catch((err) =>
      console.warn("[Swap rebalance] tick failed:", (err as Error)?.message ?? err),
    );
  }, interval);
  setTimeout(() => {
    runInventoryRebalance().catch(() => {});
  }, 60_000);
  console.log(`[Swap rebalance] worker every ${interval}ms`);
}
