import { ethers } from "ethers";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { addGasLimitBuffer, getGasPriceWei, getNativeBalance, rawRpcCall } from "../evm.js";
import { describeCustodyRevert, weiToSats } from "./policy.js";
import { estimateGas, getNonce, isRpcError, revertData } from "./rpc.js";
import { assertCanSign } from "./state.js";

export type SignedTxPurpose = "withdrawal" | "sweep_native" | "sweep_token" | "pause" | "cancel" | "tighten";

/**
 * Record a transaction the bot signed with a custody key BEFORE it is
 * broadcast. The watchdog freezes custody when any of these keys spends a
 * nonce with no record here, or when none of the transactions recorded for a
 * spent nonce has a receipt. Every signed hash is kept: re-signing a nonce
 * adds a record instead of replacing one.
 */
export async function recordSignedTx(entry: {
  signer: string;
  nonce: number;
  txHash: string;
  purpose: SignedTxPurpose;
  ref: string | null;
}): Promise<void> {
  const { error } = await supabase.from("custody_signed_txs").upsert({
    signer: entry.signer.toLowerCase(),
    nonce: entry.nonce,
    tx_hash: entry.txHash.toLowerCase(),
    purpose: entry.purpose,
    ref: entry.ref,
    created_at: new Date().toISOString(),
  }, { onConflict: "signer,tx_hash", ignoreDuplicates: true });
  if (error) throw new Error(`could not record the signed transaction: ${error.message}`);
}

type SignedTxEntry = Parameters<typeof recordSignedTx>[0];

/** How long the emergency pause waits for its record before it is broadcast anyway. */
const EMERGENCY_RECORD_WAIT_MS = 10_000;
const RECORD_RETRY_MIN_MS = 5_000;
const RECORD_RETRY_MAX_MS = 60_000;
const RECORD_RETRY_LOG_INTERVAL_MS = 10 * 60_000;
const recordRetries = new Set<string>();

/**
 * Keep trying to record a signed transaction that was broadcast without a
 * record (the emergency pause only), until it is stored, so the watchdog's
 * nonce check finds it. Backs off to once a minute; logs at most every 10 minutes.
 */
function retryRecordUntilStored(entry: SignedTxEntry): void {
  const key = `${entry.signer.toLowerCase()}:${entry.txHash.toLowerCase()}`;
  if (recordRetries.has(key)) return;
  recordRetries.add(key);
  let delay = RECORD_RETRY_MIN_MS;
  let loggedAt = Date.now();
  const attempt = () => {
    recordSignedTx(entry).then(() => {
      recordRetries.delete(key);
      console.warn(`[Custody] ${entry.purpose} ${entry.txHash} (nonce ${entry.nonce}) is now recorded in custody_signed_txs`);
    }, (error) => {
      if (Date.now() - loggedAt >= RECORD_RETRY_LOG_INTERVAL_MS) {
        loggedAt = Date.now();
        console.error(`[Custody] ${entry.purpose} ${entry.txHash} (nonce ${entry.nonce}) is still not recorded (retrying): ${(error as Error).message}`);
      }
      delay = Math.min(RECORD_RETRY_MAX_MS, delay * 2);
      setTimeout(attempt, delay).unref?.();
    });
  };
  setTimeout(attempt, delay).unref?.();
}

const signerQueues = new Map<string, Promise<void>>();

/** Serializes nonce assignment → record → broadcast per signer within this process. */
export async function withSignerLock<T>(signer: string, fn: () => Promise<T>): Promise<T> {
  const key = signer.toLowerCase();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = signerQueues.get(key) ?? Promise.resolve();
  const next = previous.then(() => gate);
  signerQueues.set(key, next);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (signerQueues.get(key) === next) signerQueues.delete(key);
  }
}

/**
 * Sign a contract call with a custody key, record it, then broadcast. The
 * call is estimated first, so a call that would revert is never signed.
 * `bypassFreeze` is only for the guardian's pause() while freezing.
 * `emergencyPause` (purpose "pause" only) still broadcasts when the record
 * cannot be written, then keeps retrying the record in the background
 * (`recorded: false`); every other transaction is sent only once recorded.
 */
export async function sendCustodyTx(input: {
  wallet: ethers.Wallet;
  to: string;
  data: string;
  purpose: SignedTxPurpose;
  ref: string | null;
  bypassFreeze?: boolean;
  emergencyPause?: boolean;
}): Promise<{ txHash: string; nonce: number; recorded: boolean }> {
  const check = () => {
    if (!input.bypassFreeze) assertCanSign();
  };
  check();
  const from = input.wallet.address;
  let estimated: bigint;
  try {
    estimated = await estimateGas(from, input.to, input.data);
  } catch (error) {
    if (!isRpcError(error)) throw error;
    // Never signed: the call would revert.
    throw new Error(`${input.purpose} would revert (${describeCustodyRevert(revertData(error))})`);
  }
  const gasLimit = addGasLimitBuffer(estimated);
  const gasPrice = await getGasPriceWei();
  const balance = await getNativeBalance(from);
  if (balance < gasLimit * gasPrice) {
    throw new Error(`${input.purpose} signer ${from} needs ~${weiToSats(gasLimit * gasPrice)} sats of gas, has ${weiToSats(balance)}`);
  }
  return withSignerLock(from, async () => {
    check();
    const nonce = await getNonce(from, "pending");
    const signed = await input.wallet.signTransaction({
      to: input.to,
      data: input.data,
      value: 0n,
      gasLimit,
      gasPrice,
      nonce,
      chainId: config.evm.chainId,
      type: 0,
    });
    const txHash = ethers.keccak256(signed);
    const entry: SignedTxEntry = { signer: from, nonce, txHash, purpose: input.purpose, ref: input.ref };
    const emergency = input.emergencyPause === true && input.purpose === "pause";
    let recorded = true;
    try {
      if (!emergency) await recordSignedTx(entry);
      else {
        // The pause never waits on a slow database for long (the upsert is idempotent and retried).
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          recordSignedTx(entry),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${EMERGENCY_RECORD_WAIT_MS}ms`)), EMERGENCY_RECORD_WAIT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
      }
    } catch (error) {
      // Only the emergency pause goes out without its record.
      if (!emergency) throw error;
      recorded = false;
      console.error(
        `[Custody] EMERGENCY PAUSE ${txHash} (nonce ${nonce}) could not be recorded in custody_signed_txs ` +
        `(${(error as Error).message}); broadcasting it anyway and retrying the record`,
      );
    }
    try {
      await rawRpcCall("eth_sendRawTransaction", [signed]);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!/already known|known transaction/i.test(message)) {
        console.warn(`[Custody] ${input.purpose} ${txHash}: broadcast errored (may still land): ${message.slice(0, 300)}`);
      }
    }
    if (!recorded) retryRecordUntilStored(entry);
    return { txHash, nonce, recorded };
  });
}
