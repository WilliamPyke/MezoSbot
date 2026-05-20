import { ethers } from "ethers";
import { config, satsToTokenUnits, tokenUnitsToSats } from "./config.js";
import { supabase } from "./db.js";
import { addBalance } from "./balance.js";
import { recordLedgerEntry } from "./ledger.js";
import { verifyWalletFromDeposit } from "./walletVerification.js";

let provider: ethers.JsonRpcProvider;
let wallet: ethers.Wallet;

export function getProvider() {
  return provider;
}

/**
 * Raw JSON-RPC call that bypasses ethers.js batching.
 * The Mezo RPC occasionally wraps single responses in a batch array
 * (e.g. `[{"jsonrpc":"2.0","result":{...}}]`), which causes ethers v6 to
 * throw BAD_DATA.  This helper unwraps the array before parsing.
 */
async function rawRpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(config.evm.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const data: unknown = await res.json();
  const item = Array.isArray(data) ? data[0] : data;
  const rpc = item as { error?: { message?: string }; result?: unknown };
  if (rpc.error) throw new Error(rpc.error.message ?? JSON.stringify(rpc.error));
  return rpc.result ?? null;
}

export function getTreasuryAddress(): string {
  return wallet.address;
}

export function initEVM() {
  const network = { chainId: config.evm.chainId, name: "mezo" };
  provider = new ethers.JsonRpcProvider(config.evm.rpcUrl, network, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  wallet = new ethers.Wallet(config.evm.treasuryPrivateKey, provider);

  provider.on("error", () => {});

  return { provider, wallet };
}

/**
 * Derive a unique deposit wallet for a Discord user.
 * Deterministic: same user always gets the same address.
 */
export function getUserDepositWallet(discordId: string): ethers.Wallet {
  const seed = `mezosbot-deposit-v1:${config.evm.treasuryPrivateKey}:${discordId}`;
  const derivedKey = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(derivedKey, provider);
}

/** Get the unique deposit address for a user */
export function getUserDepositAddress(discordId: string): string {
  return getUserDepositWallet(discordId).address;
}

type DepositAddressRow = {
  discord_id: string;
  address: string;
  last_checked_balance: string | null;
};

const depositAddressCache = new Map<string, DepositAddressRow>();
const depositRegistrationPromises = new Map<string, Promise<string>>();
let depositAddressCacheLoadedAt = 0;
let depositAddressCacheRefresh: Promise<void> | null = null;
const DEPOSIT_UPDATE_BATCH_SIZE = 500;

function clampPositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      await yieldToEventLoop();
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeDepositRow(row: DepositAddressRow): DepositAddressRow {
  return {
    discord_id: row.discord_id,
    address: row.address.toLowerCase(),
    last_checked_balance: row.last_checked_balance ?? "0",
  };
}

async function refreshDepositAddressCache(force = false): Promise<void> {
  const now = Date.now();
  if (
    !force &&
    depositAddressCacheLoadedAt > 0 &&
    now - depositAddressCacheLoadedAt < config.deposits.addressRefreshMs
  ) {
    return;
  }

  if (depositAddressCacheRefresh) return depositAddressCacheRefresh;

  depositAddressCacheRefresh = (async () => {
    const { data, error } = await supabase
      .from("deposit_addresses")
      .select("discord_id, address, last_checked_balance");

    if (error) {
      console.error("Failed to refresh deposit address cache:", error.message);
      return;
    }

    depositAddressCache.clear();
    for (const row of (data ?? []) as DepositAddressRow[]) {
      const normalized = normalizeDepositRow(row);
      depositAddressCache.set(normalized.discord_id, normalized);
    }
    depositAddressCacheLoadedAt = Date.now();
  })().finally(() => {
    depositAddressCacheRefresh = null;
  });

  return depositAddressCacheRefresh;
}

async function updateDepositAddressBalances(
  updates: Array<{ row: DepositAddressRow; balance: string }>,
): Promise<void> {
  if (updates.length === 0) return;

  for (let i = 0; i < updates.length; i += DEPOSIT_UPDATE_BATCH_SIZE) {
    const batch = updates.slice(i, i + DEPOSIT_UPDATE_BATCH_SIZE);
    const payload = batch.map(({ row, balance }) => ({
      discord_id: row.discord_id,
      last_checked_balance: balance,
    }));

    const { error } = await supabase.rpc("update_deposit_address_balances", {
      p_updates: payload,
    });

    if (error) {
      console.warn(
        "Batch deposit balance update failed; falling back to per-row updates:",
        error.message
      );
      await Promise.all(
        batch.map(async ({ row, balance }) => {
          await supabase
            .from("deposit_addresses")
            .update({ last_checked_balance: balance })
            .eq("discord_id", row.discord_id);
        })
      );
    }

    for (const { row, balance } of batch) {
      row.last_checked_balance = balance;
      depositAddressCache.set(row.discord_id, row);
    }
  }
}

/** Register a user's deposit address for polling */
export async function registerDepositAddress(discordId: string): Promise<string> {
  const address = getUserDepositAddress(discordId);
  const normalizedAddress = address.toLowerCase();
  const cached = depositAddressCache.get(discordId);

  if (cached?.address === normalizedAddress) return address;

  const pending = depositRegistrationPromises.get(discordId);
  if (pending) return pending;

  const registration = (async () => {
    const { data, error } = await supabase
      .from("deposit_addresses")
      .upsert(
        { discord_id: discordId, address: normalizedAddress },
        { onConflict: "discord_id", ignoreDuplicates: true }
      )
      .select("discord_id, address, last_checked_balance")
      .maybeSingle();

    if (error) throw error;

    let row = data as DepositAddressRow | null;

    if (!row) {
      const { data: existing, error: existingError } = await supabase
        .from("deposit_addresses")
        .select("discord_id, address, last_checked_balance")
        .eq("discord_id", discordId)
        .maybeSingle();

      if (existingError) throw existingError;
      row = existing as DepositAddressRow | null;
    }

    depositAddressCache.set(
      discordId,
      normalizeDepositRow(
        row ?? {
          discord_id: discordId,
          address: normalizedAddress,
          last_checked_balance: "0",
        }
      )
    );

    return address;
  })().finally(() => {
    depositRegistrationPromises.delete(discordId);
  });

  depositRegistrationPromises.set(discordId, registration);
  return registration;
}

/**
 * Get a reliable gas price with multiple fallbacks.
 * The Mezo RPC sometimes returns null from getFeeData(), so we
 * try several approaches before falling back to a safe default.
 */
async function getGasPrice(): Promise<bigint> {
  // 1) Standard ethers fee data
  try {
    const feeData = await provider.getFeeData();
    if (feeData.gasPrice && feeData.gasPrice > 0n) return feeData.gasPrice;
    if (feeData.maxFeePerGas && feeData.maxFeePerGas > 0n) return feeData.maxFeePerGas;
  } catch {}

  // 2) Direct eth_gasPrice RPC call
  try {
    const raw = await rawRpcCall("eth_gasPrice", []) as string;
    const price = BigInt(raw);
    if (price > 0n) return price;
  } catch {}

  // 3) Conservative fallback based on observed Mezo gas (~1.3M wei/gas)
  return 2_000_000n;
}

const NATIVE_TRANSFER_GAS_LIMIT = 21000n;

function addGasLimitBuffer(estimatedGas: bigint): bigint {
  if (estimatedGas <= NATIVE_TRANSFER_GAS_LIMIT) return NATIVE_TRANSFER_GAS_LIMIT;
  return estimatedGas + estimatedGas / 5n + 1000n;
}

async function estimateNativeTransferGas(to: string, value: bigint): Promise<bigint> {
  const code = await provider.getCode(to);
  if (code === "0x") return NATIVE_TRANSFER_GAS_LIMIT;

  const estimatedGas = await provider.estimateGas({
    from: wallet.address,
    to,
    value,
  });

  return addGasLimitBuffer(estimatedGas);
}

/**
 * Sweep funds from a user's deposit address to the treasury.
 * Gas price is pinned on the tx, so cost = exactly gasLimit * gasPrice.
 * value = balance - gasCost → wallet is drained to 0 with no dust.
 */
export async function sweepToTreasury(discordId: string): Promise<string | null> {
  const userWallet = getUserDepositWallet(discordId);
  const balance = await provider.getBalance(userWallet.address);
  if (balance === 0n) return null;

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  // No buffer needed: we pin gasPrice on the tx, so actual cost is
  // exactly gasLimit * gasPrice.  value + gasCost = balance → 0 dust.
  const sendAmount = balance - gasCost;
  if (sendAmount <= 0n) {
    console.log(
      `Sweep skipped for ${discordId}: balance ${balance} wei < gas ${gasCost} wei`
    );
    return null;
  }

  const tx = await userWallet.sendTransaction({
    to: wallet.address,
    value: sendAmount,
    gasLimit,
    gasPrice,
  });
  return tx.hash;
}

/**
 * Fund gas from treasury to a user's deposit wallet, wait for it to arrive,
 * then sweep the deposit wallet to treasury.
 * Used by the admin /sweep command for wallets where balance < gas cost.
 */
export async function fundGasAndSweep(discordId: string): Promise<string | null> {
  const userWallet = getUserDepositWallet(discordId);
  const balance = await provider.getBalance(userWallet.address);
  if (balance === 0n) return null;

  const gasPrice = await getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  // Send exactly enough gas for the sweep tx
  const gasFunding = gasCost;

  console.log(`Funding gas for ${discordId}: sending ${gasFunding} wei from treasury`);
  const fundTx = await wallet.sendTransaction({
    to: userWallet.address,
    value: gasFunding,
    gasLimit,
    gasPrice,
  });
  console.log(`Gas funding tx: ${fundTx.hash}`);

  // Wait for the funding tx to be mined (poll manually since tx.wait() is broken)
  let funded = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const newBal = await provider.getBalance(userWallet.address);
    if (newBal > balance) {
      funded = true;
      break;
    }
  }

  if (!funded) {
    console.error(`Gas funding for ${discordId} did not confirm in time`);
    return null;
  }

  // Now sweep — deposit wallet has enough for gas
  return sweepToTreasury(discordId);
}

/**
 * Poll all registered deposit addresses for new funds.
 * Auto-credits users and immediately sweeps funds to treasury.
 *
 * KEY INVARIANT: `last_checked_balance` is ALWAYS set to the real on-chain
 * balance.  We never manually reset it to "0" — that caused the old
 * double-credit bug where the poller would re-credit deposits whose sweep
 * hadn't mined yet.
 */
export function startDepositPoller(
  onDeposit?: (discordId: string, amountSats: number, gasSats: number, txHash: string) => void
) {
  let isPolling = false;
  const balanceConcurrency = clampPositiveInt(config.deposits.balanceConcurrency, 8);
  const balanceBatchSize = Math.max(
    balanceConcurrency,
    clampPositiveInt(config.deposits.balanceBatchSize, 25),
  );
  const initialPollDelayMs = clampPositiveInt(config.deposits.initialPollDelayMs, 15_000);

  const poll = async () => {
    if (isPolling) {
      console.warn("Deposit poll skipped: previous poll is still running");
      return;
    }

    isPolling = true;
    const startedAt = Date.now();

    try {
      await refreshDepositAddressCache(depositAddressCacheLoadedAt === 0);
      const rows = Array.from(depositAddressCache.values());

      if (rows.length === 0) return;

      const updates: Array<{ row: DepositAddressRow; balance: string }> = [];
      let gasPriceForPoll: bigint | null = null;

      for (let i = 0; i < rows.length; i += balanceBatchSize) {
        const batch = rows.slice(i, i + balanceBatchSize);
        const balanceChecks = await mapWithConcurrency(
          batch,
          balanceConcurrency,
          async (row) => {
            const bal = await provider.getBalance(row.address);
            return { row, bal };
          },
        );

        for (const result of balanceChecks) {
          if (result.status === "rejected") continue;

          const { row, bal } = result.value;
          const prev = BigInt(row.last_checked_balance || "0");

          // Credit only when balance INCREASES (new deposit arrived).
          if (bal > prev) {
            const diff = bal - prev;
            const usedForWalletVerification = await verifyWalletFromDeposit(
              row.discord_id,
              row.address,
              provider,
            ).catch((err) => {
              console.warn(
                `[WalletVerify] Deposit verification check failed for ${row.discord_id}:`,
                (err as Error)?.message ?? err,
              );
              return false;
            });

            // Exact gas cost: matches the pinned gasPrice on the sweep tx.
            gasPriceForPoll ??= await getGasPrice();
            const gasCost = 21000n * gasPriceForPoll;
            const netDeposit = diff - gasCost;

            if (usedForWalletVerification) {
              console.log(`Wallet verification deposit locked for ${row.discord_id}`);
            } else if (netDeposit > 0n) {
              const netSats = tokenUnitsToSats(netDeposit);
              const gasSats = tokenUnitsToSats(gasCost);

              if (netSats > 0) {
                const txId = `auto-${Date.now()}-${row.discord_id}`;
                await supabase.from("deposits").insert({
                  discord_id: row.discord_id,
                  tx_hash: txId,
                  amount_sats: netSats,
                  block_number: 0,
                });
                await addBalance(row.discord_id, netSats);
                onDeposit?.(row.discord_id, netSats, gasSats, txId);
              }
            } else {
              console.log(
                `Deposit too small to cover gas for ${row.discord_id}: ${diff} wei < gas ${gasCost} wei`
              );
            }

            // Sweep immediately after crediting a new deposit.
            sweepToTreasury(row.discord_id).catch((err) => {
              console.error(
                `Sweep failed for ${row.discord_id}:`,
                (err as Error)?.message ?? err
              );
            });
          }

          if (bal !== prev) {
            updates.push({ row, balance: bal.toString() });
          }
        }

        await yieldToEventLoop();
      }

      await updateDepositAddressBalances(updates);
      if (Date.now() - startedAt > config.deposits.pollMs) {
        console.warn(
          `[Deposits] Poll took ${Date.now() - startedAt}ms for ${rows.length} address(es); consider raising DEPOSIT_POLL_MS or lowering DEPOSIT_BALANCE_CONCURRENCY`
        );
      }
    } finally {
      isPolling = false;
    }
  };

  setInterval(poll, config.deposits.pollMs);
  // Initial poll after Discord has had a moment to settle.
  setTimeout(poll, initialPollDelayMs);
}

export interface WithdrawResult {
  txHash?: string;
  error?: string;
  gasSats?: number;
  sentSats?: number;
  /** true if tx was mined and succeeded on-chain */
  confirmed?: boolean;
}

/** Withdraw sats from treasury to an address (native send).
 *  Gas fee is deducted from the send amount so the treasury stays solvent.
 *  Waits for on-chain confirmation before returning success. */
export async function withdraw(
  toAddress: string,
  amountSats: number
): Promise<WithdrawResult> {
  const normalized = toAddress.toLowerCase().trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) return { error: "Invalid address" };

  const value = satsToTokenUnits(amountSats);
  if (value <= 0n) return { error: "Amount too small" };

  const gasPrice = await getGasPrice();
  let gasLimit: bigint;
  try {
    gasLimit = await estimateNativeTransferGas(normalized, value);
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { error: `Unable to estimate withdrawal gas: ${err?.reason ?? err?.message ?? String(e)}` };
  }

  let gasCost = gasLimit * gasPrice;
  // 50% buffer on withdrawals — treasury keeps the surplus
  let chargedGas = gasCost + gasCost / 2n;
  let gasSats = tokenUnitsToSats(chargedGas);

  let sendValue = value - chargedGas;
  if (sendValue <= 0n) {
    return { error: `Amount too small to cover network gas (~${gasSats} sats)` };
  }

  try {
    const refinedGasLimit = await estimateNativeTransferGas(normalized, sendValue);
    if (refinedGasLimit > gasLimit) {
      gasLimit = refinedGasLimit;
      gasCost = gasLimit * gasPrice;
      chargedGas = gasCost + gasCost / 2n;
      gasSats = tokenUnitsToSats(chargedGas);
      sendValue = value - chargedGas;

      if (sendValue <= 0n) {
        return { error: `Amount too small to cover network gas (~${gasSats} sats)` };
      }
    }
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { error: `Unable to estimate withdrawal gas: ${err?.reason ?? err?.message ?? String(e)}` };
  }

  const sentSats = tokenUnitsToSats(sendValue);

  // Send the transaction
  let tx;
  try {
    tx = await wallet.sendTransaction({
      to: normalized,
      value: sendValue,
      gasLimit,
      gasPrice,
    });
  } catch (e: unknown) {
    const err = e as { message?: string; reason?: string };
    return { error: err?.reason ?? err?.message ?? String(e) };
  }

  // Poll for confirmation manually — tx.wait() is unreliable on Mezo RPC
  // (same pattern used in fundGasAndSweep above)
  const POLL_INTERVAL_MS = 3_000;
  const POLL_ATTEMPTS = 40; // ~2 minutes total

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const receipt = await rawRpcCall("eth_getTransactionReceipt", [tx.hash]) as { status: string } | null;
      if (receipt !== null) {
        const status = parseInt(receipt.status, 16);
        if (status === 0) {
          return { txHash: tx.hash, gasSats, sentSats, confirmed: false, error: "Transaction reverted on-chain" };
        }
        return { txHash: tx.hash, gasSats, sentSats, confirmed: true };
      }
    } catch (err: unknown) {
      // Log first error per tx so we can diagnose RPC issues in Render logs
      if (i === 0) console.warn(`[Withdraw] Poll error for ${tx.hash}:`, (err as Error)?.message ?? err);
    }
  }

  console.warn(`[Withdraw] Receipt timeout for ${tx.hash} after ${POLL_ATTEMPTS} attempts`);
  return { txHash: tx.hash, gasSats, sentSats, confirmed: false, error: "Receipt timeout: transaction not confirmed after 2 minutes" };
}

/**
 * On startup, resolve any withdrawals left in "pending" state from a
 * previous session (e.g. bot killed mid-poll, or before the BAD_DATA fix).
 * Records older than 5 minutes are considered stuck — Mezo confirms in seconds.
 */
export async function recoverPendingWithdrawals(): Promise<void> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: stale } = await supabase
    .from("withdrawals")
    .select("*")
    .eq("status", "pending")
    .lt("created_at", fiveMinutesAgo);

  if (!stale || stale.length === 0) return;
  console.log(`[Recovery] Found ${stale.length} stale pending withdrawal(s) to resolve`);

  for (const w of stale) {
    if (!w.tx_hash) {
      // sendTransaction never got a hash — safe to refund
      await addBalance(w.discord_id, w.amount_sats);
      recordLedgerEntry(null, {
        type: "withdrawal_refund",
        amountSats: w.amount_sats,
        senderId: "treasury",
        receiverId: w.discord_id,
        referenceType: "withdrawals",
        referenceId: String(w.id),
        metadata: { reason: "recovery_no_tx_hash" },
      });
      await supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
      console.log(`[Recovery] Withdrawal ${w.id}: no tx_hash → refunded ${w.amount_sats} sats`);
      continue;
    }

    try {
      const receipt = await rawRpcCall("eth_getTransactionReceipt", [w.tx_hash]) as { status: string } | null;
      if (receipt !== null) {
        const status = parseInt(receipt.status, 16);
        if (status === 1) {
          await supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
          console.log(`[Recovery] Withdrawal ${w.id}: tx confirmed on-chain → marked completed (no refund)`);
        } else {
          await addBalance(w.discord_id, w.amount_sats);
          recordLedgerEntry(null, {
            type: "withdrawal_refund",
            amountSats: w.amount_sats,
            senderId: "treasury",
            receiverId: w.discord_id,
            referenceType: "withdrawals",
            referenceId: String(w.id),
            metadata: { reason: "recovery_tx_reverted" },
          });
          await supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
          console.log(`[Recovery] Withdrawal ${w.id}: tx reverted → refunded ${w.amount_sats} sats`);
        }
      } else {
        // No receipt — check if tx is mined without a receipt
        const tx = await rawRpcCall("eth_getTransactionByHash", [w.tx_hash]) as { blockNumber?: string | null } | null;
        if (tx?.blockNumber != null) {
          // Tx is in a block but receipt unavailable — treat as confirmed
          await supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
          console.log(`[Recovery] Withdrawal ${w.id}: tx in block (no receipt) → marked completed`);
        } else if (tx !== null) {
          // Tx exists on-chain but blockNumber is null = still in mempool.
          // Mezo confirms in seconds so this is unusual, but don't refund —
          // leave pending and let the next recovery pass resolve it.
          console.log(`[Recovery] Withdrawal ${w.id}: tx ${w.tx_hash} still in mempool — leaving pending`);
        } else {
          // tx === null: this node has no record of it.
          // Could be RPC lag at startup, so retry once before refunding.
          await new Promise((r) => setTimeout(r, 4000));
          const txRetry = await rawRpcCall("eth_getTransactionByHash", [w.tx_hash]) as { blockNumber?: string | null } | null;
          if (txRetry?.blockNumber != null) {
            await supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
            console.log(`[Recovery] Withdrawal ${w.id}: tx found in block on retry → marked completed`);
          } else if (txRetry !== null) {
            console.log(`[Recovery] Withdrawal ${w.id}: tx in mempool on retry — leaving pending`);
          } else {
            // Still null after retry — tx genuinely dropped
            await addBalance(w.discord_id, w.amount_sats);
            recordLedgerEntry(null, {
              type: "withdrawal_refund",
              amountSats: w.amount_sats,
              senderId: "treasury",
              receiverId: w.discord_id,
              referenceType: "withdrawals",
              referenceId: String(w.id),
              metadata: { reason: "recovery_tx_dropped" },
            });
            await supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
            console.log(`[Recovery] Withdrawal ${w.id}: tx not found after retry → refunded ${w.amount_sats} sats`);
          }
        }
      }
    } catch (err) {
      console.error(`[Recovery] Withdrawal ${w.id}: RPC error —`, (err as Error)?.message ?? err);
    }
  }
}

/** Get treasury native balance in sats */
export async function getTreasuryBalanceSats(): Promise<number> {
  const bal = await provider.getBalance(wallet.address);
  return tokenUnitsToSats(bal);
}
