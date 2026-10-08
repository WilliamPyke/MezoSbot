export function meetsPublicDepositMinimum(amountAtomic: bigint, minimumAtomic: bigint, isAdmin: boolean): boolean {
  return isAdmin || amountAtomic >= minimumAtomic;
}

export function preservesGasReserve(
  availableWei: bigint,
  operationCostWei: bigint,
  protectedBackingWei: bigint,
  minimumReserveWei: bigint,
): boolean {
  return availableWei - operationCostWei >= protectedBackingWei + minimumReserveWei;
}

export function nextSweepTime(nowMs: number, delayMs: number): number {
  return nowMs + Math.max(0, delayMs);
}

export function hasAllowedDepositRole(
  memberRoleIds: Iterable<string>,
  allowedRoleIds: readonly string[],
): boolean {
  const allowed = new Set(allowedRoleIds);
  for (const roleId of memberRoleIds) {
    if (allowed.has(roleId)) return true;
  }
  return false;
}

export function withdrawalGasFundingShortfall(
  treasuryBalanceWei: bigint,
  gasCostWei: bigint,
): bigint {
  return gasCostWei > treasuryBalanceWei ? gasCostWei - treasuryBalanceWei : 0n;
}

/** A native SATS withdrawal can only send what the treasury hot wallet actually holds. */
export function satsWithdrawalCovered(treasuryWei: bigint, amountWei: bigint): boolean {
  return amountWei <= treasuryWei;
}

/**
 * Minting SATS (admin credit, unbacked rewards) is allowed only when the hot
 * wallet already covers existing liabilities, the new mint, and the gas reserve.
 */
export function satsMintCovered(
  treasuryWei: bigint,
  liabilityWei: bigint,
  mintWei: bigint,
  reserveWei: bigint,
): boolean {
  return treasuryWei >= liabilityWei + mintWei + reserveWei;
}

export function satsBackingShortfallWei(
  treasuryWei: bigint,
  liabilityWei: bigint,
  reserveWei: bigint,
): bigint {
  const required = liabilityWei + reserveWei;
  return required > treasuryWei ? required - treasuryWei : 0n;
}

/**
 * Native SATS may leave the treasury (withdrawal, on-chain swap input) only
 * while the hot wallet covers every liability plus the gas reserve. An exit
 * does not change the excess, but while under-backed it would let the first
 * users out drain backing that belongs to everyone else.
 */
export function satsExitAllowed(
  treasuryWei: bigint,
  liabilityWei: bigint,
  reserveWei: bigint,
): boolean {
  return satsBackingShortfallWei(treasuryWei, liabilityWei, reserveWei) === 0n;
}

export type InFlightSatsRows = {
  /** Pending withdrawals: the amount (and an ERC-20's SATS gas reservation) is debited but unsent. */
  withdrawals: Array<{ amount_sats: unknown; token?: unknown; gas_reserved_sats?: unknown }>;
  /** Active drops: the unclaimed remainder was already debited from the creator. */
  drops: Array<{ per_claim_sats: unknown; max_claims: unknown; claims_count: unknown; token?: unknown }>;
  /** Funded arcade escrow rows. */
  arcadeEscrow: Array<{ amount_sats: unknown }>;
  /** Escrowed swaps (reserved/submitted/needs_review). */
  swaps: Array<{
    from_token: unknown;
    from_amount: unknown;
    gas_reserved_sats?: unknown;
    gas_refunded_sats?: unknown;
    gas_settled?: unknown;
  }>;
};

export type InFlightSatsLiabilities = {
  pendingWithdrawals: number;
  dropRemainders: number;
  arcadeEscrow: number;
  swapEscrow: number;
  total: number;
};

function positiveNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isSatsToken(token: unknown): boolean {
  return token == null || token === "SATS";
}

/**
 * SATS already debited from users but held outside users.balance_sats, which
 * get_protocol_operational_snapshot does not count. Swap terms mirror
 * get_token_liabilities (SATS input plus unsettled gas reservations).
 */
export function sumInFlightSatsLiabilities(rows: InFlightSatsRows): InFlightSatsLiabilities {
  let pendingWithdrawals = 0;
  for (const row of rows.withdrawals) {
    pendingWithdrawals += isSatsToken(row.token)
      ? positiveNumber(row.amount_sats)
      : positiveNumber(row.gas_reserved_sats);
  }
  let dropRemainders = 0;
  for (const row of rows.drops) {
    if (!isSatsToken(row.token)) continue;
    const remainingClaims = positiveNumber(row.max_claims) - positiveNumber(row.claims_count);
    if (remainingClaims > 0) dropRemainders += remainingClaims * positiveNumber(row.per_claim_sats);
  }
  let arcadeEscrow = 0;
  for (const row of rows.arcadeEscrow) arcadeEscrow += positiveNumber(row.amount_sats);
  let swapEscrow = 0;
  for (const row of rows.swaps) {
    if (row.from_token === "SATS") swapEscrow += positiveNumber(row.from_amount);
    if (row.gas_settled !== true) {
      swapEscrow += Math.max(0, positiveNumber(row.gas_reserved_sats) - positiveNumber(row.gas_refunded_sats));
    }
  }
  return {
    pendingWithdrawals,
    dropRemainders,
    arcadeEscrow,
    swapEscrow,
    total: pendingWithdrawals + dropRemainders + arcadeEscrow + swapEscrow,
  };
}

/* ─────────── Database write outcomes ─────────── */

/** Code carried by a credit that failed before any write was sent. */
export const CREDIT_NOT_ATTEMPTED_CODE = "CREDIT_NOT_ATTEMPTED";

/**
 * True only when a failed database call provably did not apply: the server
 * answered with a PostgREST or Postgres error (the statement's transaction
 * rolled back), or the call was never sent. Network failures and gateway
 * pages arrive from postgrest-js with an empty or missing code and may have
 * committed, so they are ambiguous. SQLSTATE class 08 (connection exception)
 * can surface after a commit, so it is ambiguous too.
 */
export function isDefiniteDbFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return false;
  if (code === CREDIT_NOT_ATTEMPTED_CODE) return true;
  if (/^PGRST\d{3}$/.test(code)) return true;
  return /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/.test(code) && !code.startsWith("08");
}

export type CreditOutcome = "credited" | "failed" | "unconfirmed";

/** Totals for a batch of independent credits after a single upfront debit. */
export function summarizeCredits<T extends { amount: number; outcome: CreditOutcome }>(results: readonly T[]): {
  credited: T[];
  failed: T[];
  unconfirmed: T[];
  creditedTotal: number;
  failedTotal: number;
  unconfirmedTotal: number;
} {
  const credited = results.filter((result) => result.outcome === "credited");
  const failed = results.filter((result) => result.outcome === "failed");
  const unconfirmed = results.filter((result) => result.outcome === "unconfirmed");
  const total = (rows: T[]) => rows.reduce((sum, row) => sum + row.amount, 0);
  return {
    credited,
    failed,
    unconfirmed,
    creditedTotal: total(credited),
    failedTotal: total(failed),
    unconfirmedTotal: total(unconfirmed),
  };
}

/* ─────────── Withdrawal outcome ─────────── */

export type WithdrawalOutcome = "completed" | "refund" | "pending";
export type WithdrawalOutcomeReason =
  | "confirmed"
  | "never_broadcast"
  | "reverted"
  | "dropped"
  | "unknown_status"
  | "lookup_failed"
  | "mined_without_receipt"
  | "awaiting_receipt";

/**
 * A consumed nonce only proves a drop once the tx is at least this old;
 * receipt indexers can briefly lag the account nonce (same guard as swaps).
 */
export const WITHDRAWAL_DROP_MIN_AGE_MS = 2 * 60_000;

export type WithdrawalReceiptLike = {
  status?: unknown;
  gasUsed?: string | null;
  effectiveGasPrice?: string | null;
};

export type WithdrawalObservation = {
  /** False only when the signed tx provably never left this process. */
  broadcast: boolean;
  /** undefined = lookup failed (unknown); null = the node has no receipt. */
  receipt?: WithdrawalReceiptLike | null;
  /** eth_getTransactionByHash reports a blockNumber (the receipt may lag). */
  txMined?: boolean;
  /** Nonce the withdrawal tx was signed with; null when unknown. */
  txNonce: number | null;
  /** Treasury mined nonce (getTransactionCount 'latest'), read BEFORE the receipt. */
  minedNonce: number | null;
  /** Time since the tx was signed (row creation time for legacy rows). */
  signedAgeMs: number;
};

/** JSON-RPC receipt status. Anything other than an explicit 0 or 1 is unknown. */
export function parseReceiptStatus(status: unknown): 0 | 1 | null {
  if (typeof status === "number") return status === 0 || status === 1 ? status : null;
  if (typeof status === "bigint") return status === 0n ? 0 : status === 1n ? 1 : null;
  if (typeof status !== "string" || !/^0x[0-9a-f]+$/i.test(status)) return null;
  const parsed = BigInt(status);
  return parsed === 0n ? 0 : parsed === 1n ? 1 : null;
}

/**
 * Decide a withdrawal from one observation. Refund only when it is proven the
 * tx can never land: it never left the process, it reverted, or the treasury's
 * mined nonce moved past it with no receipt for our hash. Every uncertain
 * state (timeouts, RPC errors, malformed receipts) stays pending.
 */
export function explainWithdrawalOutcome(
  input: WithdrawalObservation,
): { outcome: WithdrawalOutcome; reason: WithdrawalOutcomeReason } {
  if (!input.broadcast) return { outcome: "refund", reason: "never_broadcast" };
  const { receipt } = input;
  if (receipt === undefined) return { outcome: "pending", reason: "lookup_failed" };
  if (receipt !== null) {
    const status = parseReceiptStatus(receipt.status);
    if (status === 1) return { outcome: "completed", reason: "confirmed" };
    if (status === 0) return { outcome: "refund", reason: "reverted" };
    return { outcome: "pending", reason: "unknown_status" };
  }
  if (input.txMined) return { outcome: "pending", reason: "mined_without_receipt" };
  const nonceConsumed = input.txNonce != null
    && input.minedNonce != null
    && input.minedNonce > input.txNonce;
  if (nonceConsumed && input.signedAgeMs >= WITHDRAWAL_DROP_MIN_AGE_MS) {
    return { outcome: "refund", reason: "dropped" };
  }
  return { outcome: "pending", reason: "awaiting_receipt" };
}

export function classifyWithdrawalOutcome(input: WithdrawalObservation): WithdrawalOutcome {
  return explainWithdrawalOutcome(input).outcome;
}

export type SettledWithdrawalState = "completed" | "refunded" | "refund_pending" | "pending";

/**
 * What to tell the user after finalizing. A row another worker settled first
 * ("already_final") is reported by its real status: only refund_withdrawal_v2
 * sets 'failed' (after crediting) and only complete_withdrawal_v2 sets
 * 'completed'.
 */
export function settledState(final: {
  state: "completed" | "refunded" | "pending" | "refund_pending" | "already_final";
  currentStatus?: string | null;
}): SettledWithdrawalState {
  if (final.state !== "already_final") return final.state;
  if (final.currentStatus === "completed") return "completed";
  if (final.currentStatus === "failed") return "refunded";
  return "pending";
}

export type WithdrawalPollResult = {
  outcome: WithdrawalOutcome;
  reason: WithdrawalOutcomeReason;
  observation: WithdrawalObservation | null;
};

/**
 * Poll a broadcast withdrawal until it is decided or attempts run out (then
 * pending). A drop verdict is re-observed after another interval before it is
 * trusted, so one lagging read can never trigger a refund.
 */
export async function pollWithdrawalOutcome(input: {
  attempts: number;
  intervalMs: number;
  observe: () => Promise<WithdrawalObservation>;
  sleep?: (ms: number) => Promise<void>;
  onObserveError?: (error: unknown, attempt: number) => void;
}): Promise<WithdrawalPollResult> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: WithdrawalPollResult = { outcome: "pending", reason: "lookup_failed", observation: null };
  for (let attempt = 0; attempt < input.attempts; attempt++) {
    await sleep(input.intervalMs);
    let observation: WithdrawalObservation;
    try {
      observation = await input.observe();
    } catch (error) {
      input.onObserveError?.(error, attempt);
      continue;
    }
    const verdict = explainWithdrawalOutcome(observation);
    last = { ...verdict, observation };
    if (verdict.outcome === "pending") continue;
    if (verdict.reason !== "dropped") return last;

    await sleep(input.intervalMs);
    try {
      const recheck = await input.observe();
      last = { ...explainWithdrawalOutcome(recheck), observation: recheck };
      if (last.outcome !== "pending") return last;
    } catch (error) {
      input.onObserveError?.(error, attempt);
      last = { outcome: "pending", reason: "lookup_failed", observation };
    }
  }
  return last;
}
