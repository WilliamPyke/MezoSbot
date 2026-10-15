import { ethers } from "ethers";
import { rawRpcCall } from "../evm.js";
import { readLogsSplitting, type RpcLog } from "./policy.js";

/** JSON-RPC error raised by rawRpcCall; `data` carries revert data when the node returns it. */
export type RpcFailure = Error & { rpcError?: boolean; code?: unknown; data?: unknown };

function toHex(value: number): string {
  return `0x${value.toString(16)}`;
}

function toNumber(raw: unknown, what: string): number {
  if (typeof raw !== "string" || !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`unexpected ${what} ${String(raw)}`);
  return Number(BigInt(raw));
}

/** True for an error the node answered (a revert), false for transport failures. */
export function isRpcError(error: unknown): boolean {
  return !!(error as RpcFailure | null)?.rpcError;
}

/** True only for an execution revert (JSON-RPC code 3 or a revert message), not node or rate-limit errors. */
export function isRevertError(error: unknown): boolean {
  const failure = error as RpcFailure | null;
  if (!failure?.rpcError) return false;
  return failure.code === 3 || /revert/i.test(failure.message);
}

/** The node has block `number` (eth_getBlockByNumber returns it, with that number). */
export async function nodeHasBlock(number: number): Promise<boolean> {
  const block = await rawRpcCall("eth_getBlockByNumber", [toHex(number), false]) as { number?: unknown } | null;
  return typeof block?.number === "string" && /^0x[0-9a-f]+$/i.test(block.number) && Number(BigInt(block.number)) === number;
}

/** Revert data from an eth_call / eth_estimateGas error, if the node returned any. */
export function revertData(error: unknown): string | null {
  let data = (error as RpcFailure | null)?.data;
  if (data && typeof data === "object" && "data" in data) data = (data as { data?: unknown }).data;
  return typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data) ? data : null;
}

export async function ethCall(to: string, data: string, from?: string, block: number | "latest" = "latest"): Promise<string> {
  const tag = block === "latest" ? block : toHex(block);
  const raw = await rawRpcCall("eth_call", [{ ...(from ? { from } : {}), to, data }, tag]);
  if (typeof raw !== "string") throw new Error("eth_call returned no data");
  return raw;
}

/** Multicall3, deployed at the same address on Mezo mainnet and most EVM chains. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3 = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/**
 * One eth_call running `calls` through Multicall3.aggregate3 with
 * allowFailure, so one failing call does not fail the batch. Throws when
 * Multicall3 itself is unavailable (callers fall back to single calls).
 */
export async function multicall3(calls: Array<{ target: string; data: string }>): Promise<Array<{ success: boolean; returnData: string }>> {
  const data = MULTICALL3.encodeFunctionData("aggregate3", [calls.map((call) => [call.target, true, call.data])]);
  const raw = await ethCall(MULTICALL3_ADDRESS, data);
  const [results] = MULTICALL3.decodeFunctionResult("aggregate3", raw);
  const decoded = (results as Array<{ success: boolean; returnData: string }>).map((result) => ({
    success: Boolean(result.success),
    returnData: String(result.returnData),
  }));
  if (decoded.length !== calls.length) throw new Error(`Multicall3 returned ${decoded.length} results for ${calls.length} calls`);
  return decoded;
}

export async function estimateGas(from: string, to: string, data: string): Promise<bigint> {
  const raw = await rawRpcCall("eth_estimateGas", [{ from, to, data }]);
  return BigInt(toNumber(raw, "gas estimate"));
}

export async function getCode(address: string): Promise<string> {
  const raw = await rawRpcCall("eth_getCode", [address, "latest"]);
  return typeof raw === "string" ? raw : "0x";
}

export async function getChainId(): Promise<number> {
  return toNumber(await rawRpcCall("eth_chainId", []), "chain id");
}

export async function getBlockNumber(): Promise<number> {
  return toNumber(await rawRpcCall("eth_blockNumber", []), "block number");
}

export async function getNonce(address: string, tag: "latest" | "pending"): Promise<number> {
  return toNumber(await rawRpcCall("eth_getTransactionCount", [address, tag]), "nonce");
}

type LogFilter = {
  address: string;
  /** Per position: one topic, any of several, or null for any. */
  topics: Array<string | string[] | null>;
  fromBlock: number;
  toBlock: number;
};

async function getLogsOnce(filter: LogFilter): Promise<RpcLog[]> {
  const raw = await rawRpcCall("eth_getLogs", [{
    address: filter.address,
    topics: filter.topics,
    fromBlock: toHex(filter.fromBlock),
    toBlock: toHex(filter.toBlock),
  }]);
  if (!Array.isArray(raw)) {
    const error = new Error("eth_getLogs returned no array") as RpcFailure;
    error.rpcError = true;
    throw error;
  }
  return raw as RpcLog[];
}

/**
 * The node answered and refused the request for its size (a JSON-RPC error,
 * or HTTP 413), as opposed to never answering or rate limiting. Rate limits
 * (HTTP 429, "rate limit" errors) and other HTTP errors are not split: a
 * smaller range would only add requests.
 */
function nodeRefused(error: unknown): boolean {
  const message = String((error as Error | null)?.message ?? "");
  if (/rate.?limit|too many requests/i.test(message)) return false;
  const http = /^RPC HTTP (\d{3}):/.exec(message);
  if (http) return http[1] === "413";
  return isRpcError(error);
}

/**
 * eth_getLogs for [fromBlock, toBlock]. A range the node refuses (too many
 * results, too wide) is read in halves, recursively (readLogsSplitting); a
 * single block it still refuses, or a node that does not answer, throws.
 */
export async function getLogs(filter: LogFilter): Promise<RpcLog[]> {
  return readLogsSplitting(
    (fromBlock, toBlock) => getLogsOnce({ ...filter, fromBlock, toBlock }),
    filter.fromBlock,
    filter.toBlock,
    { splittable: nodeRefused },
  );
}

export type RpcReceipt = {
  status?: unknown;
  gasUsed?: string | null;
  effectiveGasPrice?: string | null;
  logs?: RpcLog[];
};

export async function getReceipt(txHash: string): Promise<RpcReceipt | null> {
  return (await rawRpcCall("eth_getTransactionReceipt", [txHash])) as RpcReceipt | null;
}
