import { ethers } from "ethers";
import { config, tokenUnitsToSats } from "../config.js";
import {
  getGasPriceWei,
  getTokenBalance,
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
import { getRouterAddress } from "./routes.js";
import type { MezoRouteHop } from "./types.js";

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
];

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

const ROUTER_IFACE = new ethers.Interface(ROUTER_ABI);
const ERC20_IFACE = new ethers.Interface(ERC20_ABI);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/** Serialize all treasury router swaps (user + rebalance) so nonce/logs stay coherent. */
let treasurySwapQueue: Promise<void> = Promise.resolve();

async function withTreasurySwapLock<T>(fn: () => Promise<T>): Promise<T> {
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

export type RouterQuote = {
  amountIn: bigint;
  amountOut: bigint;
  amounts: bigint[];
  routes: MezoRouteHop[];
};

export async function quoteRouterAmountsOut(
  fromToken: TokenSymbol,
  toToken: TokenSymbol,
  fromAmount: number,
  routes: MezoRouteHop[],
): Promise<RouterQuote> {
  if (routes.length === 0) throw new Error("Empty swap route");
  const amountIn = tokenAmountToUnits(fromAmount, fromToken);
  if (amountIn <= 0n) throw new Error("Amount too small");

  const data = ROUTER_IFACE.encodeFunctionData("getAmountsOut", [amountIn, routes]);
  const raw = await rawRpcCall("eth_call", [{
    to: getRouterAddress(),
    data,
  }, "latest"]) as string;

  if (!raw || raw === "0x") throw new Error("Router returned empty quote");
  const decoded = ROUTER_IFACE.decodeFunctionResult("getAmountsOut", raw);
  const amounts = (decoded[0] as bigint[]).map((x) => BigInt(x));
  if (amounts.length < 2) throw new Error("Invalid router amounts");
  const amountOut = amounts[amounts.length - 1]!;
  if (amountOut <= 0n) throw new Error("Quoted output is zero — check pool liquidity");

  return { amountIn, amountOut, amounts, routes };
}

export function routerOutToTokenAmount(amountOut: bigint, toToken: TokenSymbol): number {
  return floorTokenAmount(tokenUnitsToAmount(amountOut, toToken), toToken);
}

export type OnchainSwapResult = {
  txHash: string;
  amountOut: bigint;
  gasSats: number;
  confirmed: boolean;
  /** True when a receipt with status=1 was observed (never refund principal). */
  minedSuccess: boolean;
  /** True when a receipt with status=0 was observed (safe to refund). */
  minedRevert: boolean;
  error?: string;
};

export type ExecuteSwapOptions = {
  /** Persist expected hash before broadcast so crash recovery never refunds an in-flight tx. */
  onSigned?: (txHash: string) => Promise<void>;
};

/**
 * Execute swapExactTokensForTokens from the treasury wallet.
 * Amount out is taken from Transfer logs to treasury (not gross balance delta).
 * On receipt success, minedSuccess=true even if log parse falls back to minOut.
 */
export async function executeTreasuryRouterSwap(
  input: {
    fromToken: TokenSymbol;
    toToken: TokenSymbol;
    amountIn: bigint;
    amountOutMin: bigint;
    routes: MezoRouteHop[];
  },
  options: ExecuteSwapOptions = {},
): Promise<OnchainSwapResult> {
  return withTreasurySwapLock(() => executeTreasuryRouterSwapUnlocked(input, options));
}

async function executeTreasuryRouterSwapUnlocked(
  input: {
    fromToken: TokenSymbol;
    toToken: TokenSymbol;
    amountIn: bigint;
    amountOutMin: bigint;
    routes: MezoRouteHop[];
  },
  options: ExecuteSwapOptions,
): Promise<OnchainSwapResult> {
  const signer = getTreasurySigner();
  const treasury = getTreasuryAddress();
  const router = getRouterAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const tokenIn = input.routes[0]!.from;
  const tokenOut = input.routes[input.routes.length - 1]!.to;

  await ensureRouterAllowance(tokenIn, input.amountIn, router, signer.address);

  const data = ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
    input.amountIn,
    input.amountOutMin,
    input.routes,
    treasury,
    deadline,
  ]);

  const gasPrice = await getGasPriceWei();
  let gasLimit: bigint;
  try {
    const estimated = BigInt(await rawRpcCall("eth_estimateGas", [{
      from: treasury,
      to: router,
      data,
    }]) as string);
    gasLimit = addGasLimitBuffer(estimated);
  } catch (error) {
    return {
      txHash: "",
      amountOut: 0n,
      gasSats: 0,
      confirmed: false,
      minedSuccess: false,
      minedRevert: false,
      error: `Gas estimate failed: ${(error as Error).message}`,
    };
  }

  const nonceRaw = await rawRpcCall("eth_getTransactionCount", [treasury, "pending"]) as string;
  const signed = await signer.signTransaction({
    to: router,
    data,
    gasLimit,
    gasPrice,
    nonce: Number(BigInt(nonceRaw ?? "0x0")),
    chainId: config.evm.chainId,
    type: 0,
  });
  const expectedHash = ethers.keccak256(signed);

  // Persist hash *before* broadcast so a crash cannot look like "never sent".
  if (options.onSigned) {
    await options.onSigned(expectedHash);
  }

  let txHash = expectedHash;
  try {
    txHash = (await rawRpcCall("eth_sendRawTransaction", [signed]) as string | null) ?? expectedHash;
    if (txHash.toLowerCase() !== expectedHash.toLowerCase() && options.onSigned) {
      await options.onSigned(txHash);
    }
  } catch (error) {
    const message = String((error as Error)?.message ?? error).toLowerCase();
    if (!message.includes("already known") && !message.includes("known transaction")) {
      // Hash was persisted; recovery must resolve. Surface as unknown/submitted, not refundable here.
      return {
        txHash: expectedHash,
        amountOut: 0n,
        gasSats: 0,
        confirmed: false,
        minedSuccess: false,
        minedRevert: false,
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
        amountOut: 0n,
        gasSats,
        confirmed: false,
        minedSuccess: false,
        minedRevert: true,
        error: "Swap transaction reverted on-chain",
      };
    }

    // Receipt success: NEVER treat as failure. Prefer Transfer logs to treasury.
    let amountOut = amountOutFromTransferLogs(receipt.logs ?? [], tokenOut, treasury);
    if (amountOut == null || amountOut <= 0n) {
      // Fallback: balance delta under the treasury mutex (no concurrent router swaps).
      const balanceAfter = await getTokenBalance(treasury, input.toToken);
      // Without before snapshot under lock this can be wrong; use minOut floor only.
      amountOut = input.amountOutMin;
      console.warn(
        `[Swap] Transfer logs missing for ${txHash}; crediting amountOutMin ` +
        `(${amountOut.toString()}) for ${input.toToken}`,
      );
    }
    if (amountOut < input.amountOutMin) {
      // Router should not allow this; still credit observed amount (no refund).
      console.warn(
        `[Swap] Observed out ${amountOut} < min ${input.amountOutMin} for ${txHash}; crediting observed`,
      );
    }

    return {
      txHash,
      amountOut,
      gasSats,
      confirmed: true,
      minedSuccess: true,
      minedRevert: false,
    };
  }

  // Timeout: hash is known — do not refund; recovery will settle.
  return {
    txHash,
    amountOut: 0n,
    gasSats: tokenUnitsToSats(gasLimit * gasPrice),
    confirmed: false,
    minedSuccess: false,
    minedRevert: false,
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

export async function quoteSwapGasSats(routes: MezoRouteHop[], amountIn: bigint, amountOutMin: bigint): Promise<{
  gasLimit: bigint;
  gasPrice: bigint;
  gasSats: number;
}> {
  const treasury = getTreasuryAddress();
  const router = getRouterAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const data = ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
    amountIn,
    amountOutMin,
    routes,
    treasury,
    deadline,
  ]);
  const gasPrice = await getGasPriceWei();
  try {
    const swapEstimate = BigInt(await rawRpcCall("eth_estimateGas", [{
      from: treasury,
      to: router,
      data,
    }]) as string);
    const gasLimit = addGasLimitBuffer(swapEstimate + 80_000n);
    return { gasLimit, gasPrice, gasSats: tokenUnitsToSats(gasLimit * gasPrice) };
  } catch {
    const gasLimit = 450_000n;
    return { gasLimit, gasPrice, gasSats: tokenUnitsToSats(gasLimit * gasPrice) };
  }
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
}> {
  const receipt = await rawRpcCall("eth_getTransactionReceipt", [txHash]) as {
    status: string;
    gasUsed?: string;
    effectiveGasPrice?: string;
    logs?: Array<{ address: string; topics: string[]; data: string }>;
  } | null;
  if (!receipt) return { status: "pending", amountOut: 0n, gasSats: 0 };

  const gasPrice = receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : await getGasPriceWei();
  const gasSats = receipt.gasUsed
    ? tokenUnitsToSats(BigInt(receipt.gasUsed) * gasPrice)
    : 0;
  if (parseInt(receipt.status, 16) !== 1) {
    return { status: "revert", amountOut: 0n, gasSats };
  }

  const treasury = getTreasuryAddress();
  let amountOut = amountOutFromTransferLogs(receipt.logs ?? [], tokenOutAddress, treasury);
  if (amountOut == null || amountOut <= 0n) amountOut = amountOutMin;
  return { status: "success", amountOut, gasSats };
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
  if (allowance >= amountIn) return;

  const signer = getTreasurySigner();
  const gasPrice = await getGasPriceWei();
  if (allowance > 0n) {
    await sendErc20Approve(signer, tokenAddress, router, 0n, gasPrice);
  }
  await sendErc20Approve(signer, tokenAddress, router, ethers.MaxUint256, gasPrice);
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
