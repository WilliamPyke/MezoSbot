import { config } from "../config.js";
import { tokenAmountToUnits, tokenUnitsToAmount, type TokenSymbol } from "../tokens.js";
import { shouldRebalance } from "./policy.js";
import { buildSwapRoutes } from "./routes.js";
import {
  executeTreasuryRouterSwap,
  quoteRouterAmountsOut,
  routerOutToTokenAmount,
} from "./router.js";
import { getFreeInventory } from "./service.js";

let rebalanceTimer: ReturnType<typeof setInterval> | null = null;
let rebalanceRunning = false;

/**
 * Protocol-owned inventory rebalance: when free MUSD/mUSDC/SATS is short and
 * another swappable asset has excess free inventory, run a small on-chain swap
 * from the long asset into the short one. Never touches user balances.
 */
export async function runInventoryRebalance(): Promise<void> {
  if (!config.swap.enabled || !config.swap.rebalanceEnabled) return;
  if (rebalanceRunning) return;
  rebalanceRunning = true;
  try {
    // Skip while any user swap is in-flight so free inventory / nonce stay clean.
    const { supabase } = await import("../db.js");
    const { count } = await supabase
      .from("swaps")
      .select("id", { count: "exact", head: true })
      .in("status", ["reserved", "submitted"]);
    if ((count ?? 0) > 0) {
      console.log(`[Swap rebalance] skip: ${count} in-flight user swap(s)`);
      return;
    }

    const tokens: TokenSymbol[] = ["SATS", "MUSD", "MUSDC"];
    const free = Object.fromEntries(
      await Promise.all(tokens.map(async (t) => [t, await getFreeInventory(t)] as const)),
    ) as Record<TokenSymbol, Awaited<ReturnType<typeof getFreeInventory>>>;

    const minFree: Record<TokenSymbol, number> = {
      SATS: config.swap.rebalanceMinFreeSats,
      MUSD: config.swap.rebalanceMinFreeMusd,
      MEZO: Number.POSITIVE_INFINITY,
      MUSDC: config.swap.rebalanceMinFreeMusdc,
    };

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

        // Size: up to 25% of long free, capped so we don't blow through shortfall.
        const shortfall = Math.max(0, minFree[short]! - free[short]!.free);
        if (shortfall <= 0) continue;

        // Estimate long→short rate with a probe quote.
        let probeFrom: number;
        if (long === "SATS") probeFrom = Math.min(free[long]!.free * 0.1, 50_000);
        else probeFrom = Math.min(free[long]!.free * 0.1, 25);
        probeFrom = Math.max(probeFrom, long === "SATS" ? 1_000 : 1);
        if (probeFrom > free[long]!.free * 0.25) continue;

        let routes;
        try {
          routes = buildSwapRoutes(long, short);
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

        // Scale probe toward shortfall (but stay within 25% of long free).
        const scale = Math.min(shortfall / probeOut, (free[long]!.free * 0.25) / probeFrom);
        if (scale <= 0) continue;
        const fromAmount = probeFrom * Math.min(scale, 1);
        if (fromAmount <= 0) continue;

        const live = await quoteRouterAmountsOut(long, short, fromAmount, routes);
        const amountIn = tokenAmountToUnits(fromAmount, long);
        // Tight minOut for protocol rebalance — 1% slippage.
        const minOut = (live.amountOut * 99n) / 100n;

        console.log(
          `[Swap rebalance] ${fromAmount} ${long} → ${short} (short free=${free[short]!.free})`,
        );
        const result = await executeTreasuryRouterSwap({
          fromToken: long,
          toToken: short,
          amountIn,
          amountOutMin: minOut,
          routes,
        });
        if (!result.confirmed) {
          console.warn(`[Swap rebalance] failed: ${result.error}`);
          return;
        }
        console.log(
          `[Swap rebalance] ok tx=${result.txHash} out≈${tokenUnitsToAmount(result.amountOut, short)} ${short}`,
        );
        return; // one rebalance hop per tick
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
  // First pass after boot settles.
  setTimeout(() => {
    runInventoryRebalance().catch(() => {});
  }, 60_000);
  console.log(`[Swap rebalance] worker every ${interval}ms`);
}
