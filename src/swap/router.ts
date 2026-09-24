import { ethers } from "ethers";
import { config, tokenUnitsToSats } from "../config.js";
import {
  getGasPriceWei,
  getTreasuryAddress,
  getTreasurySigner,
  rawRpcCall,
  addGasLimitBuffer,
} from "../evm.js";
import {
  floorTokenAmount,
  tokenAmountToUnits,
  tokenUnitsToAmount,
  type TokenSymbol,
} from "../tokens.js";
import { pinQuoteBlock, quoteClExactInput, type QuoteBlockTag } from "./clQuote.js";
import {
  buildSwapRoutes,
  candidateRoutesFromGraph,
  encodeClPath,
  getClRouterAddress,
  getRouterAddress,
  groupSwapLegs,
  hopTokenIn,
  hopTokenOut,
  loadPoolGraph,
  pickBestQuotedRoute,
  symbolForPoolToken,
} from "./routes.js";
import type { BasicRouteHop, ClRouteHop, MezoRouteHop, SwapLeg } from "./types.js";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
];

const CL_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
];

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

const ROUTER_IFACE = new ethers.Interface(ROUTER_ABI);
const CL_IFACE = new ethers.Interface(CL_ROUTER_ABI);
const ERC20_IFACE = new ethers.Interface(ERC20_ABI);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/** Serialize all treasury router swaps (user + rebalance + recovery) so nonce/logs stay coherent. */
let treasurySwapQueue: Promise<void> = Promise.resolve();

/**
 * In-process treasury swap lock. Recovery acquires it before re-reading a row so
 * it never races the live path in this process; callers holding it must use
 * `executeTreasuryRouterSwapUnlocked` (the lock is not re-entrant).
 */
export async function withTreasurySwapLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = treasurySwapQueue;
  treasurySwapQueue = prev.then(() => gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function basicTuples(hops: BasicRouteHop[]): Array<{
  from: string;
  to: string;
  stable: boolean;
  factory: string;
}> {
  return hops.map((hop) => ({
    from: hop.from,
    to: hop.to,
    stable: hop.stable,
    factory: hop.factory,
  }));
}

export type RouterQuote = {
  amountIn: bigint;
  amountOut: bigint;
  amounts: bigint[];
  /** Quoted output after each venue leg (last entry === amountOut). */
  legOuts: bigint[];
  routes: MezoRouteHop[];
  /** Block every read in this quote was pinned to. */
  blockTag: QuoteBlockTag;
};

async function quoteBasicAmountsOut(
  amountIn: bigint,
  hops: BasicRouteHop[],
  blockTag: QuoteBlockTag = "latest",
): Promise<bigint[]> {
  if (hops.length === 0) throw new Error("Empty swap route");
  const data = ROUTER_IFACE.encodeFunctionData("getAmountsOut", [amountIn, basicTuples(hops)]);
  const raw = await rawRpcCall("eth_call", [{
    to: getRouterAddress(),
    data,
  }, blockTag]) as string;

  if (!raw || raw === "0x") throw new Error("Router returned empty quote");
  const decoded = ROUTER_IFACE.decodeFunctionResult("getAmountsOut", raw);
  const amounts = (decoded[0] as bigint[]).map((x) => BigInt(x));
  if (amounts.length < 2) throw new Error("Invalid router amounts");
  return amounts;
}

export async function quoteRouterAmountsOut(
  fromToken: TokenSymbol,
  toToken: TokenSymbol,
  fromAmount: number,
  routes: MezoRouteHop[],
): Promise<RouterQuote> {
  if (routes.length === 0) throw new Error("Empty swap route");
  const amountIn = tokenAmountToUnits(fromAmount, fromToken);
  if (amountIn <= 0n) throw new Error("Amount too small");
  return quoteRouteUnits(amountIn, routes);
}

/** Quote a route in raw units with every leg pinned to one block. */
export async function quoteRouteUnits(
  amountIn: bigint,
  routes: MezoRouteHop[],
  options: { blockTag?: QuoteBlockTag } = {},
): Promise<RouterQuote> {
  if (routes.length === 0) throw new Error("Empty swap route");
  if (amountIn <= 0n) throw new Error("Amount too small");
  const blockTag = options.blockTag ?? await pinQuoteBlock();

  const legs = groupSwapLegs(routes);
  const amounts: bigint[] = [amountIn];
  const legOuts: bigint[] = [];
  let current = amountIn;
  for (const leg of legs) {
    if (leg.venue === "basic") {
      const hopAmounts = await quoteBasicAmountsOut(current, leg.hops, blockTag);
      current = hopAmounts[hopAmounts.length - 1]!;
      amounts.push(...hopAmounts.slice(1));
    } else {
      for (const hop of leg.hops) {
        current = await quoteClExactInput(hop, current, { blockTag });
        amounts.push(current);
      }
    }
    legOuts.push(current);
  }
  if (current <= 0n) throw new Error("Quoted output is zero — check pool liquidity");
  return { amountIn, amountOut: current, amounts, legOuts, routes, blockTag };
}

/**
 * Pick the allowlisted route with the best quoted output for this size (all
 * candidates quoted at one pinned block). Falls back to the static route
 * builder only if the pool graph cannot be loaded.
 */
export async function buildBestSwapRoutes(
  fromToken: TokenSymbol,
  toToken: TokenSymbol,
  fromAmount: number,
): Promise<MezoRouteHop[]> {
  let candidates: MezoRouteHop[][];
  try {
    candidates = candidateRoutesFromGraph(fromToken, toToken, await loadPoolGraph());
  } catch {
    return buildSwapRoutes(fromToken, toToken);
  }
  if (candidates.length === 1) return candidates[0]!;
  const amountIn = tokenAmountToUnits(fromAmount, fromToken);
  if (amountIn <= 0n) return candidates[0]!;
  const blockTag = await pinQuoteBlock();
  const quoted = await Promise.all(candidates.map(async (routes) => {
    try {
      const q = await quoteRouteUnits(amountIn, routes, { blockTag });
      return { routes, amountOut: q.amountOut as bigint | null };
    } catch {
      return { routes, amountOut: null as bigint | null };
    }
  }));
  const best = pickBestQuotedRoute(quoted);
  if (!best) throw new Error(`No quotable on-chain route for ${fromToken} → ${toToken}`);
  return best.routes;
}

/**
 * Per-leg amountOutMinimum. Intermediate legs get their quoted output minus the
 * user's slippage (so a sandwiched first leg reverts instead of mining at a bad
 * price); the final leg uses `finalMin` (the user's promised minimum) when
 * given, otherwise the same slippage rule. Never returns 0 (min 1 unit).
 */
export function computeLegMinimums(
  legOuts: bigint[],
  slippageBps: number,
  finalMin?: bigint,
): bigint[] {
  const bps = BigInt(Math.min(Math.max(0, Math.floor(slippageBps)), 5_000));
  return legOuts.map((quoted, i) => {
    const isLast = i === legOuts.length - 1;
    if (isLast && finalMin != null) return finalMin > 0n ? finalMin : 1n;
    const min = (quoted * (10_000n - bps)) / 10_000n;
    return min > 0n ? min : 1n;
  });
}

export function routerOutToTokenAmount(amountOut: bigint, toToken: TokenSymbol): number {
  return floorTokenAmount(tokenUnitsToAmount(amountOut, toToken), toToken);
}

export type OnchainSwapResult = {
  txHash: string;
  txHashes: string[];
  amountOut: bigint;
  gasSats: number;
  confirmed: boolean;
  /** True when a receipt with status=1 was observed (never refund principal). */
  minedSuccess: boolean;
  /** True when a receipt with status=0 was observed (safe to refund only if no prior leg succeeded). */
  minedRevert: boolean;
  legsCompleted: number;
  legsTotal: number;
  /** False when the last leg's amountOut fell back to amountOutMin (no Transfer logs). */
  fromLogs?: boolean;
  error?: string;
};

type LegBroadcastOptions = {
  onSigned?: (txHash: string, nonce: number) => Promise<void>;
};

export type SignedTxInfo = {
  /** Absolute leg index in the full route (includes `legOffset`). */
  legIndex: number;
  nonce: number;
};

export type LegCompleteInfo = {
  legIndex: number;
  txHash: string;
  amountOut: bigint;
  /** Pool token address received by this leg. */
  tokenOut: string;
  isLast: boolean;
  /** True when amountOut came from Transfer logs (false = min-out fallback). */
  fromLogs: boolean;
};

export type ExecuteSwapOptions = {
  /** Persist expected hash before broadcast so crash recovery never refunds an in-flight tx. */
  onSigned?: (txHash: string, info: SignedTxInfo) => Promise<void>;
  /** Persist per-leg progress (legs_completed, intermediate reservation, progress timestamp). */
  onLegComplete?: (info: LegCompleteInfo) => Promise<void>;
};

export type ExecuteSwapInput = {
  fromToken: TokenSymbol;
  toToken: TokenSymbol;
  amountIn: bigint;
  amountOutMin: bigint;
  routes: MezoRouteHop[];
  /**
   * amountOutMinimum per venue leg (see computeLegMinimums). Required when the
   * route has more than one leg so intermediate legs are never sent with min=1.
   */
  legMinOuts?: bigint[];
  /** Leg index of routes[0] within the original route (recovery continues mid-route). */
  legOffset?: number;
};

function emptyResult(error: string, extras: Partial<OnchainSwapResult> = {}): OnchainSwapResult {
  return {
    txHash: "",
    txHashes: [],
    amountOut: 0n,
    gasSats: 0,
    confirmed: false,
    minedSuccess: false,
    minedRevert: false,
    legsCompleted: 0,
    legsTotal: extras.legsTotal ?? 1,
    error,
    ...extras,
  };
}

/**
 * Execute the route from the treasury wallet (basic router, CL router, or both).
 * Mixed venues run as sequential txs under the treasury nonce lock.
 * Amount out is taken from Transfer logs to treasury (not gross balance delta).
 */
export async function executeTreasuryRouterSwap(
  input: ExecuteSwapInput,
  options: ExecuteSwapOptions = {},
): Promise<OnchainSwapResult> {
  return withTreasurySwapLock(() => executeTreasuryRouterSwapUnlocked(input, options));
}

/** Same as executeTreasuryRouterSwap; caller MUST already hold withTreasurySwapLock. */
export async function executeTreasuryRouterSwapUnlocked(
  input: ExecuteSwapInput,
  options: ExecuteSwapOptions = {},
): Promise<OnchainSwapResult> {
  const legs = groupSwapLegs(input.routes);
  if (legs.length === 0) return emptyResult("Empty swap route");
  if (legs.length > 1 && (!input.legMinOuts || input.legMinOuts.length !== legs.length)) {
    return emptyResult("Multi-leg swap requires per-leg minimum outputs", { legsTotal: legs.length });
  }
  const legOffset = input.legOffset ?? 0;

  let amount = input.amountIn;
  const txHashes: string[] = [];
  let gasSats = 0;
  let legsCompleted = 0;
  let lastFromLogs = true;

  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    const isLast = i === legs.length - 1;
    const minOut = isLast ? input.amountOutMin : input.legMinOuts![i]!;
    const tokenOut = hopTokenOut(leg.hops[leg.hops.length - 1]!);
    const tokenIn = hopTokenIn(leg.hops[0]!);
    const outLabel = isLast ? input.toToken : (symbolForPoolToken(tokenOut) ?? tokenOut);
    const legIndex = legOffset + i;
    const legOptions: LegBroadcastOptions = {
      onSigned: options.onSigned
        ? (txHash, nonce) => options.onSigned!(txHash, { legIndex, nonce })
        : undefined,
    };

    const result = leg.venue === "basic"
      ? await executeBasicUnlocked(
        {
          outLabel,
          amountIn: amount,
          amountOutMin: minOut,
          hops: leg.hops,
          tokenIn,
          tokenOut,
        },
        legOptions,
      )
      : await executeClUnlocked(
        {
          amountIn: amount,
          amountOutMin: minOut,
          hops: leg.hops,
          outLabel,
        },
        legOptions,
      );

    if (result.txHash) txHashes.push(result.txHash);
    gasSats += result.gasSats;

    if (result.minedRevert) {
      return {
        ...result,
        txHash: txHashes[0] ?? result.txHash,
        txHashes,
        gasSats,
        legsCompleted,
        legsTotal: legs.length,
        error: legsCompleted > 0
          ? `Swap hop ${i + 1}/${legs.length} reverted after a prior hop mined. Recovery will retry.`
          : result.error,
      };
    }

    if (!result.confirmed) {
      return {
        ...result,
        txHash: txHashes[0] ?? result.txHash,
        txHashes,
        gasSats,
        legsCompleted,
        legsTotal: legs.length,
      };
    }

    amount = result.amountOut;
    legsCompleted += 1;
    lastFromLogs = result.fromLogs !== false;
    if (options.onLegComplete) {
      await options.onLegComplete({
        legIndex,
        txHash: result.txHash,
        amountOut: result.amountOut,
        tokenOut,
        isLast,
        fromLogs: lastFromLogs,
      });
    }
  }

  if (amount < input.amountOutMin && legsCompleted === legs.length) {
    console.warn(
      `[Swap] Combined out ${amount} < min ${input.amountOutMin}; crediting observed`,
    );
  }

  return {
    txHash: txHashes[0] ?? "",
    txHashes,
    amountOut: amount,
    gasSats,
    confirmed: true,
    minedSuccess: true,
    minedRevert: false,
    legsCompleted,
    legsTotal: legs.length,
    fromLogs: lastFromLogs,
  };
}

async function executeBasicUnlocked(
  input: {
    /** Label for logs: output token symbol (intermediate symbol for non-final legs). */
    outLabel: string;
    amountIn: bigint;
    amountOutMin: bigint;
    hops: BasicRouteHop[];
    tokenIn: string;
    tokenOut: string;
  },
  options: LegBroadcastOptions,
): Promise<OnchainSwapResult> {
  const signer = getTreasurySigner();
  const treasury = getTreasuryAddress();
  const router = getRouterAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  await ensureRouterAllowance(input.tokenIn, input.amountIn, router, signer.address);

  const data = ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
    input.amountIn,
    input.amountOutMin,
    basicTuples(input.hops),
    treasury,
    deadline,
  ]);

  return broadcastAndWait({
    to: router,
    data,
    tokenOut: input.tokenOut,
    outLabel: input.outLabel,
    amountOutMin: input.amountOutMin,
    onSigned: options.onSigned,
  });
}

async function executeClUnlocked(
  input: {
    amountIn: bigint;
    amountOutMin: bigint;
    hops: ClRouteHop[];
    outLabel: string;
  },
  options: LegBroadcastOptions,
): Promise<OnchainSwapResult> {
  if (input.hops.length === 0) return emptyResult("Empty CL route");
  const signer = getTreasurySigner();
  const treasury = getTreasuryAddress();
  const router = getClRouterAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const tokenIn = input.hops[0]!.tokenIn;
  const tokenOut = input.hops[input.hops.length - 1]!.tokenOut;

  await ensureRouterAllowance(tokenIn, input.amountIn, router, signer.address);

  let data: string;
  if (input.hops.length === 1) {
    const hop = input.hops[0]!;
    data = CL_IFACE.encodeFunctionData("exactInputSingle", [{
      tokenIn: hop.tokenIn,
      tokenOut: hop.tokenOut,
      tickSpacing: hop.tickSpacing,
      recipient: treasury,
      deadline,
      amountIn: input.amountIn,
      amountOutMinimum: input.amountOutMin,
      sqrtPriceLimitX96: 0n,
    }]);
  } else {
    data = CL_IFACE.encodeFunctionData("exactInput", [{
      path: encodeClPath(input.hops),
      recipient: treasury,
      deadline,
      amountIn: input.amountIn,
      amountOutMinimum: input.amountOutMin,
    }]);
  }

  return broadcastAndWait({
    to: router,
    data,
    tokenOut,
    outLabel: input.outLabel,
    amountOutMin: input.amountOutMin,
    onSigned: options.onSigned,
  });
}

async function broadcastAndWait(input: {
  to: string;
  data: string;
  tokenOut: string;
  outLabel: string;
  amountOutMin: bigint;
  onSigned?: (txHash: string, nonce: number) => Promise<void>;
}): Promise<OnchainSwapResult> {
  const signer = getTreasurySigner();
  const treasury = getTreasuryAddress();
  const gasPrice = await getGasPriceWei();
  let gasLimit: bigint;
  try {
    const estimated = BigInt(await rawRpcCall("eth_estimateGas", [{
      from: treasury,
      to: input.to,
      data: input.data,
    }]) as string);
    gasLimit = addGasLimitBuffer(estimated);
  } catch (error) {
    return emptyResult(`Gas estimate failed: ${(error as Error).message}`);
  }

  const nonceRaw = await rawRpcCall("eth_getTransactionCount", [treasury, "pending"]) as string;
  const nonce = Number(BigInt(nonceRaw ?? "0x0"));
  const signed = await signer.signTransaction({
    to: input.to,
    data: input.data,
    gasLimit,
    gasPrice,
    nonce,
    chainId: config.evm.chainId,
    type: 0,
  });
  const expectedHash = ethers.keccak256(signed);

  if (input.onSigned) {
    await input.onSigned(expectedHash, nonce);
  }

  let txHash = expectedHash;
  try {
    txHash = (await rawRpcCall("eth_sendRawTransaction", [signed]) as string | null) ?? expectedHash;
    if (txHash.toLowerCase() !== expectedHash.toLowerCase() && input.onSigned) {
      await input.onSigned(txHash, nonce);
    }
  } catch (error) {
    const message = String((error as Error)?.message ?? error).toLowerCase();
    if (!message.includes("already known") && !message.includes("known transaction")) {
      return {
        txHash: expectedHash,
        txHashes: [expectedHash],
        amountOut: 0n,
        gasSats: 0,
        confirmed: false,
        minedSuccess: false,
        minedRevert: false,
        legsCompleted: 0,
        legsTotal: 1,
        error: `Broadcast failed (tx may still be recoverable): ${(error as Error).message}`,
      };
    }
  }

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const receipt = await rawRpcCall("eth_getTransactionReceipt", [txHash]) as {
      status: string;
      gasUsed?: string;
      effectiveGasPrice?: string;
      logs?: Array<{ address: string; topics: string[]; data: string }>;
    } | null;
    if (!receipt) continue;

    const actualGas = receipt.gasUsed
      ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? gasPrice)
      : gasLimit * gasPrice;
    const gasSats = tokenUnitsToSats(actualGas);

    if (parseInt(receipt.status, 16) !== 1) {
      return {
        txHash,
        txHashes: [txHash],
        amountOut: 0n,
        gasSats,
        confirmed: false,
        minedSuccess: false,
        minedRevert: true,
        legsCompleted: 0,
        legsTotal: 1,
        error: "Swap transaction reverted on-chain",
      };
    }

    let amountOut = amountOutFromTransferLogs(receipt.logs ?? [], input.tokenOut, treasury);
    let fromLogs = true;
    if (amountOut == null || amountOut <= 0n) {
      amountOut = input.amountOutMin;
      fromLogs = false;
      console.warn(
        `[Swap] Transfer logs missing for ${txHash}; using amountOutMin ` +
        `(${amountOut.toString()}) for ${input.outLabel}`,
      );
    }
    if (amountOut < input.amountOutMin) {
      console.warn(
        `[Swap] Observed out ${amountOut} < min ${input.amountOutMin} for ${txHash}; crediting observed`,
      );
    }

    return {
      txHash,
      txHashes: [txHash],
      amountOut,
      gasSats,
      confirmed: true,
      minedSuccess: true,
      minedRevert: false,
      legsCompleted: 1,
      legsTotal: 1,
      fromLogs,
    };
  }

  return {
    txHash,
    txHashes: [txHash],
    amountOut: 0n,
    gasSats: tokenUnitsToSats(gasLimit * gasPrice),
    confirmed: false,
    minedSuccess: false,
    minedRevert: false,
    legsCompleted: 0,
    legsTotal: 1,
    error: "Receipt timeout: swap not confirmed after 2 minutes (left for recovery)",
  };
}

/** Sum Transfer logs of tokenOut where `to` is treasury. */
export function amountOutFromTransferLogs(
  logs: Array<{ address: string; topics: string[]; data: string }>,
  tokenOut: string,
  treasury: string,
): bigint | null {
  const token = tokenOut.toLowerCase();
  const dest = treasury.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  let total = 0n;
  let found = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token) continue;
    if (!log.topics?.[0] || log.topics[0].toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
    if (log.topics.length < 3) continue;
    const toTopic = log.topics[2]!.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    if (toTopic !== dest) continue;
    total += BigInt(log.data || "0x0");
    found = true;
  }
  return found ? total : null;
}

function encodeLegCalldata(leg: SwapLeg, amountIn: bigint, amountOutMin: bigint, treasury: string, deadline: bigint): {
  to: string;
  data: string;
} {
  if (leg.venue === "basic") {
    return {
      to: getRouterAddress(),
      data: ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
        amountIn,
        amountOutMin,
        basicTuples(leg.hops),
        treasury,
        deadline,
      ]),
    };
  }
  if (leg.hops.length === 1) {
    const hop = leg.hops[0]!;
    return {
      to: getClRouterAddress(),
      data: CL_IFACE.encodeFunctionData("exactInputSingle", [{
        tokenIn: hop.tokenIn,
        tokenOut: hop.tokenOut,
        tickSpacing: hop.tickSpacing,
        recipient: treasury,
        deadline,
        amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0n,
      }]),
    };
  }
  return {
    to: getClRouterAddress(),
    data: CL_IFACE.encodeFunctionData("exactInput", [{
      path: encodeClPath(leg.hops),
      recipient: treasury,
      deadline,
      amountIn,
      amountOutMinimum: amountOutMin,
    }]),
  };
}

export async function quoteSwapGasSats(routes: MezoRouteHop[], amountIn: bigint, amountOutMin: bigint): Promise<{
  gasLimit: bigint;
  gasPrice: bigint;
  gasSats: number;
}> {
  const treasury = getTreasuryAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const gasPrice = await getGasPriceWei();
  const legs = groupSwapLegs(routes);
  let gasLimit = 0n;
  let remainingIn = amountIn;

  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    const isLast = i === legs.length - 1;
    // Estimation only (never broadcast); intermediate mins do not change gas materially.
    const minOut = isLast ? amountOutMin : 1n;
    const encoded = encodeLegCalldata(leg, remainingIn, minOut, treasury, deadline);
    const fallback = leg.venue === "cl" ? 400_000n : 450_000n;
    try {
      const swapEstimate = BigInt(await rawRpcCall("eth_estimateGas", [{
        from: treasury,
        to: encoded.to,
        data: encoded.data,
      }]) as string);
      gasLimit += addGasLimitBuffer(swapEstimate + 80_000n);
    } catch {
      gasLimit += fallback;
    }
    if (!isLast) {
      try {
        if (leg.venue === "basic") {
          const hopAmounts = await quoteBasicAmountsOut(remainingIn, leg.hops);
          remainingIn = hopAmounts[hopAmounts.length - 1]!;
        } else {
          let current = remainingIn;
          for (const hop of leg.hops) current = await quoteClExactInput(hop, current);
          remainingIn = current;
        }
      } catch {
        // keep remainingIn; next estimate may fall back
      }
    }
  }

  if (gasLimit === 0n) gasLimit = 450_000n;
  return { gasLimit, gasPrice, gasSats: tokenUnitsToSats(gasLimit * gasPrice) };
}

/**
 * Inspect a mined receipt for swap output (recovery path).
 */
export async function inspectSwapReceipt(
  txHash: string,
  tokenOutAddress: string,
  amountOutMin: bigint,
): Promise<{
  status: "success" | "revert" | "pending";
  amountOut: bigint;
  gasSats: number;
  /** False when no matching Transfer log was found and amountOut is the min fallback. */
  fromLogs: boolean;
}> {
  const receipt = await rawRpcCall("eth_getTransactionReceipt", [txHash]) as {
    status: string;
    gasUsed?: string;
    effectiveGasPrice?: string;
    logs?: Array<{ address: string; topics: string[]; data: string }>;
  } | null;
  if (!receipt) return { status: "pending", amountOut: 0n, gasSats: 0, fromLogs: false };

  const gasPrice = receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : await getGasPriceWei();
  const gasSats = receipt.gasUsed
    ? tokenUnitsToSats(BigInt(receipt.gasUsed) * gasPrice)
    : 0;
  if (parseInt(receipt.status, 16) !== 1) {
    return { status: "revert", amountOut: 0n, gasSats, fromLogs: false };
  }

  const treasury = getTreasuryAddress();
  const logged = amountOutFromTransferLogs(receipt.logs ?? [], tokenOutAddress, treasury);
  if (logged == null || logged <= 0n) {
    return { status: "success", amountOut: amountOutMin, gasSats, fromLogs: false };
  }
  return { status: "success", amountOut: logged, gasSats, fromLogs: true };
}

/** Treasury nonce at a block tag ("latest" = mined count). */
export async function getTreasuryNonce(blockTag: "latest" | "pending" = "latest"): Promise<number> {
  const raw = await rawRpcCall("eth_getTransactionCount", [getTreasuryAddress(), blockTag]) as string;
  return Number(BigInt(raw ?? "0x0"));
}

/** eth_getTransactionByHash (null when the node does not know the tx). */
export async function getTransactionByHash(txHash: string): Promise<{ blockNumber?: string | null; nonce?: string } | null> {
  return await rawRpcCall("eth_getTransactionByHash", [txHash]) as {
    blockNumber?: string | null;
    nonce?: string;
  } | null;
}

async function ensureRouterAllowance(
  tokenAddress: string,
  amountIn: bigint,
  router: string,
  owner: string,
): Promise<void> {
  const allowanceData = ERC20_IFACE.encodeFunctionData("allowance", [owner, router]);
  const raw = await rawRpcCall("eth_call", [{ to: tokenAddress, data: allowanceData }, "latest"]) as string;
  const allowance = BigInt(raw ?? "0x0");
  if (!allowanceNeedsUpdate(allowance, amountIn)) return;

  // Approve exactly this swap's input (no standing infinite allowance on the
  // routers). Reset to 0 first for tokens that reject non-zero → non-zero; this
  // also revokes legacy MaxUint256 approvals the first time they are seen.
  const signer = getTreasurySigner();
  const gasPrice = await getGasPriceWei();
  if (allowance > 0n) {
    await sendErc20Approve(signer, tokenAddress, router, 0n, gasPrice);
  }
  await sendErc20Approve(signer, tokenAddress, router, approvalAmountFor(amountIn), gasPrice);
}

/** Allowances at or above this are treated as unbounded and get revoked. */
export const UNBOUNDED_ALLOWANCE_THRESHOLD = 2n ** 128n;

/** Whether ensureRouterAllowance must (re)approve (exported for tests). */
export function allowanceNeedsUpdate(allowance: bigint, amountIn: bigint): boolean {
  if (allowance >= UNBOUNDED_ALLOWANCE_THRESHOLD) return true;
  return allowance < amountIn;
}

/** Allowance granted per swap: exactly the input amount (exported for tests). */
export function approvalAmountFor(amountIn: bigint): bigint {
  if (amountIn <= 0n) throw new Error("approval amount must be positive");
  return amountIn;
}

async function sendErc20Approve(
  signer: ethers.Wallet,
  token: string,
  spender: string,
  amount: bigint,
  gasPrice: bigint,
): Promise<void> {
  const data = ERC20_IFACE.encodeFunctionData("approve", [spender, amount]);
  const estimated = BigInt(await rawRpcCall("eth_estimateGas", [{
    from: signer.address,
    to: token,
    data,
  }]) as string);
  const gasLimit = addGasLimitBuffer(estimated);
  const nonceRaw = await rawRpcCall("eth_getTransactionCount", [signer.address, "pending"]) as string;
  const signed = await signer.signTransaction({
    to: token,
    data,
    gasLimit,
    gasPrice,
    nonce: Number(BigInt(nonceRaw ?? "0x0")),
    chainId: config.evm.chainId,
    type: 0,
  });
  const hash = (await rawRpcCall("eth_sendRawTransaction", [signed]) as string) ?? ethers.keccak256(signed);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const receipt = await rawRpcCall("eth_getTransactionReceipt", [hash]) as { status: string } | null;
    if (!receipt) continue;
    if (parseInt(receipt.status, 16) !== 1) throw new Error("Token approve reverted");
    return;
  }
  throw new Error(`Approve ${hash} did not confirm`);
}


