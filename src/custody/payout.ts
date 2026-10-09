import { ethers } from "ethers";
import { config, satsToTokenUnits, tokenUnitsToSats } from "../config.js";
import {
  WITHDRAWAL_DROP_MIN_AGE_MS,
  explainWithdrawalOutcome,
  parseReceiptStatus,
  type WithdrawalObservation,
} from "../depositPolicy.js";
import { addGasLimitBuffer, getGasPriceWei, getNativeBalance, getTokenBalance } from "../evm.js";
import {
  TOKEN_SYMBOLS,
  assertTokenConfigured,
  formatTokenAmount,
  tokenAmountToUnits,
  tokenUnitsToAmount,
  type TokenSymbol,
} from "../tokens.js";
import { HOT_PAYOUT_ABI, NATIVE_TOKEN } from "./abi.js";
import { withdrawalRef } from "./forwarder.js";
import {
  PAID_TOPIC,
  decodePayoutRawTx,
  describePayoutRevert,
  encodePayoutCall,
  findMatchingPaid,
  paidEventMatches,
  parsePaidLog,
  payoutCapacity,
  type PayoutExpectation,
  type PayoutProof,
  type PayoutRevert,
  type RpcLog,
  type V2Settings,
} from "./policy.js";
import { estimateGas, ethCall, getBlockNumber, getLogs, isRpcError, multicall3, revertData } from "./rpc.js";

/**
 * Custody v2 withdrawals: HotPayout.payNative / payToken signed by the
 * operator. The pipeline itself (reserve → sign → persist → broadcast →
 * observe → finalize) stays in src/evm.ts; this module plans, simulates and
 * proves the payout.
 */

const PAYOUT = new ethers.Interface(HOT_PAYOUT_ABI);

/** Ref used to simulate before a withdrawal row exists. HotPayout never sees it paid. */
const PREFLIGHT_REF = ethers.keccak256(ethers.toUtf8Bytes("mezosbot-withdrawal-v2:preflight"));

export function payoutRef(withdrawalId: number): string {
  return withdrawalRef(withdrawalId).toLowerCase();
}

/** HotPayout token key: address(0) for native BTC (SATS). */
export function payoutTokenAddress(token: TokenSymbol): string {
  if (token === "SATS") return NATIVE_TOKEN;
  return assertTokenConfigured(token).contractAddress!.toLowerCase();
}

async function read(settings: V2Settings, fn: string, args: unknown[] = []): Promise<unknown> {
  const raw = await ethCall(settings.payout, PAYOUT.encodeFunctionData(fn, args));
  return PAYOUT.decodeFunctionResult(fn, raw)[0];
}

export type PayoutTokenState = {
  token: TokenSymbol;
  paused: boolean;
  allowed: boolean;
  perTxCap: bigint;
  dailyCap: bigint;
  remainingDaily: bigint;
  float: bigint;
  /** What one payout could send right now. */
  capacity: bigint;
};

export async function readPayoutTokenState(settings: V2Settings, token: TokenSymbol): Promise<PayoutTokenState> {
  const address = payoutTokenAddress(token);
  const [paused, allowed, perTxCap, dailyCap, remainingDaily, float] = await Promise.all([
    read(settings, "paused"),
    read(settings, "allowedToken", [address]),
    read(settings, "perTxCap", [address]),
    read(settings, "dailyCap", [address]),
    read(settings, "remainingDaily", [address]),
    getTokenBalance(settings.payout, token),
  ]);
  const state = {
    token,
    paused: Boolean(paused),
    allowed: Boolean(allowed),
    perTxCap: BigInt(perTxCap as bigint),
    dailyCap: BigInt(dailyCap as bigint),
    remainingDaily: BigInt(remainingDaily as bigint),
    float,
  };
  return { ...state, capacity: payoutCapacity(state) };
}

export async function readPayoutStates(settings: V2Settings): Promise<PayoutTokenState[]> {
  return Promise.all(TOKEN_SYMBOLS.map((token) => readPayoutTokenState(settings, token)));
}

export async function isRefPaid(settings: V2Settings, ref: string): Promise<boolean> {
  return Boolean(await read(settings, "paid", [ref]));
}

const PAID_BATCH_SIZE = 25;
let multicallFallbackLogged = false;

/**
 * paid(ref) for many refs: batches of at most 25 through Multicall3
 * (allowFailure), falling back to one call per ref when Multicall3 is
 * unavailable (logged once per outage). A ref whose read failed maps to null
 * for the caller to count and retry.
 */
export async function readPaidRefs(settings: V2Settings, refs: string[]): Promise<Map<string, boolean | null>> {
  const results = new Map<string, boolean | null>();
  for (let i = 0; i < refs.length; i += PAID_BATCH_SIZE) {
    const batch = refs.slice(i, i + PAID_BATCH_SIZE);
    let answers: Array<boolean | null>;
    try {
      const raw = await multicall3(batch.map((ref) => ({ target: settings.payout, data: PAYOUT.encodeFunctionData("paid", [ref]) })));
      multicallFallbackLogged = false;
      answers = raw.map((result) => {
        if (!result.success) return null;
        try {
          return Boolean(PAYOUT.decodeFunctionResult("paid", result.returnData)[0]);
        } catch {
          return null;
        }
      });
    } catch (error) {
      if (!multicallFallbackLogged) {
        multicallFallbackLogged = true;
        console.warn(`[Custody] Multicall3 read failed (${(error as Error).message}); reading paid(ref) one call at a time`);
      }
      answers = await Promise.all(batch.map((ref) => isRefPaid(settings, ref).catch(() => null)));
    }
    batch.forEach((ref, index) => results.set(ref, answers[index]));
  }
  return results;
}

/** The exact call from the operator: null when it would succeed, the revert otherwise. */
export async function simulatePayout(settings: V2Settings, expected: PayoutExpectation): Promise<PayoutRevert | null> {
  try {
    await ethCall(settings.payout, encodePayoutCall(expected), settings.operator);
    return null;
  } catch (error) {
    if (isRpcError(error)) return describePayoutRevert(revertData(error));
    throw error;
  }
}

export type PayoutPlan =
  | {
    ok: true;
    expected: PayoutExpectation;
    gasLimit: bigint;
    gasPrice: bigint;
    /** SATS: gas charged against the amount (with buffer). ERC-20: quoted gas reserved from SATS. */
    gasSats: number;
    sentSats: number;
  }
  | {
    ok: false;
    /**
     * already_paid: the ref reads as paid; never refund it automatically.
     * paid_unknown: paid(ref) could not be read; leave the row pending.
     */
    code: "payout_limit" | "invalid" | "unavailable" | "already_paid" | "paid_unknown";
    error: string;
  };

function amountLabel(units: bigint, token: TokenSymbol): string {
  return formatTokenAmount(tokenUnitsToAmount(units, token), token);
}

function capacityNote(state: PayoutTokenState): string {
  if (state.paused) return "";
  return ` Right now up to **${amountLabel(state.capacity, state.token)}** can be withdrawn on-chain; ` +
    "the daily limit refills gradually over 24 hours.";
}

function refusal(revert: PayoutRevert, state: PayoutTokenState): Extract<PayoutPlan, { ok: false }> {
  switch (revert.error) {
    case "AlreadyPaid":
      return { ok: false, code: "already_paid", error: revert.message };
    case "EnforcedPause":
    case "DailyCapExceeded":
    case "PerTxCapExceeded":
    case "InsufficientFloat":
      return { ok: false, code: "payout_limit", error: revert.message + capacityNote(state) };
    case "BadRecipient":
    case "ZeroAmount":
    case "TokenNotAllowed":
    case "CapsNotSet":
    case "PayFailed":
      return { ok: false, code: "invalid", error: revert.message };
    default:
      return { ok: false, code: "unavailable", error: revert.message };
  }
}

/**
 * Plan a HotPayout withdrawal and simulate the exact call from the operator.
 * Nothing is signed here. `withdrawalId` null plans with a placeholder ref
 * (pre-debit checks and gas quotes). SATS pays amount − 1.5× gas, as before.
 */
export async function planPayout(
  settings: V2Settings,
  input: { withdrawalId: number | null; to: string; token: TokenSymbol; amount: number },
): Promise<PayoutPlan> {
  const to = input.to.toLowerCase().trim();
  if (!/^0x[0-9a-f]{40}$/.test(to)) return { ok: false, code: "invalid", error: "Invalid address" };
  const ref = input.withdrawalId == null ? PREFLIGHT_REF : payoutRef(input.withdrawalId);
  if (input.withdrawalId != null) {
    // First: a ref that is already paid was paid by someone else (the bot signs
    // each ref once). Never refund or re-pay it.
    let paid: boolean;
    try {
      paid = await isRefPaid(settings, ref);
    } catch {
      return { ok: false, code: "paid_unknown", error: "Could not confirm the withdrawal reference is unused; it will be retried." };
    }
    if (paid) return { ok: false, code: "already_paid", error: describePayoutRevert(PAYOUT.encodeErrorResult("AlreadyPaid", [])).message };
  }
  const token = payoutTokenAddress(input.token);
  const gross = input.token === "SATS" ? satsToTokenUnits(input.amount) : tokenAmountToUnits(input.amount, input.token);
  if (gross <= 0n) return { ok: false, code: "invalid", error: "Amount too small" };

  const state = await readPayoutTokenState(settings, input.token);
  if (state.paused) return { ok: false, code: "payout_limit", error: describePayoutRevert(PAYOUT.encodeErrorResult("EnforcedPause", [])).message };
  if (!state.allowed || state.perTxCap === 0n) {
    return { ok: false, code: "invalid", error: `Withdrawals of ${input.token === "SATS" ? "SATS" : input.token} are not enabled.` };
  }
  if (gross > state.capacity) {
    const limit = gross > state.perTxCap ? "PerTxCapExceeded"
      : gross > state.remainingDaily ? "DailyCapExceeded"
      : "InsufficientFloat";
    return refusal(describePayoutRevert(PAYOUT.encodeErrorResult(limit, [])), state);
  }

  const estimate = async (amount: bigint): Promise<{ gas: bigint } | { revert: PayoutRevert }> => {
    try {
      const gas = await estimateGas(settings.operator, settings.payout, encodePayoutCall({ ref, token, to, amount }));
      return { gas: addGasLimitBuffer(gas) };
    } catch (error) {
      if (isRpcError(error)) return { revert: describePayoutRevert(revertData(error)) };
      throw error;
    }
  };

  const gasPrice = await getGasPriceWei();
  const first = await estimate(gross);
  if ("revert" in first) return refusal(first.revert, state);
  let gasLimit = first.gas;
  let amount = gross;
  let charged = 0n;
  if (input.token === "SATS") {
    // 50% buffer on withdrawals; the surplus stays in HotPayout.
    charged = (gasLimit * gasPrice * 3n) / 2n;
    amount = gross - charged;
    if (amount <= 0n) {
      return { ok: false, code: "invalid", error: `Amount too small to cover network gas (~${tokenUnitsToSats(charged)} sats)` };
    }
    const refined = await estimate(amount);
    if ("revert" in refined) return refusal(refined.revert, state);
    if (refined.gas > gasLimit) {
      gasLimit = refined.gas;
      charged = (gasLimit * gasPrice * 3n) / 2n;
      amount = gross - charged;
      if (amount <= 0n) {
        return { ok: false, code: "invalid", error: `Amount too small to cover network gas (~${tokenUnitsToSats(charged)} sats)` };
      }
    }
  }

  const expected: PayoutExpectation = { ref, token, to, amount };
  const revert = await simulatePayout(settings, expected);
  if (revert) return refusal(revert, state);

  const gasCost = gasLimit * gasPrice;
  if (await getNativeBalance(settings.operator) < gasCost) {
    return { ok: false, code: "unavailable", error: "Withdrawals are briefly unavailable while the payout gas wallet is refilled." };
  }
  return {
    ok: true,
    expected,
    gasLimit,
    gasPrice,
    gasSats: tokenUnitsToSats(input.token === "SATS" ? charged : gasCost),
    sentSats: input.token === "SATS" ? tokenUnitsToSats(amount) : input.amount,
  };
}

/**
 * The payment a stored withdrawal row signed, checked against the row: the
 * ref is this row's, the recipient and token are the row's. Null otherwise.
 */
export function expectedPayoutForRow(
  settings: V2Settings,
  row: { id: number; token: TokenSymbol; to_address: string; raw_tx: string | null },
): PayoutExpectation | null {
  const signed = decodePayoutRawTx(row.raw_tx, settings.payout);
  if (!signed) return null;
  let token: string;
  try {
    token = payoutTokenAddress(row.token);
  } catch {
    return null;
  }
  if (signed.ref !== payoutRef(row.id) || signed.to !== row.to_address.toLowerCase() || signed.token !== token) return null;
  return signed;
}

/**
 * Best-effort reason a mined payout reverted: replays the same call from the
 * operator against the state before its block. null when it cannot tell.
 */
export async function explainRevertedPayout(
  settings: V2Settings,
  expected: PayoutExpectation,
  receiptBlock: unknown,
): Promise<string | null> {
  const block = typeof receiptBlock === "string" && /^0x[0-9a-f]+$/i.test(receiptBlock) ? Number(BigInt(receiptBlock)) : null;
  try {
    await ethCall(settings.payout, encodePayoutCall(expected), settings.operator, block != null && block > 0 ? block - 1 : "latest");
    return null;
  } catch (error) {
    if (!isRpcError(error)) return null;
    const revert = describePayoutRevert(revertData(error));
    return revert.error ? revert.message : null;
  }
}

/** How far back a Paid log is searched when paid(ref) is true but our receipt does not show it. */
const PAID_SEARCH_MAX_CHUNKS = 200;

/**
 * Find the Paid log for `ref`, newest blocks first. "match" only when it pays
 * exactly `expected` and sits in `ownTxHash` (the row's recorded tx); a
 * matching log in any other transaction is "foreign". null when the search
 * could not run.
 */
export async function searchPaidLog(
  settings: V2Settings,
  ref: string,
  expected: PayoutExpectation | null,
  ownTxHash: string | null,
): Promise<PayoutProof["paidLog"]> {
  try {
    const chunk = Math.max(1, config.custody.logChunkBlocks);
    let to = await getBlockNumber();
    for (let n = 0; n < PAID_SEARCH_MAX_CHUNKS && to >= settings.startBlock; n++) {
      const from = Math.max(settings.startBlock, to - chunk + 1);
      const logs = await getLogs({ address: settings.payout, topics: [PAID_TOPIC, ref], fromBlock: from, toBlock: to });
      for (const log of logs) {
        const event = parsePaidLog(log, settings.payout);
        if (event?.ref === ref.toLowerCase()) {
          if (!expected || !paidEventMatches(event, expected)) return "mismatch";
          return ownTxHash && event.txHash === ownTxHash.toLowerCase() ? "match" : "foreign";
        }
      }
      to = from - 1;
    }
    return "not_found";
  } catch {
    return null;
  }
}

/**
 * Evidence for one observation of a HotPayout withdrawal: the receipt's Paid
 * log, and paid(ref) whenever a refund is on the table or the tx is overdue.
 */
export async function gatherPayoutProof(
  settings: V2Settings,
  input: {
    ref: string;
    expected: PayoutExpectation | null;
    observation: WithdrawalObservation;
    /** The tx hash recorded for the row; the only transaction that can complete it. */
    ownTxHash: string | null;
  },
): Promise<PayoutProof> {
  const { observation } = input;
  const base = explainWithdrawalOutcome({ ...observation, payout: undefined });
  const receipt = observation.receipt;
  const proof: PayoutProof = {
    receiptMatch: receipt && parseReceiptStatus(receipt.status) === 1
      ? !!input.expected && !!findMatchingPaid((receipt.logs ?? []) as RpcLog[], settings.payout, input.expected)
      : null,
    paidOnChain: null,
    paidLog: null,
  };
  if (base.outcome === "completed") return proof;
  if (base.outcome !== "refund" && observation.signedAgeMs < WITHDRAWAL_DROP_MIN_AGE_MS) return proof;
  try {
    proof.paidOnChain = await isRefPaid(settings, input.ref);
  } catch {
    return proof;
  }
  if (proof.paidOnChain) proof.paidLog = await searchPaidLog(settings, input.ref, input.expected, input.ownTxHash);
  return proof;
}
