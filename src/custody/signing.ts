import { ethers } from "ethers";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { addGasLimitBuffer, getGasPriceWei, getNativeBalance, rawRpcCall } from "../evm.js";
import { describeCustodyRevert, weiToSats } from "./policy.js";
import { estimateGas, getNonce, isRpcError, revertData } from "./rpc.js";
import { assertCanSign } from "./state.js";

export type SignedTxPurpose = "withdrawal" | "sweep_native" | "sweep_token" | "pause";

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
 */
export async function sendCustodyTx(input: {
  wallet: ethers.Wallet;
  to: string;
  data: string;
  purpose: SignedTxPurpose;
  ref: string | null;
  bypassFreeze?: boolean;
}): Promise<{ txHash: string; nonce: number }> {
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
    await recordSignedTx({ signer: from, nonce, txHash, purpose: input.purpose, ref: input.ref });
    try {
      await rawRpcCall("eth_sendRawTransaction", [signed]);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!/already known|known transaction/i.test(message)) {
        console.warn(`[Custody] ${input.purpose} ${txHash}: broadcast errored (may still land): ${message.slice(0, 300)}`);
      }
    }
    return { txHash, nonce };
  });
}
