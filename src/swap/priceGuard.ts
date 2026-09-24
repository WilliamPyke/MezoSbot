import type { TokenSymbol } from "../tokens.js";
import type { MezoRouteHop } from "./types.js";

/**
 * Guards for internal (inventory) fills, which are priced off a live pool quote.
 * A single-block pool manipulation must not let someone buy treasury inventory
 * at a fake price, so internal fills are only allowed when the live rate sits
 * within a band of a median of recent samples. Otherwise the swap goes on-chain
 * (where the attacker would be trading against their own manipulation).
 *
 * Config note: hardcoded safe defaults. Planned config.swap knobs:
 * SWAP_INTERNAL_DISABLED_TOKENS (default "MEZO"), SWAP_INTERNAL_MAX_DEVIATION_BPS
 * (default 150), and SWAP_MAX_INTERNAL_OUT_MEZO default lowered to 0.
 */

/** Tokens whose pairs never fill internally (thin / CL-only markets). */
export const INTERNAL_DISABLED_TOKENS: readonly TokenSymbol[] = ["MEZO"];
/** Hard cap on a single internal MEZO fill (0 = disabled), overrides config. */
export const MEZO_MAX_INTERNAL_OUT = 0;
/** Max deviation of the live rate from the reference median. */
export const INTERNAL_MAX_DEVIATION_BPS = 150;
/** At most one sample per pair per interval (quote spam cannot flood the window). */
export const MID_SAMPLE_MIN_INTERVAL_MS = 20_000;
export const MID_SAMPLE_WINDOW_MS = 30 * 60 * 1000;
/** Need this many samples spanning at least MID_SAMPLE_MIN_SPAN_MS before trusting a reference. */
export const MID_SAMPLE_MIN_COUNT = 3;
export const MID_SAMPLE_MIN_SPAN_MS = 2 * 60 * 1000;
export const MID_SAMPLE_MAX = 64;

export function internalDisabledForPair(fromToken: TokenSymbol, toToken: TokenSymbol): boolean {
  return INTERNAL_DISABLED_TOKENS.includes(fromToken) || INTERNAL_DISABLED_TOKENS.includes(toToken);
}

export function withinPriceBand(liveRate: number, referenceRate: number, maxDeviationBps: number): boolean {
  if (!(liveRate > 0) || !(referenceRate > 0)) return false;
  const deviationBps = (Math.abs(liveRate - referenceRate) / referenceRate) * 10_000;
  return deviationBps <= maxDeviationBps + 1e-9;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type Sample = { at: number; rate: number };

/** Per-process ring of recent pool mid samples per directed pair. */
export class MidPriceCache {
  private readonly samples = new Map<string, Sample[]>();

  private key(fromToken: TokenSymbol, toToken: TokenSymbol): string {
    return `${fromToken}->${toToken}`;
  }

  record(fromToken: TokenSymbol, toToken: TokenSymbol, rate: number, now: number = Date.now()): void {
    if (!(rate > 0) || !Number.isFinite(rate)) return;
    const key = this.key(fromToken, toToken);
    const list = (this.samples.get(key) ?? []).filter((s) => now - s.at <= MID_SAMPLE_WINDOW_MS);
    const last = list[list.length - 1];
    if (last && now - last.at < MID_SAMPLE_MIN_INTERVAL_MS) {
      this.samples.set(key, list);
      return;
    }
    list.push({ at: now, rate });
    while (list.length > MID_SAMPLE_MAX) list.shift();
    this.samples.set(key, list);
  }

  /** Median of in-window samples, or null if there is not enough history. */
  reference(fromToken: TokenSymbol, toToken: TokenSymbol, now: number = Date.now()): number | null {
    const list = (this.samples.get(this.key(fromToken, toToken)) ?? [])
      .filter((s) => now - s.at <= MID_SAMPLE_WINDOW_MS);
    if (list.length < MID_SAMPLE_MIN_COUNT) return null;
    const span = list[list.length - 1]!.at - list[0]!.at;
    if (span < MID_SAMPLE_MIN_SPAN_MS) return null;
    return median(list.map((s) => s.rate));
  }
}

export const midPriceCache = new MidPriceCache();

export type InternalPriceCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether an internal fill at `liveRate` (to per from) is safe. Checks
 * against the reference first, then records the live sample.
 */
export function checkInternalFillPrice(input: {
  fromToken: TokenSymbol;
  toToken: TokenSymbol;
  routes: MezoRouteHop[];
  liveRate: number;
  cache?: MidPriceCache;
  now?: number;
  maxDeviationBps?: number;
}): InternalPriceCheck {
  const cache = input.cache ?? midPriceCache;
  const now = input.now ?? Date.now();
  const reference = cache.reference(input.fromToken, input.toToken, now);
  cache.record(input.fromToken, input.toToken, input.liveRate, now);

  if (internalDisabledForPair(input.fromToken, input.toToken)) {
    return { ok: false, reason: "internal fills disabled for this pair" };
  }
  // Spot CL quotes (tick walk at the current price) are the cheapest to move.
  if (input.routes.some((hop) => hop.kind === "cl")) {
    return { ok: false, reason: "internal fills disabled for concentrated-liquidity routes" };
  }
  if (reference == null) {
    return { ok: false, reason: "no reference price yet for internal fill" };
  }
  if (!withinPriceBand(input.liveRate, reference, input.maxDeviationBps ?? INTERNAL_MAX_DEVIATION_BPS)) {
    return { ok: false, reason: "live price outside internal sanity band" };
  }
  return { ok: true };
}
