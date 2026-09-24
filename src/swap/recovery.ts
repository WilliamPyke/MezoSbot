import type { TokenSymbol } from "../tokens.js";
import type { SwapStatus } from "./types.js";

/**
 * Pure helpers for swap crash recovery (claiming, attempt limits, dropped-tx
 * detection, inventory holds). Side effects live in service.ts.
 *
 * Config note: these are hardcoded safe defaults. Planned config.swap knobs:
 * SWAP_RECOVERY_STALE_MS, SWAP_RECOVERY_MAX_ATTEMPTS, SWAP_RECOVERY_DROP_AFTER_MS.
 */

/** A row is eligible once neither the live path nor recovery touched it for this long. */
export const RECOVERY_STALE_MS = 5 * 60 * 1000;
/** Lease written at claim time; other workers skip the row until it expires. */
export const RECOVERY_LEASE_MS = 5 * 60 * 1000;
/** Max times recovery may try (quote + broadcast) the remaining legs before needs_review. */
export const RECOVERY_MAX_ATTEMPTS = 3;
/** Non-first hop unknown to the node for this long (nonce not provably consumed) → needs_review. */
export const RECOVERY_DROP_AFTER_MS = 15 * 60 * 1000;
/** First hop unknown to the node for this long → treat as dropped (safe refund; legacy rule). */
export const RECOVERY_FIRST_HOP_DROP_MS = 60 * 60 * 1000;
/** Tx visible in the mempool but unmined for this long → needs_review. */
export const RECOVERY_MEMPOOL_STUCK_MS = 60 * 60 * 1000;
/** Minimum age before a nonce-consumed / unknown tx is treated as dropped (indexer lag guard). */
export const RECOVERY_NONCE_DROP_MIN_AGE_MS = 2 * 60 * 1000;

/** Statuses whose funds are still escrowed on the swap row (not yet credited or refunded). */
export const ESCROWED_SWAP_STATUSES: readonly SwapStatus[] = ["reserved", "submitted", "needs_review"];
/** Statuses the recovery worker may act on automatically. */
export const RECOVERABLE_SWAP_STATUSES: readonly SwapStatus[] = ["reserved", "submitted"];

/** Swap row metadata fields used by execution progress and recovery. */
export type SwapProgressMeta = {
  tx_hashes?: string[];
  /** Nonce each hash was signed with (dropped detection). */
  tx_nonces?: Record<string, number>;
  /** ISO time each hash was signed. */
  tx_signed_at?: Record<string, string>;
  legs_completed?: number;
  legs_total?: number;
  last_progress_at?: string;
  /** Treasury inventory held for this swap (intermediate leg output / uncredited final output). */
  held_token?: TokenSymbol | null;
  held_amount?: number | null;
  /** Per-leg amountOutMinimum used by the live path (stringified bigint units). */
  leg_min_outs?: string[];
  recovery_attempts?: number;
  recovery_lease_until?: string;
  last_recovery_at?: string;
  needs_review?: boolean;
  needs_review_reason?: string;
  needs_review_at?: string;
  /** Hashes removed from tx_hashes because they reverted or were dropped. */
  dropped_tx_hashes?: string[];
  slippage_bps?: number;
};

export function progressMeta(metadata: Record<string, unknown> | null | undefined): SwapProgressMeta {
  return (metadata ?? {}) as SwapProgressMeta;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Last time anything (live path per-leg progress or recovery) touched the row. */
export function lastActivityMs(row: { updated_at: string; created_at: string; metadata: Record<string, unknown> | null }): number {
  const meta = progressMeta(row.metadata);
  const candidates = [parseTime(row.updated_at), parseTime(meta.last_progress_at), parseTime(row.created_at)]
    .filter((t): t is number => t != null);
  return candidates.length ? Math.max(...candidates) : 0;
}

/** Staleness is based on last progress / updated_at, never on created_at alone. */
export function isStaleForRecovery(
  row: { updated_at: string; created_at: string; metadata: Record<string, unknown> | null },
  now: number = Date.now(),
  staleMs: number = RECOVERY_STALE_MS,
): boolean {
  return now - lastActivityMs(row) >= staleMs;
}

export function recoveryLeaseActive(metadata: Record<string, unknown> | null | undefined, now: number = Date.now()): boolean {
  const until = parseTime(progressMeta(metadata).recovery_lease_until);
  return until != null && until > now;
}

export function recoveryAttemptAllowed(attempts: number, maxAttempts: number = RECOVERY_MAX_ATTEMPTS): boolean {
  return Math.max(0, Math.floor(attempts || 0)) < maxAttempts;
}

/** Whether a stale row should be considered by the recovery worker at all. */
export function eligibleForRecovery(
  row: { status: SwapStatus; updated_at: string; created_at: string; metadata: Record<string, unknown> | null },
  now: number = Date.now(),
): boolean {
  if (!RECOVERABLE_SWAP_STATUSES.includes(row.status)) return false;
  const meta = progressMeta(row.metadata);
  if (meta.needs_review) return false;
  if (recoveryLeaseActive(row.metadata, now)) return false;
  return isStaleForRecovery(row, now);
}

function sameHashes(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((h, i) => h.toLowerCase() === (y[i] ?? "").toLowerCase());
}

/**
 * After acquiring the in-process lock, recovery re-reads the row; it proceeds
 * only if nothing moved since its claim (status, updated_at, hashes, legs).
 */
export function recoverySnapshotUnchanged(
  claimed: { status: SwapStatus; updated_at: string; tx_hash: string | null; metadata: Record<string, unknown> | null },
  current: { status: SwapStatus; updated_at: string; tx_hash: string | null; metadata: Record<string, unknown> | null },
): boolean {
  if (claimed.status !== current.status) return false;
  if (parseTime(claimed.updated_at) !== parseTime(current.updated_at)) return false;
  if ((claimed.tx_hash ?? "") !== (current.tx_hash ?? "")) return false;
  const a = progressMeta(claimed.metadata);
  const b = progressMeta(current.metadata);
  if ((a.legs_completed ?? 0) !== (b.legs_completed ?? 0)) return false;
  return sameHashes(a.tx_hashes, b.tx_hashes);
}

export type MissingReceiptAssessment = "wait" | "dropped" | "needs_review";

/**
 * Classify a hash that has no receipt yet.
 * - mined per the node (blockNumber) but no receipt → indexer lag, wait
 * - nonce provably consumed by another tx → dropped/replaced
 * - in mempool too long → needs_review
 * - unknown to the node: first hop → dropped after RECOVERY_FIRST_HOP_DROP_MS;
 *   later hop → needs_review after RECOVERY_DROP_AFTER_MS
 */
export function assessMissingReceipt(input: {
  txKnown: boolean;
  txMined: boolean;
  txNonce: number | null;
  latestNonce: number | null;
  ageMs: number;
  firstHop: boolean;
}): MissingReceiptAssessment {
  if (input.txMined) return "wait";
  const nonceConsumed =
    input.txNonce != null && input.latestNonce != null && input.latestNonce > input.txNonce;
  if (nonceConsumed && input.ageMs >= RECOVERY_NONCE_DROP_MIN_AGE_MS) return "dropped";
  if (input.txKnown) {
    return input.ageMs >= RECOVERY_MEMPOOL_STUCK_MS ? "needs_review" : "wait";
  }
  if (input.firstHop) {
    return input.ageMs >= RECOVERY_FIRST_HOP_DROP_MS ? "dropped" : "wait";
  }
  return input.ageMs >= RECOVERY_DROP_AFTER_MS ? "needs_review" : "wait";
}

/**
 * Treasury inventory held by in-flight swaps for `token` (intermediate outputs
 * between legs, and final outputs not yet credited). Subtracted from on-chain
 * balance before computing free inventory so internal fills cannot spend it.
 */
export function sumInventoryHolds(
  rows: Array<{ status: SwapStatus; metadata: Record<string, unknown> | null }>,
  token: TokenSymbol,
): number {
  let total = 0;
  for (const row of rows) {
    if (!ESCROWED_SWAP_STATUSES.includes(row.status)) continue;
    const meta = progressMeta(row.metadata);
    if (meta.held_token !== token) continue;
    const amount = Number(meta.held_amount ?? 0);
    if (Number.isFinite(amount) && amount > 0) total += amount;
  }
  return total;
}
