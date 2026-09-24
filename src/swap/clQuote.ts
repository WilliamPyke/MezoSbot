import { ethers } from "ethers";
import { rawRpcCall } from "../evm.js";
import type { ClRouteHop } from "./types.js";

const Q96 = 2n ** 96n;
const FEE_DENOM = 1_000_000n;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const MAX_TICK_STEPS = 64;

const POOL_IFACE = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
]);

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  return (a * b) / denominator;
}

export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const prod = a * b;
  const result = prod / denominator;
  return prod % denominator > 0n ? result + 1n : result;
}

function divRoundingUp(x: bigint, y: bigint): bigint {
  const result = x / y;
  return x % y > 0n ? result + 1n : result;
}

export function getAmount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    const tmp = sqrtRatioAX96;
    sqrtRatioAX96 = sqrtRatioBX96;
    sqrtRatioBX96 = tmp;
  }
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  if (roundUp) {
    return divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96), sqrtRatioAX96);
  }
  return (numerator1 * numerator2 / sqrtRatioBX96) / sqrtRatioAX96;
}

export function getAmount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    const tmp = sqrtRatioAX96;
    sqrtRatioAX96 = sqrtRatioBX96;
    sqrtRatioBX96 = tmp;
  }
  if (roundUp) return mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
  return mulDiv(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
}

function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << 96n;
  if (add) {
    const product = amount * sqrtPX96;
    if (product / amount === sqrtPX96) {
      const denominator = numerator1 + product;
      if (denominator >= numerator1) {
        return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
      }
    }
    return divRoundingUp(numerator1, numerator1 / sqrtPX96 + amount);
  }
  const product = amount * sqrtPX96;
  if (product / amount !== sqrtPX96) throw new Error("sqrt price overflow");
  if (numerator1 <= product) throw new Error("sqrt price underflow");
  return mulDivRoundingUp(numerator1, sqrtPX96, numerator1 - product);
}

function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (add) {
    const quotient = amount <= 2n ** 160n - 1n
      ? (amount << 96n) / liquidity
      : mulDiv(amount, Q96, liquidity);
    return sqrtPX96 + quotient;
  }
  const quotient = mulDivRoundingUp(amount, Q96, liquidity);
  if (sqrtPX96 <= quotient) throw new Error("sqrt price underflow");
  return sqrtPX96 - quotient;
}

function getNextSqrtPriceFromInput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (sqrtPX96 === 0n) throw new Error("invalid sqrt price");
  if (liquidity === 0n) throw new Error("zero liquidity");
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
}

type SwapStep = {
  sqrtRatioNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
};

export function computeSwapStep(
  sqrtRatioCurrentX96: bigint,
  sqrtRatioTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): SwapStep {
  const zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;
  const exactIn = amountRemaining >= 0n;

  let amountIn: bigint;
  let amountOut: bigint;
  let sqrtRatioNextX96: bigint;

  if (exactIn) {
    const amountRemainingLessFee = mulDiv(amountRemaining, FEE_DENOM - feePips, FEE_DENOM);
    amountIn = zeroForOne
      ? getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
      : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);
    if (amountRemainingLessFee >= amountIn) {
      sqrtRatioNextX96 = sqrtRatioTargetX96;
    } else {
      sqrtRatioNextX96 = getNextSqrtPriceFromInput(
        sqrtRatioCurrentX96,
        liquidity,
        amountRemainingLessFee,
        zeroForOne,
      );
      amountIn = zeroForOne
        ? getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true)
        : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
    }
  } else {
    throw new Error("exact-output CL quotes are not supported");
  }

  const max = sqrtRatioTargetX96 === sqrtRatioNextX96;
  if (!max) {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false);
  }

  if (!exactIn && amountOut > -amountRemaining) {
    amountOut = -amountRemaining;
  }

  let feeAmount: bigint;
  if (exactIn && !max) {
    feeAmount = amountRemaining - amountIn;
  } else {
    feeAmount = mulDivRoundingUp(amountIn, feePips, FEE_DENOM - feePips);
  }

  return { sqrtRatioNextX96, amountIn, amountOut, feeAmount };
}

function mostSignificantBit(x: bigint): number {
  if (x === 0n) throw new Error("msb of zero");
  return x.toString(2).length - 1;
}

function leastSignificantBit(x: bigint): number {
  if (x === 0n) throw new Error("lsb of zero");
  let n = 0;
  while ((x & 1n) === 0n) {
    x >>= 1n;
    n += 1;
  }
  return n;
}

/** Compress a tick toward negative infinity by tickSpacing. */
export function compressTick(tick: number, tickSpacing: number): number {
  let compressed = Math.trunc(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return compressed;
}

export function tickWordPosition(compressed: number): { wordPos: number; bitPos: number } {
  return { wordPos: compressed >> 8, bitPos: compressed & 0xff };
}

function nextInitializedTickWithinOneWord(input: {
  bitmap: bigint;
  tick: number;
  tickSpacing: number;
  lte: boolean;
}): { next: number; initialized: boolean } {
  const { bitmap, tick, tickSpacing, lte } = input;
  const compressed = compressTick(tick, tickSpacing);

  if (lte) {
    const { bitPos } = tickWordPosition(compressed);
    const mask = (1n << BigInt(bitPos)) - 1n + (1n << BigInt(bitPos));
    const masked = bitmap & mask;
    const initialized = masked !== 0n;
    const nextCompressed = initialized
      ? compressed - (bitPos - mostSignificantBit(masked))
      : compressed - bitPos;
    return { next: nextCompressed * tickSpacing, initialized };
  }

  const { bitPos } = tickWordPosition(compressed + 1);
  const mask = ~((1n << BigInt(bitPos)) - 1n) & ((1n << 256n) - 1n);
  const masked = bitmap & mask;
  const initialized = masked !== 0n;
  const nextCompressed = initialized
    ? compressed + 1 + (leastSignificantBit(masked) - bitPos)
    : compressed + 1 + (255 - bitPos);
  return { next: nextCompressed * tickSpacing, initialized };
}

/** Block tag for eth_call: "latest" or a hex block number (pinned quote). */
export type QuoteBlockTag = string;

/** Resolve a hex block number so every read in one quote sees the same state. */
export async function pinQuoteBlock(): Promise<QuoteBlockTag> {
  const raw = await rawRpcCall("eth_blockNumber", [], { rateLimited: true });
  if (typeof raw !== "string" || !raw.startsWith("0x")) throw new Error("eth_blockNumber returned no block");
  return raw;
}

async function ethCall(to: string, data: string, blockTag: QuoteBlockTag): Promise<string> {
  const raw = await rawRpcCall("eth_call", [{ to, data }, blockTag], { rateLimited: true });
  if (typeof raw !== "string" || raw === "0x") throw new Error("empty eth_call");
  return raw;
}

async function readSlot0(pool: string, blockTag: QuoteBlockTag): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const raw = await ethCall(pool, POOL_IFACE.encodeFunctionData("slot0", []), blockTag);
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  const sqrtPriceX96 = BigInt("0x" + hex.slice(0, 64));
  const tick = Number(BigInt.asIntN(256, BigInt("0x" + hex.slice(64, 128))));
  return { sqrtPriceX96, tick };
}

async function readLiquidity(pool: string, blockTag: QuoteBlockTag): Promise<bigint> {
  const raw = await ethCall(pool, POOL_IFACE.encodeFunctionData("liquidity", []), blockTag);
  return BigInt(raw);
}

async function readFee(pool: string, tickSpacing: number, blockTag: QuoteBlockTag): Promise<bigint> {
  try {
    const raw = await ethCall(pool, POOL_IFACE.encodeFunctionData("fee", []), blockTag);
    const fee = BigInt(raw);
    if (fee > 0n && fee < FEE_DENOM) return fee;
  } catch {
    // fall through to tick-spacing defaults
  }
  if (tickSpacing >= 2000) return 10_000n;
  if (tickSpacing >= 200) return 3_000n;
  if (tickSpacing >= 100) return 500n;
  if (tickSpacing >= 10) return 500n;
  return 100n;
}

async function readBitmap(pool: string, wordPos: number, blockTag: QuoteBlockTag): Promise<bigint> {
  const data = POOL_IFACE.encodeFunctionData("tickBitmap", [wordPos]);
  const raw = await ethCall(pool, data, blockTag);
  return BigInt(raw);
}

async function readLiquidityNet(pool: string, tick: number, blockTag: QuoteBlockTag): Promise<bigint> {
  const data = POOL_IFACE.encodeFunctionData("ticks", [tick]);
  const raw = await ethCall(pool, data, blockTag);
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (hex.length < 128) return 0n;
  return BigInt.asIntN(256, BigInt("0x" + hex.slice(64, 128)));
}

/**
 * Exact-in quote against a Slipstream CL pool by walking initialized ticks.
 * Does not require a Quoter contract or treasury balances.
 *
 * Every read (slot0, liquidity, fee, bitmaps, ticks) is pinned to one block so
 * the walk never mixes state from different blocks. Throws rather than return
 * a partial fill when the walk would exceed MAX_TICK_STEPS or hit the price limit.
 */
export async function quoteClExactInput(
  hop: ClRouteHop,
  amountIn: bigint,
  options: { blockTag?: QuoteBlockTag } = {},
): Promise<bigint> {
  if (amountIn <= 0n) throw new Error("Amount too small");
  const blockTag = options.blockTag ?? await pinQuoteBlock();
  const tokenIn = hop.tokenIn.toLowerCase();
  const tokenOut = hop.tokenOut.toLowerCase();
  const zeroForOne = tokenIn < tokenOut;

  const [{ sqrtPriceX96, tick }, liquidity, feePips] = await Promise.all([
    readSlot0(hop.pool, blockTag),
    readLiquidity(hop.pool, blockTag),
    readFee(hop.pool, hop.tickSpacing, blockTag),
  ]);
  if (liquidity === 0n) throw new Error("CL pool has zero in-range liquidity");

  const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  let sqrtPrice = sqrtPriceX96;
  let currentTick = tick;
  let liq = liquidity;
  let amountRemaining = amountIn;
  let amountCalculated = 0n;

  let steps = 0;
  while (amountRemaining > 0n) {
    if (steps >= MAX_TICK_STEPS) {
      throw new Error(`CL quote exceeded ${MAX_TICK_STEPS} tick steps — amount too large for pool depth`);
    }
    steps += 1;
    if (liq === 0n) throw new Error("CL quote ran out of liquidity");

    const compressed = compressTick(currentTick, hop.tickSpacing);
    const { wordPos } = tickWordPosition(zeroForOne ? compressed : compressed + 1);
    const bitmap = await readBitmap(hop.pool, wordPos, blockTag);
    const { next, initialized } = nextInitializedTickWithinOneWord({
      bitmap,
      tick: currentTick,
      tickSpacing: hop.tickSpacing,
      lte: zeroForOne,
    });

    let tickNext = next;
    if (tickNext < -887272) tickNext = -887272;
    if (tickNext > 887272) tickNext = 887272;

    const sqrtTarget = tickToSqrtPriceX96(tickNext);
    const stepTarget = (
      zeroForOne
        ? (sqrtTarget < sqrtPriceLimitX96 ? sqrtPriceLimitX96 : sqrtTarget)
        : (sqrtTarget > sqrtPriceLimitX96 ? sqrtPriceLimitX96 : sqrtTarget)
    );

    const swapStep = computeSwapStep(sqrtPrice, stepTarget, liq, amountRemaining, feePips);
    sqrtPrice = swapStep.sqrtRatioNextX96;
    amountRemaining -= swapStep.amountIn + swapStep.feeAmount;
    amountCalculated += swapStep.amountOut;

    if (sqrtPrice === sqrtPriceLimitX96) {
      if (amountRemaining > 0n) throw new Error("CL quote hit the price limit — insufficient pool liquidity");
      break;
    }

    if (sqrtPrice === sqrtTarget) {
      if (initialized) {
        const net = await readLiquidityNet(hop.pool, tickNext, blockTag);
        liq = zeroForOne ? liq - net : liq + net;
        if (liq < 0n) throw new Error("CL liquidity went negative");
      }
      currentTick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtPrice !== sqrtPriceX96) {
      currentTick = sqrtPriceToTick(sqrtPrice);
    }
  }

  if (amountCalculated <= 0n) throw new Error("Quoted CL output is zero — check pool liquidity");
  return amountCalculated;
}

/** Tick → sqrtPriceX96 (Uniswap TickMath.getSqrtRatioAtTick). */
export function tickToSqrtPriceX96(tick: number): bigint {
  if (tick < -887272 || tick > 887272) throw new Error("tick out of range");
  const absTick = tick < 0 ? -tick : tick;
  let ratio = (absTick & 0x1) !== 0
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e89d68n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Inverse of tickToSqrtPriceX96, used only to update currentTick after a partial step. */
export function sqrtPriceToTick(sqrtPriceX96: bigint): number {
  let low = -887272;
  let high = 887272;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const midPrice = tickToSqrtPriceX96(mid);
    if (midPrice === sqrtPriceX96) return mid;
    if (midPrice < sqrtPriceX96) low = mid + 1;
    else high = mid - 1;
  }
  return high;
}
