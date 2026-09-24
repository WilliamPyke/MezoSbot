import { ethers } from "ethers";
import { rawRpcCall } from "../evm.js";
import { TOKEN_SYMBOLS, type TokenSymbol } from "../tokens.js";
import type { BasicRouteHop, ClRouteHop, MezoRouteHop, SwapLeg } from "./types.js";

/** Mezo native BTC system token used by Mezo Pools (dual of native gas BTC). */
export const MEZO_BTC_TOKEN = "0x7b7C000000000000000000000000000000000000";

export const DEFAULT_POOL_FACTORY = "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248";
export const DEFAULT_ROUTER = "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706";
export const DEFAULT_CL_FACTORY = "0xBB24AF5c6fB88F1d191FA76055e30BF881BeEb79";
export const DEFAULT_CL_ROUTER = "0x37cDd11919ec3860eaD9efB8673d7476E5326225";

export const CL_TICK_SPACINGS = [1, 10, 50, 100, 200, 2000] as const;

const BASIC_FACTORY_IFACE = new ethers.Interface([
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
]);
const CL_FACTORY_IFACE = new ethers.Interface([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
]);
const LIQUIDITY_IFACE = new ethers.Interface([
  "function liquidity() view returns (uint128)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";
const GRAPH_TTL_MS = 5 * 60 * 1000;
/** First retry delay after a failed on-chain graph refresh; doubles per failure. */
export const GRAPH_FAILURE_BACKOFF_MS = 60 * 1000;
export const GRAPH_FAILURE_BACKOFF_MAX_MS = 15 * 60 * 1000;
/**
 * A route with more venue legs (extra txs, extra gas, recovery risk) must beat
 * the best route with fewer legs by at least this much output to be chosen.
 */
export const MULTI_LEG_MIN_ADVANTAGE_BPS = 50;

/**
 * Pools the treasury is allowed to route through. Factory discovery only
 * confirms these exist / have liquidity; any other factory pool is ignored so a
 * freshly created (attacker-seeded) pool can never be selected.
 *
 * - CL pools are pinned by address (and the factory must map pair/spacing to it).
 * - Basic pools are pinned by (pair, stable) on the configured basic factory;
 *   the discovered address is additionally checked against `address` when set.
 *
 * Config note: operators may extend CL pools with SWAP_EXTRA_POOL_ALLOWLIST
 * (comma-separated pool addresses). Planned: config.swap.extraPoolAllowlist.
 */
export type AllowlistedPool =
  | { kind: "basic"; tokenA: TokenSymbol; tokenB: TokenSymbol; stable: boolean; address?: string }
  | { kind: "cl"; tokenA: TokenSymbol; tokenB: TokenSymbol; tickSpacing: number; address: string };

export const KNOWN_POOL_ALLOWLIST: readonly AllowlistedPool[] = [
  { kind: "basic", tokenA: "SATS", tokenB: "MUSD", stable: false },
  { kind: "basic", tokenA: "MUSD", tokenB: "MUSDC", stable: true },
  {
    kind: "cl",
    tokenA: "MEZO",
    tokenB: "SATS",
    tickSpacing: 2000,
    address: "0x907d055978943c69cffd5ed969f5603af104acc5",
  },
  {
    kind: "cl",
    tokenA: "MEZO",
    tokenB: "MUSD",
    tickSpacing: 200,
    address: "0x1d6e8d24c133535f2d00676f66a0e824f84765ff",
  },
];

function extraAllowlistedAddresses(): Set<string> {
  const raw = process.env.SWAP_EXTRA_POOL_ALLOWLIST ?? "";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
  );
}

/** Whether a discovered basic pool may be used. */
export function isAllowlistedBasicPool(
  tokenA: string,
  tokenB: string,
  stable: boolean,
  poolAddress: string | null | undefined,
  allowlist: readonly AllowlistedPool[] = KNOWN_POOL_ALLOWLIST,
): boolean {
  for (const entry of allowlist) {
    if (entry.kind !== "basic" || entry.stable !== stable) continue;
    if (!samePair(poolTokenAddress(entry.tokenA), poolTokenAddress(entry.tokenB), tokenA, tokenB)) continue;
    if (entry.address && (!poolAddress || normAddr(entry.address) !== normAddr(poolAddress))) continue;
    return true;
  }
  return false;
}

/** Whether a discovered CL pool may be used (address-pinned). */
export function isAllowlistedClPool(
  poolAddress: string,
  allowlist: readonly AllowlistedPool[] = KNOWN_POOL_ALLOWLIST,
  extra: Set<string> = extraAllowlistedAddresses(),
): boolean {
  const addr = normAddr(poolAddress);
  if (extra.has(addr)) return true;
  return allowlist.some((entry) => entry.kind === "cl" && normAddr(entry.address) === addr);
}

export function getPoolFactory(): string {
  return process.env.MEZO_POOLS_FACTORY?.trim() || DEFAULT_POOL_FACTORY;
}

export function getRouterAddress(): string {
  return process.env.MEZO_POOLS_ROUTER?.trim() || DEFAULT_ROUTER;
}

export function getClFactory(): string {
  return process.env.MEZO_CL_FACTORY?.trim() || DEFAULT_CL_FACTORY;
}

export function getClRouterAddress(): string {
  return process.env.MEZO_CL_ROUTER?.trim() || DEFAULT_CL_ROUTER;
}

export const SWAPPABLE_TOKENS: readonly TokenSymbol[] = TOKEN_SYMBOLS;

export function isSwappableToken(symbol: TokenSymbol): boolean {
  return (TOKEN_SYMBOLS as readonly string[]).includes(symbol);
}

export function poolTokenAddress(symbol: TokenSymbol): string {
  if (symbol === "SATS") return MEZO_BTC_TOKEN;
  if (symbol === "MUSD") {
    return process.env.MUSD_TOKEN_CONTRACT?.trim() || "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
  }
  if (symbol === "MUSDC") {
    return process.env.MUSDC_TOKEN_CONTRACT?.trim() || "0x04671C72Aab5AC02A03c1098314b1BB6B560c197";
  }
  if (symbol === "MEZO") {
    return process.env.MEZO_TOKEN_CONTRACT?.trim() || "0x7B7c000000000000000000000000000000000001";
  }
  const _exhaustive: never = symbol;
  return _exhaustive;
}

/** Reverse lookup: pool token address → ledger symbol (null if unknown). */
export function symbolForPoolToken(address: string): TokenSymbol | null {
  const addr = address.toLowerCase();
  for (const symbol of TOKEN_SYMBOLS) {
    if (poolTokenAddress(symbol).toLowerCase() === addr) return symbol;
  }
  return null;
}

export function hopTokenIn(hop: MezoRouteHop): string {
  return hop.kind === "basic" ? hop.from : hop.tokenIn;
}

export function hopTokenOut(hop: MezoRouteHop): string {
  return hop.kind === "basic" ? hop.to : hop.tokenOut;
}

export function isBasicHop(hop: MezoRouteHop): hop is BasicRouteHop {
  return hop.kind === "basic";
}

export function isClHop(hop: MezoRouteHop): hop is ClRouteHop {
  return hop.kind === "cl";
}

export type BasicPoolEdge = {
  tokenA: string;
  tokenB: string;
  stable: boolean;
  factory: string;
  /** Pool address when discovered on-chain (seeded edges may omit it). */
  pool?: string;
};

export type ClPoolEdge = {
  tokenA: string;
  tokenB: string;
  tickSpacing: number;
  factory: string;
  pool: string;
  liquidity: bigint;
};

export type PoolGraph = {
  basic: BasicPoolEdge[];
  cl: ClPoolEdge[];
};

let cachedGraph: { at: number; graph: PoolGraph } | null = null;
let graphRefresh: Promise<void> | null = null;
let graphFailures = 0;
let graphRetryAt = 0;

/** Seed graph = the allowlist itself (used until / unless discovery succeeds). */
function seededMainnetGraph(): PoolGraph {
  const basicFactory = getPoolFactory();
  const clFactory = getClFactory();
  const graph: PoolGraph = { basic: [], cl: [] };
  for (const entry of KNOWN_POOL_ALLOWLIST) {
    const tokenA = poolTokenAddress(entry.tokenA);
    const tokenB = poolTokenAddress(entry.tokenB);
    if (entry.kind === "basic") {
      graph.basic.push({ tokenA, tokenB, stable: entry.stable, factory: basicFactory, pool: entry.address });
    } else {
      graph.cl.push({
        tokenA,
        tokenB,
        tickSpacing: entry.tickSpacing,
        factory: clFactory,
        pool: entry.address,
        liquidity: 1n,
      });
    }
  }
  return graph;
}

/** Exponential backoff after failed graph refreshes (pure; exported for tests). */
export function graphRefreshBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(GRAPH_FAILURE_BACKOFF_MAX_MS, GRAPH_FAILURE_BACKOFF_MS * 2 ** (failures - 1));
}

function normAddr(addr: string): string {
  return addr.toLowerCase();
}

function samePair(edgeA: string, edgeB: string, tokenA: string, tokenB: string): boolean {
  const a = normAddr(edgeA);
  const b = normAddr(edgeB);
  const x = normAddr(tokenA);
  const y = normAddr(tokenB);
  return (a === x && b === y) || (a === y && b === x);
}

function isZeroAddress(addr: string): boolean {
  return !addr || normAddr(addr) === ZERO;
}

async function ethCall(to: string, data: string): Promise<string | null> {
  const raw = await rawRpcCall("eth_call", [{ to, data }, "latest"], { rateLimited: true });
  if (typeof raw !== "string" || raw === "0x") return null;
  return raw;
}

function decodeAddress(raw: string): string {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return ethers.getAddress("0x" + hex.slice(24, 64));
}

async function probeBasicPool(tokenA: string, tokenB: string, stable: boolean): Promise<string | null> {
  const factory = getPoolFactory();
  const data = BASIC_FACTORY_IFACE.encodeFunctionData("getPool", [tokenA, tokenB, stable]);
  const raw = await ethCall(factory, data);
  if (!raw) return null;
  const addr = decodeAddress(raw);
  return isZeroAddress(addr) ? null : addr;
}

async function probeClPool(tokenA: string, tokenB: string, tickSpacing: number): Promise<string | null> {
  const factory = getClFactory();
  const data = CL_FACTORY_IFACE.encodeFunctionData("getPool", [tokenA, tokenB, tickSpacing]);
  const raw = await ethCall(factory, data);
  if (!raw) return null;
  const addr = decodeAddress(raw);
  return isZeroAddress(addr) ? null : addr;
}

async function readLiquidity(pool: string): Promise<bigint> {
  const data = LIQUIDITY_IFACE.encodeFunctionData("liquidity", []);
  const raw = await ethCall(pool, data);
  if (!raw) return 0n;
  return BigInt(raw);
}

/**
 * Confirm allowlisted pools on-chain. Only pools in KNOWN_POOL_ALLOWLIST (or the
 * CL address extension) are probed/accepted; unknown factory pools are ignored.
 */
async function loadPoolGraphFromChain(): Promise<PoolGraph> {
  const basicFactory = getPoolFactory();
  const clFactory = getClFactory();
  const basic: BasicPoolEdge[] = [];
  const cl: ClPoolEdge[] = [];

  for (const entry of KNOWN_POOL_ALLOWLIST) {
    const tokenA = poolTokenAddress(entry.tokenA);
    const tokenB = poolTokenAddress(entry.tokenB);
    if (entry.kind === "basic") {
      const pool = await probeBasicPool(tokenA, tokenB, entry.stable);
      if (!pool || !isAllowlistedBasicPool(tokenA, tokenB, entry.stable, pool)) continue;
      basic.push({ tokenA, tokenB, stable: entry.stable, factory: basicFactory, pool });
      continue;
    }
    // Factory must agree the pinned address is the canonical pool for this pair/spacing.
    const pool = await probeClPool(tokenA, tokenB, entry.tickSpacing);
    if (!pool || normAddr(pool) !== normAddr(entry.address)) continue;
    const liquidity = await readLiquidity(pool);
    if (liquidity <= 0n) continue;
    cl.push({ tokenA, tokenB, tickSpacing: entry.tickSpacing, factory: clFactory, pool, liquidity });
  }

  // Operator-extended CL pools: accepted only when the factory maps a known pair/spacing to them.
  const extra = extraAllowlistedAddresses();
  if (extra.size > 0) {
    const addrs = TOKEN_SYMBOLS.map((symbol) => poolTokenAddress(symbol));
    for (let i = 0; i < addrs.length; i += 1) {
      for (let j = i + 1; j < addrs.length; j += 1) {
        for (const tickSpacing of CL_TICK_SPACINGS) {
          const pool = await probeClPool(addrs[i]!, addrs[j]!, tickSpacing);
          if (!pool || !isAllowlistedClPool(pool, KNOWN_POOL_ALLOWLIST, extra)) continue;
          if (cl.some((edge) => normAddr(edge.pool) === normAddr(pool))) continue;
          const liquidity = await readLiquidity(pool);
          if (liquidity <= 0n) continue;
          cl.push({ tokenA: addrs[i]!, tokenB: addrs[j]!, tickSpacing, factory: clFactory, pool, liquidity });
        }
      }
    }
  }

  if (basic.length === 0 && cl.length === 0) throw new Error("No allowlisted pools confirmed on-chain");
  return { basic, cl };
}

export async function loadPoolGraph(options: { force?: boolean } = {}): Promise<PoolGraph> {
  const chainId = process.env.CHAIN_ID ?? "31612";
  if (!cachedGraph && chainId === "31612") {
    cachedGraph = { at: 0, graph: seededMainnetGraph() };
  }
  const fresh = cachedGraph && Date.now() - cachedGraph.at < GRAPH_TTL_MS;
  if (!options.force && fresh && cachedGraph) return cachedGraph.graph;

  // Back off after failures so a flaky RPC does not trigger a refresh on every quote.
  if (Date.now() < graphRetryAt) {
    if (cachedGraph) return cachedGraph.graph;
    throw new Error("Mezo pool graph unavailable (refresh backing off)");
  }

  if (!graphRefresh) {
    graphRefresh = loadPoolGraphFromChain()
      .then((graph) => {
        cachedGraph = { at: Date.now(), graph };
        graphFailures = 0;
        graphRetryAt = 0;
      })
      .catch((err) => {
        // Keep the seed / last good graph. Quotes must not fail closed on RPC blips.
        graphFailures += 1;
        const backoff = graphRefreshBackoffMs(graphFailures);
        graphRetryAt = Date.now() + backoff;
        console.warn(
          `[Swap routes] pool graph refresh failed (${graphFailures}x, retry in ${Math.round(backoff / 1000)}s):`,
          (err as Error)?.message ?? err,
        );
      })
      .finally(() => {
        graphRefresh = null;
      });
  }

  if (!options.force && cachedGraph) return cachedGraph.graph;

  await graphRefresh;
  if (cachedGraph) return cachedGraph.graph;
  throw new Error("Failed to load Mezo pool graph");
}

function basicHopsFor(fromAddr: string, toAddr: string, graph: PoolGraph): BasicRouteHop[] {
  return graph.basic
    .filter((e) => samePair(e.tokenA, e.tokenB, fromAddr, toAddr))
    .map((edge) => ({
      kind: "basic" as const,
      from: fromAddr,
      to: toAddr,
      stable: edge.stable,
      factory: edge.factory,
    }));
}

function clHopsFor(fromAddr: string, toAddr: string, graph: PoolGraph): ClRouteHop[] {
  return graph.cl
    .filter((e) => samePair(e.tokenA, e.tokenB, fromAddr, toAddr))
    .map((edge) => ({
      kind: "cl" as const,
      tokenIn: fromAddr,
      tokenOut: toAddr,
      tickSpacing: edge.tickSpacing,
      factory: edge.factory,
      pool: edge.pool,
    }));
}

function directHopsFor(fromAddr: string, toAddr: string, graph: PoolGraph): MezoRouteHop[] {
  return [...basicHopsFor(fromAddr, toAddr, graph), ...clHopsFor(fromAddr, toAddr, graph)];
}

function routeKey(route: MezoRouteHop[]): string {
  return route.map((hop) => hop.kind === "basic"
    ? `b:${normAddr(hop.from)}:${normAddr(hop.to)}:${hop.stable}`
    : `c:${normAddr(hop.pool)}:${normAddr(hop.tokenIn)}`).join("|");
}

/**
 * Every allowlisted route candidate for a pair: all direct pools, then all
 * two-hop combinations via MUSD and SATS hubs (same-venue basic, same-venue CL,
 * then mixed). Selection among them is by quoted output (pickBestQuotedRoute).
 */
export function candidateRoutesFromGraph(
  from: TokenSymbol,
  to: TokenSymbol,
  graph: PoolGraph,
): MezoRouteHop[][] {
  if (from === to) throw new Error("Cannot swap a token for itself");
  if (!isSwappableToken(from) || !isSwappableToken(to)) {
    throw new Error(`No on-chain route for ${from} → ${to}`);
  }

  const fromAddr = poolTokenAddress(from);
  const toAddr = poolTokenAddress(to);
  const musd = poolTokenAddress("MUSD");
  const btc = poolTokenAddress("SATS");

  const out: MezoRouteHop[][] = [];
  const seen = new Set<string>();
  const push = (route: MezoRouteHop[]) => {
    const key = routeKey(route);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(route);
  };

  for (const hop of directHopsFor(fromAddr, toAddr, graph)) push([hop]);

  const hubs = [musd, btc].filter((hub) => {
    const h = normAddr(hub);
    return h !== normAddr(fromAddr) && h !== normAddr(toAddr);
  });

  const twoHop: Array<{ route: MezoRouteHop[]; mixed: boolean }> = [];
  for (const hub of hubs) {
    for (const first of directHopsFor(fromAddr, hub, graph)) {
      for (const second of directHopsFor(hub, toAddr, graph)) {
        twoHop.push({ route: [first, second], mixed: first.kind !== second.kind });
      }
    }
  }
  for (const c of twoHop) if (!c.mixed && c.route[0]!.kind === "basic") push(c.route);
  for (const c of twoHop) if (!c.mixed && c.route[0]!.kind === "cl") push(c.route);
  for (const c of twoHop) if (c.mixed) push(c.route);

  if (out.length === 0) throw new Error(`No on-chain route for ${from} → ${to}`);
  return out;
}

/**
 * First candidate in preference order (no quoting). Execution paths should use
 * `buildBestSwapRoutes` in router.ts, which chooses by quoted output.
 */
export function routesFromGraph(
  from: TokenSymbol,
  to: TokenSymbol,
  graph: PoolGraph,
): MezoRouteHop[] {
  return candidateRoutesFromGraph(from, to, graph)[0]!;
}

/**
 * Choose among quoted candidates by output (not stable-first / raw liquidity).
 * A candidate with more venue legs must beat the best fewer-leg output by
 * `multiLegAdvantageBps`. Candidates whose quote failed (null / <= 0) are ignored.
 */
export function pickBestQuotedRoute<T extends { routes: MezoRouteHop[]; amountOut: bigint | null }>(
  candidates: T[],
  multiLegAdvantageBps: number = MULTI_LEG_MIN_ADVANTAGE_BPS,
): T | null {
  const valid = candidates.filter((c) => c.amountOut != null && c.amountOut > 0n);
  if (valid.length === 0) return null;
  const legs = (c: T) => groupSwapLegs(c.routes).length;
  const bps = BigInt(Math.max(0, Math.floor(multiLegAdvantageBps)));
  let best: T | null = null;
  for (const c of [...valid].sort((x, y) => legs(x) - legs(y))) {
    if (!best) {
      best = c;
      continue;
    }
    const bestOut = best.amountOut!;
    const out = c.amountOut!;
    if (legs(c) > legs(best)) {
      if (out > bestOut + (bestOut * bps) / 10_000n) best = c;
    } else if (out > bestOut) {
      best = c;
    }
  }
  return best;
}

/** Hardcoded basic-pool matrix used if factory discovery fails. */
export function buildHardcodedBasicRoutes(from: TokenSymbol, to: TokenSymbol): MezoRouteHop[] {
  if (from === to) throw new Error("Cannot swap a token for itself");
  const factory = getPoolFactory();
  const fromAddr = poolTokenAddress(from);
  const toAddr = poolTokenAddress(to);
  const musd = poolTokenAddress("MUSD");

  if (
    (from === "SATS" && to === "MUSD") ||
    (from === "MUSD" && to === "SATS")
  ) {
    return [{ kind: "basic", from: fromAddr, to: toAddr, stable: false, factory }];
  }
  if (
    (from === "MUSD" && to === "MUSDC") ||
    (from === "MUSDC" && to === "MUSD")
  ) {
    return [{ kind: "basic", from: fromAddr, to: toAddr, stable: true, factory }];
  }
  if (from === "SATS" && to === "MUSDC") {
    return [
      { kind: "basic", from: fromAddr, to: musd, stable: false, factory },
      { kind: "basic", from: musd, to: toAddr, stable: true, factory },
    ];
  }
  if (from === "MUSDC" && to === "SATS") {
    return [
      { kind: "basic", from: fromAddr, to: musd, stable: true, factory },
      { kind: "basic", from: musd, to: toAddr, stable: false, factory },
    ];
  }
  throw new Error(`No on-chain route for ${from} → ${to}`);
}

export async function buildSwapRoutes(from: TokenSymbol, to: TokenSymbol): Promise<MezoRouteHop[]> {
  if (from === to) throw new Error("Cannot swap a token for itself");
  try {
    const graph = await loadPoolGraph();
    return routesFromGraph(from, to, graph);
  } catch (error) {
    if (from === "MEZO" || to === "MEZO") throw error;
    return buildHardcodedBasicRoutes(from, to);
  }
}

export function remainingHops(routes: MezoRouteHop[], completedLegs: number): MezoRouteHop[] {
  const hops: MezoRouteHop[] = [];
  for (const leg of groupSwapLegs(routes).slice(completedLegs)) {
    hops.push(...leg.hops);
  }
  return hops;
}

export function groupSwapLegs(hops: MezoRouteHop[]): SwapLeg[] {
  const legs: SwapLeg[] = [];
  for (const hop of hops) {
    const last = legs[legs.length - 1];
    if (hop.kind === "basic") {
      if (last && last.venue === "basic") {
        last.hops.push(hop);
      } else {
        legs.push({ venue: "basic", hops: [hop] });
      }
      continue;
    }
    if (last && last.venue === "cl") {
      last.hops.push(hop);
    } else {
      legs.push({ venue: "cl", hops: [hop] });
    }
  }
  return legs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value;
}

export function parseRouteHops(raw: unknown): MezoRouteHop[] {
  if (!Array.isArray(raw)) return [];
  const hops: MezoRouteHop[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (item.kind === "cl" || (typeof item.tickSpacing === "number" && item.tokenIn && item.tokenOut)) {
      const tokenIn = asAddress(item.tokenIn);
      const tokenOut = asAddress(item.tokenOut);
      const factory = asAddress(item.factory);
      const pool = asAddress(item.pool);
      const tickSpacing = item.tickSpacing;
      if (!tokenIn || !tokenOut || !factory || !pool || typeof tickSpacing !== "number") continue;
      hops.push({ kind: "cl", tokenIn, tokenOut, tickSpacing, factory, pool });
      continue;
    }
    const from = asAddress(item.from);
    const to = asAddress(item.to);
    const factory = asAddress(item.factory);
    if (!from || !to || !factory || typeof item.stable !== "boolean") continue;
    hops.push({ kind: "basic", from, to, stable: item.stable, factory });
  }
  return hops;
}

export function routeStableDefaultSlippageBps(routes: MezoRouteHop[]): number {
  if (routes.length === 0) return 100;
  let max = 0;
  for (const hop of routes) {
    if (hop.kind === "basic") {
      max = Math.max(max, hop.stable ? 50 : 100);
      continue;
    }
    if (hop.tickSpacing >= 2000) max = Math.max(max, 200);
    else if (hop.tickSpacing >= 200) max = Math.max(max, 100);
    else max = Math.max(max, 50);
  }
  return max || 100;
}

export function encodeClPath(hops: ClRouteHop[]): string {
  if (hops.length === 0) throw new Error("Empty CL path");
  let packed = hops[0]!.tokenIn.toLowerCase().replace(/^0x/, "");
  for (const hop of hops) {
    packed += int24Hex(hop.tickSpacing) + hop.tokenOut.toLowerCase().replace(/^0x/, "");
  }
  return "0x" + packed;
}

function int24Hex(tickSpacing: number): string {
  const v = tickSpacing < 0 ? 0x1000000 + tickSpacing : tickSpacing;
  return v.toString(16).padStart(6, "0");
}
