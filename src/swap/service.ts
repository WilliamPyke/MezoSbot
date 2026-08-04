import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { getTokenBalance, getTreasuryAddress, getTreasuryBalances } from "../evm.js";
import { roundSats } from "../format.js";
import { recordLedgerEntry } from "../ledger.js";
import {
  floorTokenAmount,
  formatTokenAmount,
  roundTokenAmount,
  tokenAmountToUnits,
  tokenUnitsToAmount,
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
import {
  buildSwapRoutes,
  isSwappableToken,
  MEZO_BTC_TOKEN,
  routeStableDefaultSlippageBps,
} from "./routes.js";
import {
  executeTreasuryRouterSwap,
  inspectSwapReceipt,
  quoteRouterAmountsOut,
  quoteSwapGasSats,
  routerOutToTokenAmount,
} from "./router.js";
import type { ExecuteSwapResult, MezoRouteHop, SwapQuote, SwapRow } from "./types.js";

function maxInternalAbsolute(toToken: TokenSymbol): number {
  if (toToken === "SATS") return config.swap.maxInternalOutSats;
  if (toToken === "MUSD") return config.swap.maxInternalOutMusd;
  if (toToken === "MUSDC") return config.swap.maxInternalOutMusdc;
  return 0;
}

function minFromAmount(fromToken: TokenSymbol): number {
  if (fromToken === "SATS") return config.swap.minFromSats;
  if (fromToken === "MUSD") return config.swap.minFromMusd;
  if (fromToken === "MUSDC") return config.swap.minFromMusdc;
  return Number.POSITIVE_INFINITY;
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
  if (symbol === "SATS") return MEZO_BTC_TOKEN;
  if (symbol === "MUSD") {
    return process.env.MUSD_TOKEN_CONTRACT?.trim() || "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
  }
  if (symbol === "MUSDC") {
    return process.env.MUSDC_TOKEN_CONTRACT?.trim() || "0x04671C72Aab5AC02A03c1098314b1BB6B560c197";
  }
  throw new Error(`No pool token for ${symbol}`);
}

export async function getFreeInventory(token: TokenSymbol): Promise<ReturnType<typeof computeFreeInventory>> {
  const [onchainUnits, liabilities] = await Promise.all([
    getTokenBalance(getTreasuryAddress(), token),
    getLiabilities(),
  ]);
  const onchain = tokenUnitsToAmount(onchainUnits, token);
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
    throw new Error(
      "Only SATS, MUSD, and mUSDC can be swapped right now (Mezo Pools liquidity). MEZO inventory swaps are not enabled.",
    );
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

  const routes = buildSwapRoutes(fromToken, toToken);
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
  const decision = decideHybridMode({
    requiredOut: internalOut,
    freeInventory: free.free,
    hasOnchainRoute: true,
    maxInternalFraction: config.swap.maxInternalFraction,
    maxInternalAbsolute: maxInternalAbsolute(toToken),
    forceOnchain: input.forceOnchain,
  });

  if (!decision.canInternal && !decision.canOnchain) {
    throw new Error("Cannot fill this swap: insufficient treasury inventory and no on-chain route.");
  }

  // Volume proxy: if either side is SATS use that; else approximate via BTC leg when possible.
  let volProxy = volumeSatsProxy(fromToken, fromAmount);
  if (fromToken === "SATS") volProxy = fromAmount;
  else if (toToken === "SATS") volProxy = marketOut;
  else {
    // Stable↔stable: convert via a 1-unit SATS proxy from MUSD pool when possible.
    volProxy = volumeSatsProxy(fromToken, fromAmount);
  }

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
  let routes = (row.route_json ?? []) as MezoRouteHop[];
  if (!routes.length) routes = buildSwapRoutes(row.from_token, row.to_token);

  const live = await quoteRouterAmountsOut(row.from_token, row.to_token, row.from_amount, routes);
  const marketOut = routerOutToTokenAmount(live.amountOut, row.to_token);
  const internalOut = floorTokenAmount(
    applyInternalHaircut(marketOut, config.swap.internalHaircutBps),
    row.to_token,
  );
  const free = await getFreeInventory(row.to_token);
  const forceOnchain = !!(row.metadata as { force_onchain?: boolean })?.force_onchain;
  const decision = decideHybridMode({
    requiredOut: internalOut,
    freeInventory: free.free,
    hasOnchainRoute: true,
    maxInternalFraction: config.swap.maxInternalFraction,
    maxInternalAbsolute: maxInternalAbsolute(row.to_token),
    forceOnchain,
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

  // If the quote was priced as internal (gas_reserved=0) but we fell back to
  // on-chain at confirm, still charge gas correctly.
  return executeOnchain(row, routes, marketOut, volumeProxy, client);
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
  marketOut: number,
  volumeProxy: number,
  client: Parameters<typeof recordLedgerEntry>[0],
): Promise<ExecuteSwapResult> {
  const amountIn = tokenAmountToUnits(row.from_amount, row.from_token);
  // Re-quote gas with current min out.
  const minOut = Math.min(row.min_to_amount, marketOut);
  const amountOutMin = tokenAmountToUnits(minOut, row.to_token);
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

  const result = await executeTreasuryRouterSwap(
    {
      fromToken: row.from_token,
      toToken: row.to_token,
      amountIn,
      amountOutMin,
      routes,
    },
    {
      // Persist hash before broadcast so crash recovery never refunds an in-flight tx.
      onSigned: async (txHash) => {
        const { data, error } = await supabase.from("swaps").update({
          status: "submitted",
          tx_hash: txHash,
          updated_at: new Date().toISOString(),
        }).eq("quote_id", row.quote_id).in("status", ["reserved", "submitted"]).select("id");
        if (error) throw new Error(`Failed to persist swap tx hash: ${error.message}`);
        if (!data?.length) throw new Error("Failed to persist swap tx hash: row not in reserved/submitted");
      },
    },
  );

  // Money-safety: only refund when we never broadcast OR chain explicitly reverted.
  if (result.minedRevert || (!result.txHash && !result.confirmed)) {
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
 * - no tx_hash after age → safe full refund (never broadcast)
 * - mined revert → refund
 * - mined success → credit log-derived out (or min_to floor); never refund principal
 * - unknown / mempool → leave pending
 */
export async function recoverPendingSwaps(): Promise<void> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: stale } = await supabase
    .from("swaps")
    .select("*")
    .in("status", ["reserved", "submitted"])
    .lt("created_at", fiveMinutesAgo);

  if (!stale?.length) return;
  console.log(`[Swap recovery] ${stale.length} pending swap(s)`);

  for (const raw of stale) {
    const row = raw as SwapRow;
    try {
      if (!row.tx_hash) {
        // Only refund if still no hash after age — never broadcast.
        await refundSwap(row.quote_id, "recovery_no_tx_hash", null);
        console.log(`[Swap recovery] ${row.quote_id}: no tx → refunded`);
        continue;
      }

      const amountOutMin = tokenAmountToUnits(row.min_to_amount, row.to_token);
      const inspected = await inspectSwapReceipt(
        row.tx_hash,
        tokenOutAddress(row.to_token),
        amountOutMin,
      );

      if (inspected.status === "pending") {
        const tx = await rawRpcTx(row.tx_hash);
        if (tx === null) {
          await new Promise((r) => setTimeout(r, 4000));
          const retry = await rawRpcTx(row.tx_hash);
          if (retry === null) {
            // Only drop-refund after a second null lookup on a stale row.
            const ageMs = Date.now() - new Date(row.created_at).getTime();
            // Conservative: only auto-refund a known hash after 60m of repeated absence.
            // Prefer ops review over free-riding if RPC was flaky.
            if (ageMs > 60 * 60 * 1000) {
              await refundSwap(row.quote_id, "recovery_tx_dropped", null, { txHash: row.tx_hash });
              console.log(`[Swap recovery] ${row.quote_id}: dropped after 60m → refunded`);
            } else {
              console.log(`[Swap recovery] ${row.quote_id}: tx not found yet — leave pending`);
            }
          } else {
            console.log(`[Swap recovery] ${row.quote_id}: still pending`);
          }
        } else {
          console.log(`[Swap recovery] ${row.quote_id}: mempool/waiting receipt`);
        }
        continue;
      }

      if (inspected.status === "revert") {
        await refundSwap(row.quote_id, "recovery_tx_reverted", null, {
          txHash: row.tx_hash,
          gasActual: inspected.gasSats,
        });
        console.log(`[Swap recovery] ${row.quote_id}: reverted → refunded`);
        continue;
      }

      // Success: credit once. Never refund principal after minedSuccess.
      if (!row.to_credited) {
        const creditAmount = Math.max(
          routerOutToTokenAmount(inspected.amountOut, row.to_token),
          row.min_to_amount,
        );
        const { data: creditResult } = await supabase.rpc("credit_swap_output", {
          p_quote_id: row.quote_id,
          p_to_amount: creditAmount,
          p_gas_actual_sats: inspected.gasSats || row.gas_reserved_sats,
          p_tx_hash: row.tx_hash,
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
            metadata: { leg: "to", mode: "onchain", recovery: true, tx_hash: row.tx_hash },
          });
        }
      } else {
        await supabase.from("swaps").update({
          status: "completed",
          updated_at: new Date().toISOString(),
        }).eq("quote_id", row.quote_id);
      }
    } catch (err) {
      console.error(`[Swap recovery] ${row.quote_id}:`, (err as Error)?.message ?? err);
    }
  }
}

async function rawRpcTx(txHash: string): Promise<{ blockNumber?: string | null } | null> {
  const { rawRpcCall } = await import("../evm.js");
  return await rawRpcCall("eth_getTransactionByHash", [txHash]) as {
    blockNumber?: string | null;
  } | null;
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
}> {
  const [treasury, freeSats, freeMusd, freeMusdc, pendingRes] = await Promise.all([
    getTreasuryBalances(),
    getFreeInventory("SATS"),
    getFreeInventory("MUSD"),
    getFreeInventory("MUSDC"),
    supabase
      .from("swaps")
      .select("id", { count: "exact", head: true })
      .in("status", ["reserved", "submitted"]),
  ]);
  return {
    treasury,
    free: {
      SATS: freeSats.free,
      MUSD: freeMusd.free,
      MUSDC: freeMusdc.free,
    },
    pending: pendingRes.count ?? 0,
  };
}
