import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { checkSatsExitSolvency, getTokenBalance, getTreasuryAddress, getTreasuryBalances, isTreasuryCompromised } from "../evm.js";
import { roundSats } from "../format.js";
import { recordLedgerEntry } from "../ledger.js";
import {
  floorTokenAmount,
  formatTokenAmount,
  roundTokenAmount,
  tokenAmountToUnits,
  tokenUnitsToAmount,
  TOKEN_SYMBOLS,
  type TokenSymbol,
} from "../tokens.js";
import {
  applyInternalHaircut,
  applySlippageMinOut,
  computeFreeInventory,
  decideHybridMode,
  quoteNotExpired,
  volumeSatsProxy,
  withinDailyLimits,
} from "./policy.js";
import { checkInternalFillPrice, MEZO_MAX_INTERNAL_OUT } from "./priceGuard.js";
import {
  assessMissingReceipt,
  eligibleForRecovery,
  ESCROWED_SWAP_STATUSES,
  progressMeta,
  RECOVERABLE_SWAP_STATUSES,
  RECOVERY_LEASE_MS,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_STALE_MS,
  recoveryAttemptAllowed,
  recoverySnapshotUnchanged,
  sumInventoryHolds,
  type SwapProgressMeta,
} from "./recovery.js";
import {
  groupSwapLegs,
  hopTokenOut,
  isSwappableToken,
  parseRouteHops,
  poolTokenAddress,
  remainingHops,
  routeStableDefaultSlippageBps,
  symbolForPoolToken,
} from "./routes.js";
import {
  buildBestSwapRoutes,
  computeLegMinimums,
  executeTreasuryRouterSwap,
  executeTreasuryRouterSwapUnlocked,
  getTransactionByHash,
  getTreasuryNonce,
  inspectSwapReceipt,
  quoteRouteUnits,
  quoteRouterAmountsOut,
  quoteSwapGasSats,
  routerOutToTokenAmount,
  withTreasurySwapLock,
  type ExecuteSwapOptions,
  type RouterQuote,
} from "./router.js";
import type { ExecuteSwapResult, MezoRouteHop, SwapQuote, SwapRow } from "./types.js";

function maxInternalAbsolute(toToken: TokenSymbol): number {
  if (toToken === "SATS") return config.swap.maxInternalOutSats;
  if (toToken === "MUSD") return config.swap.maxInternalOutMusd;
  if (toToken === "MUSDC") return config.swap.maxInternalOutMusdc;
  // Safe default until config.swap.maxInternalOutMezo defaults to 0 (see priceGuard.ts).
  if (toToken === "MEZO") return Math.min(config.swap.maxInternalOutMezo, MEZO_MAX_INTERNAL_OUT);
  const _exhaustive: never = toToken;
  return _exhaustive;
}

function minFromAmount(fromToken: TokenSymbol): number {
  if (fromToken === "SATS") return config.swap.minFromSats;
  if (fromToken === "MUSD") return config.swap.minFromMusd;
  if (fromToken === "MUSDC") return config.swap.minFromMusdc;
  if (fromToken === "MEZO") return config.swap.minFromMezo;
  const _exhaustive: never = fromToken;
  return _exhaustive;
}

async function getLiabilities(): Promise<Record<TokenSymbol, number>> {
  const { data, error } = await supabase.rpc("get_token_liabilities");
  if (error) throw error;
  const row = (data ?? {}) as Record<string, string>;
  // Includes user balances, prize pool, and in-flight swap escrow (reserved/submitted).
  return {
    SATS: Number(row.SATS ?? 0),
    MUSD: Number(row.MUSD ?? 0),
    MEZO: Number(row.MEZO ?? 0),
    MUSDC: Number(row.MUSDC ?? 0),
  };
}

function tokenOutAddress(symbol: TokenSymbol): string {
  return poolTokenAddress(symbol);
}

function readTxHashes(metadata: Record<string, unknown> | null | undefined, fallback: string | null): string[] {
  const raw = metadata?.tx_hashes;
  if (Array.isArray(raw)) {
    return raw.filter((h): h is string => typeof h === "string" && h.length > 0);
  }
  if (fallback) return fallback.split(",").map((h) => h.trim()).filter(Boolean);
  return [];
}

async function volumeSatsForQuote(input: {
  fromToken: TokenSymbol;
  toToken: TokenSymbol;
  fromAmount: number;
  marketOut: number;
}): Promise<number> {
  if (input.fromToken === "SATS") return input.fromAmount;
  if (input.toToken === "SATS") return input.marketOut;
  try {
    const routes = await buildBestSwapRoutes(input.fromToken, "SATS", input.fromAmount);
    const quote = await quoteRouterAmountsOut(input.fromToken, "SATS", input.fromAmount, routes);
    const sats = routerOutToTokenAmount(quote.amountOut, "SATS");
    if (sats > 0) return sats;
  } catch {
    // fall through
  }
  return volumeSatsProxy(input.fromToken, input.fromAmount);
}

/** Inventory held by in-flight swaps (intermediate leg outputs / uncredited outputs). */
async function getInventoryHolds(token: TokenSymbol): Promise<number> {
  const { data, error } = await supabase
    .from("swaps")
    .select("status, metadata")
    .in("status", [...ESCROWED_SWAP_STATUSES]);
  if (error) throw error;
  return sumInventoryHolds((data ?? []) as Array<Pick<SwapRow, "status" | "metadata">>, token);
}

/**
 * Free inventory. `onchain` in the snapshot is the treasury balance minus
 * inventory held by in-flight multi-leg swaps, so internal fills (which pass
 * it as p_onchain_to) can never consume another swap's intermediate tokens.
 * Balance is read before holds: a hold is written before its leg broadcasts,
 * so the ordering can only over-reserve, never under-reserve.
 */
export async function getFreeInventory(token: TokenSymbol): Promise<ReturnType<typeof computeFreeInventory>> {
  const onchainUnits = await getTokenBalance(getTreasuryAddress(), token);
  const [liabilities, holds] = await Promise.all([getLiabilities(), getInventoryHolds(token)]);
  const onchain = Math.max(0, tokenUnitsToAmount(onchainUnits, token) - holds);
  return computeFreeInventory(onchain, liabilities[token] ?? 0, {
    token,
    gasReserveSats: config.evm.protocolGasReserveMinSats,
  });
}

async function getDailyVolume(discordId: string): Promise<{ swap_count: number; volume_sats_proxy: number }> {
  const { data, error } = await supabase.rpc("get_swap_daily_volume", { p_discord_id: discordId });
  if (error) throw error;
  const row = (data ?? {}) as { swap_count?: number; volume_sats_proxy?: number };
  return {
    swap_count: Number(row.swap_count ?? 0),
    volume_sats_proxy: Number(row.volume_sats_proxy ?? 0),
  };
}

export async function createSwapQuote(input: {
  discordId: string;
  fromToken: TokenSymbol;
  toToken: TokenSymbol;
  fromAmount: number;
  slippageBps?: number | null;
  forceOnchain?: boolean;
  guildId?: string | null;
}): Promise<SwapQuote> {
  if (!config.swap.enabled) throw new Error("Swaps are temporarily disabled.");

  const fromToken = input.fromToken;
  const toToken = input.toToken;
  if (fromToken === toToken) throw new Error("Choose two different tokens.");
  if (!isSwappableToken(fromToken) || !isSwappableToken(toToken)) {
    throw new Error("Unsupported swap token.");
  }

  const fromAmount = roundTokenAmount(input.fromAmount, fromToken);
  if (fromAmount < minFromAmount(fromToken)) {
    throw new Error(`Minimum swap is ${formatTokenAmount(minFromAmount(fromToken), fromToken)}.`);
  }

  let slippageBps = input.slippageBps ?? config.swap.defaultSlippageBps;
  if (slippageBps < 0) slippageBps = 0;
  if (slippageBps > config.swap.maxSlippageBps) {
    throw new Error(`Slippage cannot exceed ${config.swap.maxSlippageBps / 100}%.`);
  }

  const routes = await buildBestSwapRoutes(fromToken, toToken, fromAmount);
  if (slippageBps === config.swap.defaultSlippageBps) {
    slippageBps = Math.max(slippageBps, routeStableDefaultSlippageBps(routes));
  }

  const routerQuote = await quoteRouterAmountsOut(fromToken, toToken, fromAmount, routes);
  const marketOut = routerOutToTokenAmount(routerQuote.amountOut, toToken);
  if (marketOut <= 0) throw new Error("Quoted output is too small.");

  const internalOut = floorTokenAmount(
    applyInternalHaircut(marketOut, config.swap.internalHaircutBps),
    toToken,
  );
  const minToAmount = floorTokenAmount(applySlippageMinOut(marketOut, slippageBps), toToken);
  if (minToAmount <= 0) throw new Error("Minimum output is zero after slippage — increase amount.");

  const free = await getFreeInventory(toToken);
  const priceCheck = checkInternalFillPrice({
    fromToken,
    toToken,
    routes,
    liveRate: marketOut / fromAmount,
  });
  const decision = decideHybridMode({
    requiredOut: internalOut,
    freeInventory: free.free,
    hasOnchainRoute: routes.length > 0,
    maxInternalFraction: config.swap.maxInternalFraction,
    maxInternalAbsolute: maxInternalAbsolute(toToken),
    forceOnchain: input.forceOnchain || !priceCheck.ok,
  });

  if (!decision.canInternal && !decision.canOnchain) {
    throw new Error("Cannot fill this swap: insufficient treasury inventory and no on-chain route.");
  }

  const volProxy = await volumeSatsForQuote({
    fromToken,
    toToken,
    fromAmount,
    marketOut,
  });

  const daily = await getDailyVolume(input.discordId);
  const limits = withinDailyLimits({
    swapCount: daily.swap_count,
    volumeSatsProxy: daily.volume_sats_proxy,
    maxSwapsPerDay: config.swap.maxSwapsPerDay,
    maxVolumeSatsPerDay: config.swap.maxVolumeSatsPerDay,
    nextVolumeSats: volProxy,
  });
  if (!limits.ok) throw new Error(limits.reason);

  let gasReservedSats = 0;
  const preferredMode = decision.preferredMode;
  const fillOut = preferredMode === "internal" ? internalOut : marketOut;
  const fillMin = preferredMode === "internal" ? internalOut : minToAmount;

  if (preferredMode === "onchain") {
    const amountIn = tokenAmountToUnits(fromAmount, fromToken);
    const amountOutMin = tokenAmountToUnits(fillMin, toToken);
    const gasQuote = await quoteSwapGasSats(routes, amountIn, amountOutMin);
    // Pad gas reservation by 25% so fee spikes between quote and confirm still fit.
    gasReservedSats = roundSats(gasQuote.gasSats * 1.25);
  }

  const quoteId = randomUUID();
  const expiresAt = new Date(Date.now() + config.swap.quoteTtlMs);

  const { error } = await supabase.from("swaps").insert({
    quote_id: quoteId,
    discord_id: input.discordId,
    from_token: fromToken,
    to_token: toToken,
    from_amount: fromAmount,
    quoted_to_amount: fillOut,
    min_to_amount: fillMin,
    mode: preferredMode,
    status: "quoted",
    gas_reserved_sats: gasReservedSats,
    route_json: routes,
    quote_expires_at: expiresAt.toISOString(),
    guild_id: input.guildId ?? null,
    metadata: {
      market_out: marketOut,
      internal_out: internalOut,
      free_inventory_to: free.free,
      decision: decision.reason,
      internal_price_check: priceCheck.ok ? "ok" : priceCheck.reason,
      slippage_bps: slippageBps,
      volume_sats_proxy: volProxy,
      force_onchain: !!input.forceOnchain,
    },
  });
  if (error) throw error;

  const rate =
    fromAmount > 0
      ? `${formatTokenAmount(1, fromToken)} ≈ ${formatTokenAmount(fillOut / fromAmount, toToken)}`
      : "n/a";

  return {
    quoteId,
    discordId: input.discordId,
    fromToken,
    toToken,
    fromAmount,
    quotedToAmount: fillOut,
    minToAmount: fillMin,
    mode: preferredMode,
    preferredMode,
    canInternal: decision.canInternal,
    canOnchain: decision.canOnchain,
    gasReservedSats,
    routes,
    expiresAt,
    volumeSatsProxy: volProxy,
    freeInventoryTo: free.free,
    slippageBps,
    rateLabel: rate,
  };
}

async function loadSwap(quoteId: string): Promise<SwapRow | null> {
  const { data, error } = await supabase
    .from("swaps")
    .select("*")
    .eq("quote_id", quoteId)
    .maybeSingle();
  if (error) throw error;
  return data as SwapRow | null;
}

export async function cancelSwapQuote(quoteId: string, discordId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("cancel_swap_quote", {
    p_quote_id: quoteId,
    p_discord_id: discordId,
  });
  if (error) throw error;
  return data === "ok";
}

export async function executeSwapQuote(
  quoteId: string,
  discordId: string,
  client: Parameters<typeof recordLedgerEntry>[0],
): Promise<ExecuteSwapResult> {
  const row = await loadSwap(quoteId);
  if (!row) return { ok: false, error: "Quote not found.", code: "not_found" };
  if (row.discord_id !== discordId) return { ok: false, error: "This quote belongs to another user.", code: "forbidden" };
  if (row.status === "completed") {
    return {
      ok: true,
      mode: row.mode,
      fromToken: row.from_token,
      toToken: row.to_token,
      fromAmount: row.from_amount,
      receivedToAmount: row.received_to_amount ?? row.quoted_to_amount,
      gasActualSats: row.gas_actual_sats ?? 0,
      gasRefundedSats: row.gas_refunded_sats ?? 0,
      txHash: row.tx_hash ?? undefined,
      quoteId,
    };
  }
  if (row.status !== "quoted") {
    return { ok: false, error: `Swap is already ${row.status}.`, code: "bad_status" };
  }
  if (!quoteNotExpired(new Date(row.quote_expires_at))) {
    await supabase.from("swaps").update({
      status: "cancelled",
      error_message: "expired",
      updated_at: new Date().toISOString(),
    }).eq("quote_id", quoteId).eq("status", "quoted");
    return { ok: false, error: "Quote expired. Run /swap again.", code: "expired" };
  }

  // Combat lock: SATS is HP in SatQuest — block mid-fight drains.
  if (row.from_token === "SATS" || row.to_token === "SATS") {
    const { data: sq } = await supabase
      .from("sat_players")
      .select("state")
      .eq("discord_id", discordId)
      .maybeSingle();
    if (sq?.state === "combat") {
      return { ok: false, error: "You can't swap SATS mid-combat in SatQuest.", code: "combat" };
    }
  }

  // Concurrent in-flight swaps for this user.
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: inflight } = await supabase
    .from("swaps")
    .select("id")
    .eq("discord_id", discordId)
    .in("status", ["reserved", "submitted"])
    .gte("created_at", tenMinAgo)
    .limit(1)
    .maybeSingle();
  if (inflight) {
    return { ok: false, error: "You already have a swap in progress. Please wait.", code: "inflight" };
  }

  const volumeProxy = Number((row.metadata as { volume_sats_proxy?: number })?.volume_sats_proxy ?? 0);
  const daily = await getDailyVolume(discordId);
  const limits = withinDailyLimits({
    swapCount: daily.swap_count,
    volumeSatsProxy: daily.volume_sats_proxy,
    maxSwapsPerDay: config.swap.maxSwapsPerDay,
    maxVolumeSatsPerDay: config.swap.maxVolumeSatsPerDay,
    nextVolumeSats: volumeProxy,
  });
  if (!limits.ok) return { ok: false, error: limits.reason, code: "daily_limit" };

  // Re-decide mode at execution using fresh inventory + live quote.
  let routes = parseRouteHops(row.route_json);
  if (!routes.length) routes = await buildBestSwapRoutes(row.from_token, row.to_token, row.from_amount);

  const live = await quoteRouterAmountsOut(row.from_token, row.to_token, row.from_amount, routes);
  const marketOut = routerOutToTokenAmount(live.amountOut, row.to_token);
  const internalOut = floorTokenAmount(
    applyInternalHaircut(marketOut, config.swap.internalHaircutBps),
    row.to_token,
  );
  const free = await getFreeInventory(row.to_token);
  const forceOnchain = !!(row.metadata as { force_onchain?: boolean })?.force_onchain;
  const priceCheck = checkInternalFillPrice({
    fromToken: row.from_token,
    toToken: row.to_token,
    routes,
    liveRate: marketOut / row.from_amount,
  });
  const decision = decideHybridMode({
    requiredOut: internalOut,
    freeInventory: free.free,
    hasOnchainRoute: routes.length > 0,
    maxInternalFraction: config.swap.maxInternalFraction,
    maxInternalAbsolute: maxInternalAbsolute(row.to_token),
    forceOnchain: forceOnchain || !priceCheck.ok,
  });

  if (!decision.canInternal && !decision.canOnchain) {
    return { ok: false, error: "No longer fillable (inventory moved). Try again later.", code: "unfillable" };
  }

  // If price moved so that min_to cannot be met, refuse rather than fill badly.
  if (marketOut + 1e-12 < row.min_to_amount) {
    await supabase.from("swaps").update({
      status: "cancelled",
      error_message: "price_moved",
      updated_at: new Date().toISOString(),
    }).eq("quote_id", quoteId).eq("status", "quoted");
    return {
      ok: false,
      error: `Price moved. You would receive ~${formatTokenAmount(marketOut, row.to_token)} (min ${formatTokenAmount(row.min_to_amount, row.to_token)}).`,
      code: "price_moved",
    };
  }

  if (decision.preferredMode === "internal") {
    return executeInternal(row, internalOut, free.onchain, volumeProxy, client);
  }

  // On-chain legs sign with the treasury key; never with a compromised one.
  if (isTreasuryCompromised()) {
    return {
      ok: false,
      error: "On-chain swap routes are paused during a wallet security upgrade. Nothing was debited.",
      code: "custody_paused",
    };
  }

  // On-chain path spends treasury hot-wallet inventory (not unswept deposit wallets).
  const treasuryFrom = tokenUnitsToAmount(
    await getTokenBalance(getTreasuryAddress(), row.from_token),
    row.from_token,
  );
  if (treasuryFrom + 1e-12 < row.from_amount) {
    return {
      ok: false,
      error:
        `Treasury hot wallet is short ${row.from_token} for an on-chain swap ` +
        `(have ${formatTokenAmount(treasuryFrom, row.from_token)}, need ${formatTokenAmount(row.from_amount, row.from_token)}). ` +
        `Wait for deposit sweeps or try a smaller amount.`,
      code: "treasury_short_from",
    };
  }

  // Native SATS leaving the treasury follows the withdrawal solvency rule:
  // while under-backed, swapping out would let one user exit at full value.
  if (row.from_token === "SATS") {
    const solvency = await checkSatsExitSolvency();
    if (!solvency.ok) {
      return {
        ok: false,
        error: solvency.reason === "underbacked"
          ? "On-chain SATS swaps are paused while the treasury's backing is topped up. Nothing was debited."
          : "Could not verify treasury backing right now. Nothing was debited — try again shortly.",
        code: "sats_backing",
      };
    }
  }

  // If the quote was priced as internal (gas_reserved=0) but we fell back to
  // on-chain at confirm, still charge gas correctly.
  return executeOnchain(row, routes, live, marketOut, volumeProxy, client);
}

function swapMetadata(row: SwapRow): Record<string, unknown> {
  return row.metadata ?? {};
}

function rowSlippageBps(row: SwapRow): number {
  const raw = Number(progressMeta(swapMetadata(row)).slippage_bps);
  return Number.isFinite(raw) && raw >= 0 ? raw : config.swap.defaultSlippageBps;
}

/**
 * Persists live-path / recovery progress onto the swap row: one tx hash per
 * leg index (plus nonce + signed time), legs_completed, last_progress_at, and
 * the inventory hold for the leg output. Every write also bumps updated_at so
 * recovery staleness tracks real progress.
 */
function createProgressTracker(
  row: SwapRow,
  meta: SwapProgressMeta & Record<string, unknown>,
  routes: MezoRouteHop[],
  preHold?: { token: TokenSymbol; amount: number } | null,
): { meta: SwapProgressMeta & Record<string, unknown>; hashes: () => string[]; options: ExecuteSwapOptions } {
  const hashes: string[] = [...(meta.tx_hashes ?? [])];
  meta.legs_total = groupSwapLegs(routes).length;

  const onSigned: ExecuteSwapOptions["onSigned"] = async (txHash, info) => {
    const nowIso = new Date().toISOString();
    hashes[info.legIndex] = txHash;
    hashes.length = info.legIndex + 1;
    meta.tx_hashes = [...hashes];
    meta.tx_nonces = { ...(meta.tx_nonces ?? {}), [txHash]: info.nonce };
    meta.tx_signed_at = { ...(meta.tx_signed_at ?? {}), [txHash]: nowIso };
    meta.legs_completed = info.legIndex;
    meta.last_progress_at = nowIso;
    if (info.legIndex === 0 && preHold && preHold.amount > 0) {
      // Reserve the intermediate output before it exists on-chain.
      meta.held_token = preHold.token;
      meta.held_amount = preHold.amount;
    }
    const { data, error } = await supabase.from("swaps").update({
      status: "submitted",
      tx_hash: hashes[0],
      route_json: routes,
      metadata: meta,
      updated_at: nowIso,
    }).eq("quote_id", row.quote_id).in("status", [...RECOVERABLE_SWAP_STATUSES]).select("id");
    if (error) throw new Error(`Failed to persist swap tx hash: ${error.message}`);
    if (!data?.length) throw new Error("Failed to persist swap tx hash: row not in reserved/submitted");
  };

  const onLegComplete: ExecuteSwapOptions["onLegComplete"] = async (info) => {
    const nowIso = new Date().toISOString();
    meta.legs_completed = info.legIndex + 1;
    meta.last_progress_at = nowIso;
    const heldToken = info.isLast ? row.to_token : symbolForPoolToken(info.tokenOut);
    if (heldToken) {
      meta.held_token = heldToken;
      meta.held_amount = tokenUnitsToAmount(info.amountOut, heldToken);
    }
    const { error } = await supabase.from("swaps").update({
      metadata: meta,
      updated_at: nowIso,
    }).eq("quote_id", row.quote_id).in("status", [...RECOVERABLE_SWAP_STATUSES]);
    if (error) console.error(`[Swap] ${row.quote_id}: failed to persist leg progress: ${error.message}`);
  };

  return { meta, hashes: () => [...hashes], options: { onSigned, onLegComplete } };
}

async function executeInternal(
  row: SwapRow,
  toAmount: number,
  onchainTo: number,
  volumeProxy: number,
  client: Parameters<typeof recordLedgerEntry>[0],
): Promise<ExecuteSwapResult> {
  const { data, error } = await supabase.rpc("execute_internal_swap", {
    p_quote_id: row.quote_id,
    p_discord_id: row.discord_id,
    p_from_token: row.from_token,
    p_to_token: row.to_token,
    p_from_amount: row.from_amount,
    p_to_amount: toAmount,
    p_min_to_amount: toAmount,
    p_onchain_to: onchainTo,
    p_gas_reserve_sats: config.evm.protocolGasReserveMinSats,
    p_volume_sats_proxy: volumeProxy,
  });
  if (error) {
    // Insufficient inventory raises and returns via function; other SQL errors surface here.
    if (error.message?.includes("insufficient_inventory")) {
      return { ok: false, error: "Insufficient treasury inventory for an instant swap.", code: "inventory" };
    }
    throw error;
  }
  if (data === "insufficient_from") {
    return { ok: false, error: "Insufficient balance.", code: "insufficient_from" };
  }
  if (data === "insufficient_inventory") {
    return { ok: false, error: "Insufficient treasury inventory for an instant swap.", code: "inventory" };
  }
  if (data === "quote_unavailable") {
    return { ok: false, error: "Quote is no longer available.", code: "quote_unavailable" };
  }
  if (data !== "ok") {
    return { ok: false, error: `Swap failed (${String(data)}).`, code: String(data) };
  }

  recordLedgerEntry(client, {
    type: "swap",
    amountSats: row.from_amount,
    token: row.from_token,
    senderId: row.discord_id,
    receiverId: "treasury",
    guildId: row.guild_id,
    referenceType: "swaps",
    referenceId: row.quote_id,
    metadata: {
      leg: "from",
      mode: "internal",
      to_token: row.to_token,
      to_amount: toAmount,
    },
  });
  recordLedgerEntry(client, {
    type: "swap",
    amountSats: toAmount,
    token: row.to_token,
    senderId: "treasury",
    receiverId: row.discord_id,
    guildId: row.guild_id,
    referenceType: "swaps",
    referenceId: row.quote_id,
    metadata: {
      leg: "to",
      mode: "internal",
      from_token: row.from_token,
      from_amount: row.from_amount,
    },
  });

  return {
    ok: true,
    mode: "internal",
    fromToken: row.from_token,
    toToken: row.to_token,
    fromAmount: row.from_amount,
    receivedToAmount: toAmount,
    gasActualSats: 0,
    gasRefundedSats: 0,
    quoteId: row.quote_id,
  };
}

async function executeOnchain(
  row: SwapRow,
  routes: MezoRouteHop[],
  live: RouterQuote,
  marketOut: number,
  volumeProxy: number,
  client: Parameters<typeof recordLedgerEntry>[0],
): Promise<ExecuteSwapResult> {
  const amountIn = tokenAmountToUnits(row.from_amount, row.from_token);
  // Re-quote gas with current min out.
  const minOut = Math.min(row.min_to_amount, marketOut);
  const amountOutMin = tokenAmountToUnits(minOut, row.to_token);
  // Intermediate legs: quoted leg output minus the user's slippage (never min=1).
  const legMinOuts = computeLegMinimums(live.legOuts, rowSlippageBps(row), amountOutMin);
  let gasSats = row.gas_reserved_sats;
  try {
    const gasQuote = await quoteSwapGasSats(routes, amountIn, amountOutMin);
    gasSats = roundSats(Math.max(row.gas_reserved_sats, gasQuote.gasSats * 1.25));
  } catch (error) {
    return { ok: false, error: `Unable to estimate swap gas: ${(error as Error).message}`, code: "gas_quote" };
  }

  const { data: reserved, error: reserveError } = await supabase.rpc("reserve_onchain_swap", {
    p_quote_id: row.quote_id,
    p_discord_id: row.discord_id,
    p_from_token: row.from_token,
    p_from_amount: row.from_amount,
    p_gas_sats: gasSats,
    p_quoted_to: marketOut,
    p_min_to: minOut,
  });
  if (reserveError) throw reserveError;
  if (reserved === "insufficient_from" || reserved === "insufficient_from_or_gas") {
    return { ok: false, error: "Insufficient balance for the swap amount and network fee.", code: "insufficient" };
  }
  if (reserved === "insufficient_sats") {
    return {
      ok: false,
      error: `Insufficient sats for the network fee (~${roundSats(gasSats)} sats).`,
      code: "insufficient_sats",
    };
  }
  if (reserved === "quote_unavailable") {
    return { ok: false, error: "Quote is no longer available.", code: "quote_unavailable" };
  }
  if (reserved !== "ok") {
    return { ok: false, error: `Could not reserve swap (${String(reserved)}).`, code: String(reserved) };
  }

  recordLedgerEntry(client, {
    type: "swap",
    amountSats: row.from_amount,
    token: row.from_token,
    senderId: row.discord_id,
    receiverId: "treasury",
    guildId: row.guild_id,
    referenceType: "swaps",
    referenceId: row.quote_id,
    metadata: { leg: "from", mode: "onchain", to_token: row.to_token },
  });
  if (gasSats > 0) {
    recordLedgerEntry(client, {
      type: "swap_network_fee",
      amountSats: gasSats,
      token: "SATS",
      senderId: row.discord_id,
      receiverId: "treasury",
      guildId: row.guild_id,
      referenceType: "swaps",
      referenceId: row.quote_id,
      metadata: { from_token: row.from_token, to_token: row.to_token },
    });
  }

  const legs = groupSwapLegs(routes);
  const firstLegToken = legs.length > 1
    ? symbolForPoolToken(hopTokenOut(legs[0]!.hops[legs[0]!.hops.length - 1]!))
    : null;
  const tracker = createProgressTracker(
    row,
    {
      ...swapMetadata(row),
      tx_hashes: [],
      leg_min_outs: legMinOuts.map((v) => v.toString()),
    },
    routes,
    firstLegToken
      ? { token: firstLegToken, amount: tokenUnitsToAmount(live.legOuts[0]!, firstLegToken) }
      : null,
  );
  // Persist hash before broadcast so crash recovery never refunds an in-flight tx;
  // persist per-leg progress so recovery staleness tracks the live path.
  const result = await executeTreasuryRouterSwap(
    {
      fromToken: row.from_token,
      toToken: row.to_token,
      amountIn,
      amountOutMin,
      routes,
      legMinOuts,
    },
    tracker.options,
  );

  const txHashes = tracker.hashes().length ? tracker.hashes() : result.txHashes;

  // Refund only when no hop has mined successfully.
  const neverBroadcast = !result.txHash && !result.confirmed && result.legsCompleted === 0;
  if ((result.minedRevert && result.legsCompleted === 0) || neverBroadcast) {
    await refundSwap(row.quote_id, result.error ?? "onchain_failed", client, {
      gasActual: result.gasSats,
      txHash: result.txHash || null,
    });
    return {
      ok: false,
      error: result.error ?? "On-chain swap failed.",
      code: "onchain_failed",
    };
  }

  if (result.minedRevert && result.legsCompleted > 0) {
    return {
      ok: false,
      error:
        "A later hop reverted after the first hop mined. " +
        "Your funds stay reserved until recovery finishes the route — do not retry.",
      code: "leg_failed",
    };
  }

  if (!result.confirmed) {
    // Hash known, outcome unknown (timeout / broadcast ambiguity). Leave submitted for recovery.
    return {
      ok: false,
      error:
        "Swap submitted on-chain but not confirmed yet. " +
        "Your funds stay reserved until recovery settles it — do not retry.",
      code: "pending_confirmation",
    };
  }

  // Receipt success: never refund principal. Credit log-derived (or minOut floor) amount.
  let received = routerOutToTokenAmount(result.amountOut, row.to_token);
  if (received <= 0) {
    received = minOut;
    console.warn(`[Swap] ${row.quote_id}: zero parsed out after success; crediting minOut ${minOut}`);
  }

  const { data: creditResult, error: creditError } = await supabase.rpc("credit_swap_output", {
    p_quote_id: row.quote_id,
    p_to_amount: received,
    p_gas_actual_sats: result.gasSats,
    p_tx_hash: result.txHash,
    p_volume_sats_proxy: volumeProxy,
  });
  if (creditError) throw creditError;
  if (creditResult !== "ok" && creditResult !== "ok_with_gas_refund" && creditResult !== "already_credited") {
    // Funds are on treasury; do NOT refund from-token. Recovery will credit.
    console.error(`[Swap] credit_swap_output failed for ${row.quote_id}: ${creditResult}`);
    return {
      ok: false,
      error: "Swap mined but crediting failed — support will resolve. Do not retry.",
      code: "credit_failed",
    };
  }

  const gasRefunded = Math.max(0, gasSats - result.gasSats);
  recordLedgerEntry(client, {
    type: "swap",
    amountSats: received,
    token: row.to_token,
    senderId: "treasury",
    receiverId: row.discord_id,
    guildId: row.guild_id,
    referenceType: "swaps",
    referenceId: row.quote_id,
    metadata: {
      leg: "to",
      mode: "onchain",
      tx_hash: result.txHash,
      from_token: row.from_token,
      from_amount: row.from_amount,
    },
  });
  if (gasRefunded > 0) {
    recordLedgerEntry(client, {
      type: "swap_network_fee_refund",
      amountSats: gasRefunded,
      token: "SATS",
      senderId: "treasury",
      receiverId: row.discord_id,
      guildId: row.guild_id,
      referenceType: "swaps",
      referenceId: row.quote_id,
      metadata: { reason: "unused_gas_reservation" },
    });
  }

  return {
    ok: true,
    mode: "onchain",
    fromToken: row.from_token,
    toToken: row.to_token,
    fromAmount: row.from_amount,
    receivedToAmount: received,
    gasActualSats: result.gasSats,
    gasRefundedSats: gasRefunded,
    txHash: result.txHash,
    txHashes,
    quoteId: row.quote_id,
  };
}

async function refundSwap(
  quoteId: string,
  reason: string,
  client: Parameters<typeof recordLedgerEntry>[0],
  extras?: { gasActual?: number; txHash?: string | null },
): Promise<void> {
  const before = await loadSwap(quoteId);
  const { data, error } = await supabase.rpc("refund_swap_reservation", {
    p_quote_id: quoteId,
    p_reason: reason,
  });
  if (error) {
    console.error(`[Swap] refund failed for ${quoteId}:`, error.message);
    return;
  }
  if (data !== "ok" || !before || before.from_refunded) return;

  if (extras?.txHash) {
    await supabase.from("swaps").update({
      tx_hash: extras.txHash,
      gas_actual_sats: extras.gasActual ?? null,
      updated_at: new Date().toISOString(),
    }).eq("quote_id", quoteId);
  }

  recordLedgerEntry(client, {
    type: "swap_refund",
    amountSats: before.from_amount,
    token: before.from_token,
    senderId: "treasury",
    receiverId: before.discord_id,
    guildId: before.guild_id,
    referenceType: "swaps",
    referenceId: quoteId,
    metadata: { reason, tx_hash: extras?.txHash ?? before.tx_hash },
  });
  if (before.gas_reserved_sats > 0 && !before.gas_settled) {
    recordLedgerEntry(client, {
      type: "swap_network_fee_refund",
      amountSats: before.gas_reserved_sats,
      token: "SATS",
      senderId: "treasury",
      receiverId: before.discord_id,
      guildId: before.guild_id,
      referenceType: "swaps",
      referenceId: quoteId,
      metadata: { reason: "swap_failed_full_gas_refund" },
    });
  }
}

/**
 * Resolve swaps left in reserved/submitted after crashes.
 * Money rules:
 * - no tx_hash after staleness → safe full refund (never broadcast)
 * - mined revert / provably dropped first hop → refund
 * - any hop mined success → never refund principal; finish remaining hops then credit
 * - remaining hops are retried at most RECOVERY_MAX_ATTEMPTS times, never with a
 *   lowered min-out; after that (or on ambiguity) the row goes to needs_review
 * - unknown / mempool → leave pending (bounded by dropped/stuck timeouts)
 *
 * Concurrency: rows are claimed by compare-and-set on updated_at (plus a lease
 * in metadata), then re-read under the in-process treasury swap lock; recovery
 * skips the row if anything moved since the claim. Staleness uses updated_at /
 * last_progress_at, which the live path bumps on every signed tx and mined leg.
 */
export async function recoverPendingSwaps(): Promise<void> {
  const cutoff = new Date(Date.now() - RECOVERY_STALE_MS).toISOString();
  const { data: stale, error } = await supabase
    .from("swaps")
    .select("*")
    .in("status", [...RECOVERABLE_SWAP_STATUSES])
    .lt("updated_at", cutoff);
  if (error) {
    console.warn("[Swap recovery] select failed:", error.message);
    return;
  }

  const now = Date.now();
  const rows = ((stale ?? []) as SwapRow[]).filter((row) => eligibleForRecovery(row, now));
  if (!rows.length) return;
  console.log(`[Swap recovery] ${rows.length} pending swap(s)`);

  for (const row of rows) {
    try {
      await recoverOneSwap(row);
    } catch (err) {
      console.error(`[Swap recovery] ${row.quote_id}:`, (err as Error)?.message ?? err);
    }
  }
}

/** Atomically claim a stale row (CAS on updated_at) and write a recovery lease. */
async function claimSwapForRecovery(row: SwapRow): Promise<SwapRow | null> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const { data, error } = await supabase.from("swaps").update({
    metadata: {
      ...swapMetadata(row),
      recovery_lease_until: new Date(now + RECOVERY_LEASE_MS).toISOString(),
      last_recovery_at: nowIso,
    },
    updated_at: nowIso,
  })
    .eq("quote_id", row.quote_id)
    .in("status", [...RECOVERABLE_SWAP_STATUSES])
    .eq("updated_at", row.updated_at)
    .select("*");
  if (error) throw new Error(`recovery claim failed: ${error.message}`);
  return (data?.[0] as SwapRow | undefined) ?? null;
}

async function recoverOneSwap(stale: SwapRow): Promise<void> {
  const claimed = await claimSwapForRecovery(stale);
  if (!claimed) {
    console.log(`[Swap recovery] ${stale.quote_id}: row changed before claim — skip`);
    return;
  }
  await withTreasurySwapLock(async () => {
    // The live path in this process holds the same lock for its whole route, so
    // after acquiring it the row reflects any progress it made.
    const row = await loadSwap(stale.quote_id);
    if (!row || !recoverySnapshotUnchanged(claimed, row)) {
      console.log(`[Swap recovery] ${stale.quote_id}: row progressed after claim — skip`);
      return;
    }
    await recoverClaimedSwap(row);
  });
}

async function markSwapNeedsReview(
  row: SwapRow,
  meta: SwapProgressMeta & Record<string, unknown>,
  reason: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  meta.needs_review = true;
  meta.needs_review_reason = reason;
  meta.needs_review_at = nowIso;
  console.error(
    `[Swap recovery][ALERT] ${row.quote_id} needs operator review: ${reason} ` +
    `(user=${row.discord_id} ${row.from_amount} ${row.from_token}→${row.to_token}, ` +
    `legs=${meta.legs_completed ?? 0}/${meta.legs_total ?? "?"}, attempts=${meta.recovery_attempts ?? 0}, ` +
    `hashes=${(meta.tx_hashes ?? []).join(",") || "none"}). Funds stay escrowed.`,
  );
  const { error } = await supabase.from("swaps").update({
    status: "needs_review",
    error_message: reason.slice(0, 500),
    metadata: meta,
    updated_at: nowIso,
  }).eq("quote_id", row.quote_id).in("status", [...RECOVERABLE_SWAP_STATUSES]);
  if (!error) return;
  // Pre-migration the status CHECK rejects needs_review: keep status, flag metadata
  // (recovery skips flagged rows, so automation still stops).
  console.error(`[Swap recovery] ${row.quote_id}: needs_review status write failed (${error.message}); flagging metadata`);
  await supabase.from("swaps").update({
    error_message: reason.slice(0, 500),
    metadata: meta,
    updated_at: nowIso,
  }).eq("quote_id", row.quote_id).in("status", [...RECOVERABLE_SWAP_STATUSES]);
}

async function persistRecoveryMeta(row: SwapRow, meta: SwapProgressMeta & Record<string, unknown>): Promise<void> {
  const hashes = meta.tx_hashes ?? [];
  const { error } = await supabase.from("swaps").update({
    tx_hash: hashes[0] ?? row.tx_hash,
    metadata: meta,
    updated_at: new Date().toISOString(),
  }).eq("quote_id", row.quote_id).in("status", [...RECOVERABLE_SWAP_STATUSES]);
  if (error) throw new Error(`recovery metadata write failed: ${error.message}`);
}

/** Classify a hash with no receipt; waits briefly and re-checks the node first. */
async function assessPendingHash(
  row: SwapRow,
  meta: SwapProgressMeta,
  txHash: string,
  firstHop: boolean,
): Promise<ReturnType<typeof assessMissingReceipt>> {
  let tx = await getTransactionByHash(txHash);
  if (tx === null) {
    await new Promise((r) => setTimeout(r, 4000));
    tx = await getTransactionByHash(txHash);
  }
  let latestNonce: number | null = null;
  try {
    latestNonce = await getTreasuryNonce("latest");
  } catch {
    // unknown → nonce rule not applied
  }
  const storedNonce = meta.tx_nonces?.[txHash];
  const txNonce = typeof storedNonce === "number"
    ? storedNonce
    : (tx?.nonce ? Number(BigInt(tx.nonce)) : null);
  const signedAt = meta.tx_signed_at?.[txHash] ?? meta.last_progress_at ?? row.created_at;
  const ageMs = Date.now() - new Date(signedAt).getTime();
  return assessMissingReceipt({
    txKnown: tx !== null,
    txMined: !!tx?.blockNumber,
    txNonce,
    latestNonce,
    ageMs,
    firstHop,
  });
}

async function recoverClaimedSwap(row: SwapRow): Promise<void> {
  const meta: SwapProgressMeta & Record<string, unknown> = { ...swapMetadata(row) };
  const hashes = readTxHashes(meta, row.tx_hash);
  if (hashes.length === 0) {
    await refundSwap(row.quote_id, "recovery_no_tx_hash", null);
    console.log(`[Swap recovery] ${row.quote_id}: no tx → refunded`);
    return;
  }

  const routes = parseRouteHops(row.route_json);
  if (!routes.length) {
    await recoverWithoutRoute(row, meta, hashes);
    return;
  }

  const legs = groupSwapLegs(routes);
  meta.legs_total = legs.length;
  if (hashes.length > legs.length) {
    await markSwapNeedsReview(row, meta, `more tx hashes (${hashes.length}) than route legs (${legs.length})`);
    return;
  }

  const amountOutMin = tokenAmountToUnits(row.min_to_amount, row.to_token);
  let completed = 0;
  let lastOut = 0n;
  let lastFromLogs = true;
  let totalGas = 0;

  for (let i = 0; i < hashes.length; i += 1) {
    const hash = hashes[i]!;
    const isFinalLeg = i === legs.length - 1;
    const storedMin = meta.leg_min_outs?.[i];
    const inspected = await inspectSwapReceipt(
      hash,
      tokenOutForLeg(legs, i, row.to_token),
      isFinalLeg ? amountOutMin : (storedMin ? BigInt(storedMin) : 1n),
    );

    if (inspected.status === "pending") {
      const outcome = await assessPendingHash(row, meta, hash, completed === 0);
      if (outcome === "wait") {
        console.log(`[Swap recovery] ${row.quote_id}: hop ${i + 1} pending — leave`);
        return;
      }
      if (outcome === "needs_review") {
        await markSwapNeedsReview(row, meta, `hop ${i + 1} tx ${hash} unconfirmed too long (not provably dropped)`);
        return;
      }
      // Provably dropped.
      if (completed === 0) {
        await refundSwap(row.quote_id, "recovery_tx_dropped", null, { txHash: hash });
        console.log(`[Swap recovery] ${row.quote_id}: first hop dropped → refunded`);
        return;
      }
      console.log(`[Swap recovery] ${row.quote_id}: hop ${i + 1} dropped after prior success — retry remaining`);
      break;
    }

    if (inspected.status === "revert") {
      if (completed === 0) {
        await refundSwap(row.quote_id, "recovery_tx_reverted", null, {
          txHash: hash,
          gasActual: inspected.gasSats,
        });
        console.log(`[Swap recovery] ${row.quote_id}: reverted → refunded`);
        return;
      }
      totalGas += inspected.gasSats;
      console.log(`[Swap recovery] ${row.quote_id}: hop ${i + 1} reverted after prior success — retry remaining`);
      break;
    }

    completed += 1;
    lastOut = inspected.amountOut;
    lastFromLogs = inspected.fromLogs;
    totalGas += inspected.gasSats;
  }

  if (completed < legs.length) {
    // Keep tx_hashes[i] ↔ leg i: move reverted/dropped hashes aside.
    const failed = hashes.slice(completed);
    meta.tx_hashes = hashes.slice(0, completed);
    meta.legs_completed = completed;
    if (failed.length) meta.dropped_tx_hashes = [...(meta.dropped_tx_hashes ?? []), ...failed];

    if (!lastFromLogs) {
      await markSwapNeedsReview(row, meta, `hop ${completed} output unknown (no Transfer logs); cannot size remaining legs`);
      return;
    }
    const attempts = Math.max(0, Math.floor(Number(meta.recovery_attempts ?? 0)));
    if (!recoveryAttemptAllowed(attempts, RECOVERY_MAX_ATTEMPTS)) {
      await markSwapNeedsReview(row, meta, `recovery attempts exhausted (${attempts}/${RECOVERY_MAX_ATTEMPTS})`);
      return;
    }
    meta.recovery_attempts = attempts + 1;
    const lastAttempt = !recoveryAttemptAllowed(attempts + 1, RECOVERY_MAX_ATTEMPTS);
    await persistRecoveryMeta(row, meta);

    const rest = remainingHops(routes, completed);
    let quote: RouterQuote;
    try {
      quote = await quoteRouteUnits(lastOut, rest);
    } catch (err) {
      const reason = `remaining-leg quote failed: ${(err as Error)?.message ?? err}`;
      if (lastAttempt) await markSwapNeedsReview(row, meta, reason);
      else console.warn(`[Swap recovery] ${row.quote_id}: ${reason} (attempt ${attempts + 1}/${RECOVERY_MAX_ATTEMPTS})`);
      return;
    }
    // Never broadcast a leg that cannot meet the user's min (it would revert and burn gas),
    // and never lower the min silently.
    if (quote.amountOut < amountOutMin) {
      const reason =
        `remaining route quotes ${quote.amountOut} < min_to ${amountOutMin} ` +
        `(attempt ${attempts + 1}/${RECOVERY_MAX_ATTEMPTS})`;
      if (lastAttempt) await markSwapNeedsReview(row, meta, reason);
      else console.warn(`[Swap recovery] ${row.quote_id}: ${reason} — not broadcasting`);
      return;
    }

    const legMinOuts = computeLegMinimums(quote.legOuts, rowSlippageBps(row), amountOutMin);
    const tracker = createProgressTracker(row, meta, routes);
    const follow = await executeTreasuryRouterSwapUnlocked(
      {
        fromToken: row.from_token,
        toToken: row.to_token,
        amountIn: lastOut,
        amountOutMin,
        routes: rest,
        legMinOuts,
        legOffset: completed,
      },
      tracker.options,
    );
    totalGas += follow.gasSats;

    if (!follow.confirmed) {
      const reason = `remaining hops not confirmed (${follow.error ?? "pending"})`;
      if (follow.minedRevert && lastAttempt) await markSwapNeedsReview(row, meta, reason);
      else console.log(`[Swap recovery] ${row.quote_id}: ${reason}`);
      return;
    }
    lastOut = follow.amountOut;
    lastFromLogs = follow.fromLogs !== false;
  }

  await creditRecoveredSwap(row, meta.tx_hashes ?? hashes, lastOut, totalGas);
}

/** Legacy / malformed rows with hashes but no route_json. */
async function recoverWithoutRoute(
  row: SwapRow,
  meta: SwapProgressMeta & Record<string, unknown>,
  hashes: string[],
): Promise<void> {
  if (hashes.length !== 1) {
    await markSwapNeedsReview(row, meta, `empty route_json with ${hashes.length} tx hashes`);
    return;
  }
  const hash = hashes[0]!;
  const amountOutMin = tokenAmountToUnits(row.min_to_amount, row.to_token);
  const inspected = await inspectSwapReceipt(hash, tokenOutAddress(row.to_token), amountOutMin);
  if (inspected.status === "pending") {
    const outcome = await assessPendingHash(row, meta, hash, true);
    if (outcome === "dropped") {
      await refundSwap(row.quote_id, "recovery_tx_dropped", null, { txHash: hash });
    } else if (outcome === "needs_review") {
      await markSwapNeedsReview(row, meta, `tx ${hash} unconfirmed too long (empty route_json)`);
    }
    return;
  }
  if (inspected.status === "revert") {
    await refundSwap(row.quote_id, "recovery_tx_reverted", null, { txHash: hash, gasActual: inspected.gasSats });
    return;
  }
  if (!inspected.fromLogs) {
    // Without a route we cannot tell whether this tx delivered the final token.
    await markSwapNeedsReview(row, meta, "empty route_json and no to_token Transfer log in receipt");
    return;
  }
  await creditRecoveredSwap(row, hashes, inspected.amountOut, inspected.gasSats);
}

async function creditRecoveredSwap(
  row: SwapRow,
  hashes: string[],
  lastOut: bigint,
  totalGas: number,
): Promise<void> {
  if (row.to_credited) {
    await supabase.from("swaps").update({
      status: "completed",
      updated_at: new Date().toISOString(),
    }).eq("quote_id", row.quote_id);
    return;
  }

  const creditAmount = Math.max(
    routerOutToTokenAmount(lastOut, row.to_token),
    row.min_to_amount,
  );
  const { data: creditResult } = await supabase.rpc("credit_swap_output", {
    p_quote_id: row.quote_id,
    p_to_amount: creditAmount,
    p_gas_actual_sats: totalGas || row.gas_reserved_sats,
    p_tx_hash: hashes[0],
    p_volume_sats_proxy: Number((row.metadata as { volume_sats_proxy?: number })?.volume_sats_proxy ?? 0),
  });
  console.log(`[Swap recovery] ${row.quote_id}: confirmed → credit ${creditResult}`);
  if (creditResult === "ok" || creditResult === "ok_with_gas_refund") {
    recordLedgerEntry(null, {
      type: "swap",
      amountSats: creditAmount,
      token: row.to_token,
      senderId: "treasury",
      receiverId: row.discord_id,
      referenceType: "swaps",
      referenceId: row.quote_id,
      metadata: { leg: "to", mode: "onchain", recovery: true, tx_hash: hashes[0] },
    });
  }
}

function tokenOutForLeg(
  legs: ReturnType<typeof groupSwapLegs>,
  index: number,
  fallback: TokenSymbol,
): string {
  const leg = legs[index];
  if (!leg) return tokenOutAddress(fallback);
  const hop = leg.hops[leg.hops.length - 1]!;
  return hopTokenOut(hop);
}

/** Periodic recovery for long-lived bot processes. */
export function startSwapRecoveryWorker(intervalMs = 60_000): void {
  setInterval(() => {
    recoverPendingSwaps().catch((err) =>
      console.warn("[Swap recovery] tick failed:", (err as Error)?.message ?? err),
    );
  }, Math.max(30_000, intervalMs));
}

export async function getSwapOperationalSummary(): Promise<{
  free: Record<string, number>;
  treasury: Record<string, number>;
  pending: number;
  needsReview: number;
}> {
  const [treasury, freeSnaps, pendingRes, reviewRes] = await Promise.all([
    getTreasuryBalances(),
    Promise.all(TOKEN_SYMBOLS.map(async (token) => [token, await getFreeInventory(token)] as const)),
    supabase
      .from("swaps")
      .select("id", { count: "exact", head: true })
      .in("status", [...RECOVERABLE_SWAP_STATUSES]),
    supabase
      .from("swaps")
      .select("id", { count: "exact", head: true })
      .eq("status", "needs_review"),
  ]);
  const free: Record<string, number> = {};
  for (const [token, snap] of freeSnaps) free[token] = snap.free;
  return {
    treasury,
    free,
    pending: pendingRes.count ?? 0,
    needsReview: reviewRes.count ?? 0,
  };
}
