"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProvider = getProvider;
exports.getTreasuryAddress = getTreasuryAddress;
exports.initEVM = initEVM;
exports.getUserDepositWallet = getUserDepositWallet;
exports.getUserDepositAddress = getUserDepositAddress;
exports.registerDepositAddress = registerDepositAddress;
exports.sweepToTreasury = sweepToTreasury;
exports.fundGasAndSweep = fundGasAndSweep;
exports.startDepositPoller = startDepositPoller;
exports.withdraw = withdraw;
exports.recoverPendingWithdrawals = recoverPendingWithdrawals;
exports.getTreasuryBalanceSats = getTreasuryBalanceSats;
const ethers_1 = require("ethers");
const config_js_1 = require("./config.js");
const db_js_1 = require("./db.js");
const balance_js_1 = require("./balance.js");
let provider;
let wallet;
function getProvider() {
    return provider;
}
/**
 * Raw JSON-RPC call that bypasses ethers.js batching.
 * The Mezo RPC occasionally wraps single responses in a batch array
 * (e.g. `[{"jsonrpc":"2.0","result":{...}}]`), which causes ethers v6 to
 * throw BAD_DATA.  This helper unwraps the array before parsing.
 */
async function rawRpcCall(method, params) {
    const res = await fetch(config_js_1.config.evm.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    const data = await res.json();
    const item = Array.isArray(data) ? data[0] : data;
    const rpc = item;
    if (rpc.error)
        throw new Error(rpc.error.message ?? JSON.stringify(rpc.error));
    return rpc.result ?? null;
}
function getTreasuryAddress() {
    return wallet.address;
}
function initEVM() {
    const network = { chainId: config_js_1.config.evm.chainId, name: "mezo" };
    provider = new ethers_1.ethers.JsonRpcProvider(config_js_1.config.evm.rpcUrl, network, {
        staticNetwork: true,
        batchMaxCount: 1,
    });
    wallet = new ethers_1.ethers.Wallet(config_js_1.config.evm.treasuryPrivateKey, provider);
    provider.on("error", () => { });
    return { provider, wallet };
}
/**
 * Derive a unique deposit wallet for a Discord user.
 * Deterministic: same user always gets the same address.
 */
function getUserDepositWallet(discordId) {
    const seed = `mezosbot-deposit-v1:${config_js_1.config.evm.treasuryPrivateKey}:${discordId}`;
    const derivedKey = ethers_1.ethers.keccak256(ethers_1.ethers.toUtf8Bytes(seed));
    return new ethers_1.ethers.Wallet(derivedKey, provider);
}
/** Get the unique deposit address for a user */
function getUserDepositAddress(discordId) {
    return getUserDepositWallet(discordId).address;
}
const depositAddressCache = new Map();
const depositRegistrationPromises = new Map();
let depositAddressCacheLoadedAt = 0;
let depositAddressCacheRefresh = null;
const DEPOSIT_UPDATE_BATCH_SIZE = 500;
function normalizeDepositRow(row) {
    return {
        discord_id: row.discord_id,
        address: row.address.toLowerCase(),
        last_checked_balance: row.last_checked_balance ?? "0",
    };
}
async function refreshDepositAddressCache(force = false) {
    const now = Date.now();
    if (!force &&
        depositAddressCacheLoadedAt > 0 &&
        now - depositAddressCacheLoadedAt < config_js_1.config.deposits.addressRefreshMs) {
        return;
    }
    if (depositAddressCacheRefresh)
        return depositAddressCacheRefresh;
    depositAddressCacheRefresh = (async () => {
        const { data, error } = await db_js_1.supabase
            .from("deposit_addresses")
            .select("discord_id, address, last_checked_balance");
        if (error) {
            console.error("Failed to refresh deposit address cache:", error.message);
            return;
        }
        depositAddressCache.clear();
        for (const row of (data ?? [])) {
            const normalized = normalizeDepositRow(row);
            depositAddressCache.set(normalized.discord_id, normalized);
        }
        depositAddressCacheLoadedAt = Date.now();
    })().finally(() => {
        depositAddressCacheRefresh = null;
    });
    return depositAddressCacheRefresh;
}
async function updateDepositAddressBalances(updates) {
    if (updates.length === 0)
        return;
    for (let i = 0; i < updates.length; i += DEPOSIT_UPDATE_BATCH_SIZE) {
        const batch = updates.slice(i, i + DEPOSIT_UPDATE_BATCH_SIZE);
        const payload = batch.map(({ row, balance }) => ({
            discord_id: row.discord_id,
            last_checked_balance: balance,
        }));
        const { error } = await db_js_1.supabase.rpc("update_deposit_address_balances", {
            p_updates: payload,
        });
        if (error) {
            console.warn("Batch deposit balance update failed; falling back to per-row updates:", error.message);
            await Promise.all(batch.map(async ({ row, balance }) => {
                await db_js_1.supabase
                    .from("deposit_addresses")
                    .update({ last_checked_balance: balance })
                    .eq("discord_id", row.discord_id);
            }));
        }
        for (const { row, balance } of batch) {
            row.last_checked_balance = balance;
            depositAddressCache.set(row.discord_id, row);
        }
    }
}
/** Register a user's deposit address for polling */
async function registerDepositAddress(discordId) {
    const address = getUserDepositAddress(discordId);
    const normalizedAddress = address.toLowerCase();
    const cached = depositAddressCache.get(discordId);
    if (cached?.address === normalizedAddress)
        return address;
    const pending = depositRegistrationPromises.get(discordId);
    if (pending)
        return pending;
    const registration = (async () => {
        const { data, error } = await db_js_1.supabase
            .from("deposit_addresses")
            .upsert({ discord_id: discordId, address: normalizedAddress }, { onConflict: "discord_id", ignoreDuplicates: true })
            .select("discord_id, address, last_checked_balance")
            .maybeSingle();
        if (error)
            throw error;
        let row = data;
        if (!row) {
            const { data: existing, error: existingError } = await db_js_1.supabase
                .from("deposit_addresses")
                .select("discord_id, address, last_checked_balance")
                .eq("discord_id", discordId)
                .maybeSingle();
            if (existingError)
                throw existingError;
            row = existing;
        }
        depositAddressCache.set(discordId, normalizeDepositRow(row ?? {
            discord_id: discordId,
            address: normalizedAddress,
            last_checked_balance: "0",
        }));
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
async function getGasPrice() {
    // 1) Standard ethers fee data
    try {
        const feeData = await provider.getFeeData();
        if (feeData.gasPrice && feeData.gasPrice > 0n)
            return feeData.gasPrice;
        if (feeData.maxFeePerGas && feeData.maxFeePerGas > 0n)
            return feeData.maxFeePerGas;
    }
    catch { }
    // 2) Direct eth_gasPrice RPC call
    try {
        const raw = await rawRpcCall("eth_gasPrice", []);
        const price = BigInt(raw);
        if (price > 0n)
            return price;
    }
    catch { }
    // 3) Conservative fallback based on observed Mezo gas (~1.3M wei/gas)
    return 2000000n;
}
const NATIVE_TRANSFER_GAS_LIMIT = 21000n;
function addGasLimitBuffer(estimatedGas) {
    if (estimatedGas <= NATIVE_TRANSFER_GAS_LIMIT)
        return NATIVE_TRANSFER_GAS_LIMIT;
    return estimatedGas + estimatedGas / 5n + 1000n;
}
async function estimateNativeTransferGas(to, value) {
    const code = await provider.getCode(to);
    if (code === "0x")
        return NATIVE_TRANSFER_GAS_LIMIT;
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
async function sweepToTreasury(discordId) {
    const userWallet = getUserDepositWallet(discordId);
    const balance = await provider.getBalance(userWallet.address);
    if (balance === 0n)
        return null;
    const gasPrice = await getGasPrice();
    const gasLimit = 21000n;
    const gasCost = gasLimit * gasPrice;
    // No buffer needed: we pin gasPrice on the tx, so actual cost is
    // exactly gasLimit * gasPrice.  value + gasCost = balance → 0 dust.
    const sendAmount = balance - gasCost;
    if (sendAmount <= 0n) {
        console.log(`Sweep skipped for ${discordId}: balance ${balance} wei < gas ${gasCost} wei`);
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
async function fundGasAndSweep(discordId) {
    const userWallet = getUserDepositWallet(discordId);
    const balance = await provider.getBalance(userWallet.address);
    if (balance === 0n)
        return null;
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
function startDepositPoller(onDeposit) {
    let isPolling = false;
    const poll = async () => {
        if (isPolling) {
            console.warn("Deposit poll skipped: previous poll is still running");
            return;
        }
        isPolling = true;
        try {
            await refreshDepositAddressCache(depositAddressCacheLoadedAt === 0);
            const rows = Array.from(depositAddressCache.values());
            if (rows.length === 0)
                return;
            const balanceChecks = await Promise.allSettled(rows.map(async (row) => {
                const bal = await provider.getBalance(row.address);
                return { row, bal };
            }));
            const updates = [];
            for (const result of balanceChecks) {
                if (result.status === "rejected")
                    continue;
                const { row, bal } = result.value;
                const prev = BigInt(row.last_checked_balance || "0");
                // Credit only when balance INCREASES (new deposit arrived).
                if (bal > prev) {
                    const diff = bal - prev;
                    // Exact gas cost: matches the pinned gasPrice on the sweep tx.
                    const gasPrice = await getGasPrice();
                    const gasCost = 21000n * gasPrice;
                    const netDeposit = diff - gasCost;
                    if (netDeposit > 0n) {
                        const netSats = (0, config_js_1.tokenUnitsToSats)(netDeposit);
                        const gasSats = (0, config_js_1.tokenUnitsToSats)(gasCost);
                        if (netSats > 0) {
                            const txId = `auto-${Date.now()}-${row.discord_id}`;
                            await db_js_1.supabase.from("deposits").insert({
                                discord_id: row.discord_id,
                                tx_hash: txId,
                                amount_sats: netSats,
                                block_number: 0,
                            });
                            await (0, balance_js_1.addBalance)(row.discord_id, netSats);
                            onDeposit?.(row.discord_id, netSats, gasSats);
                        }
                    }
                    else {
                        console.log(`Deposit too small to cover gas for ${row.discord_id}: ${diff} wei < gas ${gasCost} wei`);
                    }
                    // Sweep immediately after crediting a new deposit.
                    sweepToTreasury(row.discord_id).catch((err) => {
                        console.error(`Sweep failed for ${row.discord_id}:`, err?.message ?? err);
                    });
                }
                if (bal !== prev) {
                    updates.push({ row, balance: bal.toString() });
                }
            }
            await updateDepositAddressBalances(updates);
        }
        finally {
            isPolling = false;
        }
    };
    setInterval(poll, config_js_1.config.deposits.pollMs);
    // Initial poll after 5s (let bot finish starting)
    setTimeout(poll, 5_000);
}
/** Withdraw sats from treasury to an address (native send).
 *  Gas fee is deducted from the send amount so the treasury stays solvent.
 *  Waits for on-chain confirmation before returning success. */
async function withdraw(toAddress, amountSats) {
    const normalized = toAddress.toLowerCase().trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalized))
        return { error: "Invalid address" };
    const value = (0, config_js_1.satsToTokenUnits)(amountSats);
    if (value <= 0n)
        return { error: "Amount too small" };
    const gasPrice = await getGasPrice();
    let gasLimit;
    try {
        gasLimit = await estimateNativeTransferGas(normalized, value);
    }
    catch (e) {
        const err = e;
        return { error: `Unable to estimate withdrawal gas: ${err?.reason ?? err?.message ?? String(e)}` };
    }
    let gasCost = gasLimit * gasPrice;
    // 50% buffer on withdrawals — treasury keeps the surplus
    let chargedGas = gasCost + gasCost / 2n;
    let gasSats = (0, config_js_1.tokenUnitsToSats)(chargedGas);
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
            gasSats = (0, config_js_1.tokenUnitsToSats)(chargedGas);
            sendValue = value - chargedGas;
            if (sendValue <= 0n) {
                return { error: `Amount too small to cover network gas (~${gasSats} sats)` };
            }
        }
    }
    catch (e) {
        const err = e;
        return { error: `Unable to estimate withdrawal gas: ${err?.reason ?? err?.message ?? String(e)}` };
    }
    const sentSats = (0, config_js_1.tokenUnitsToSats)(sendValue);
    // Send the transaction
    let tx;
    try {
        tx = await wallet.sendTransaction({
            to: normalized,
            value: sendValue,
            gasLimit,
            gasPrice,
        });
    }
    catch (e) {
        const err = e;
        return { error: err?.reason ?? err?.message ?? String(e) };
    }
    // Poll for confirmation manually — tx.wait() is unreliable on Mezo RPC
    // (same pattern used in fundGasAndSweep above)
    const POLL_INTERVAL_MS = 3_000;
    const POLL_ATTEMPTS = 40; // ~2 minutes total
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        try {
            const receipt = await rawRpcCall("eth_getTransactionReceipt", [tx.hash]);
            if (receipt !== null) {
                const status = parseInt(receipt.status, 16);
                if (status === 0) {
                    return { txHash: tx.hash, gasSats, sentSats, confirmed: false, error: "Transaction reverted on-chain" };
                }
                return { txHash: tx.hash, gasSats, sentSats, confirmed: true };
            }
        }
        catch (err) {
            // Log first error per tx so we can diagnose RPC issues in Render logs
            if (i === 0)
                console.warn(`[Withdraw] Poll error for ${tx.hash}:`, err?.message ?? err);
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
async function recoverPendingWithdrawals() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: stale } = await db_js_1.supabase
        .from("withdrawals")
        .select("*")
        .eq("status", "pending")
        .lt("created_at", fiveMinutesAgo);
    if (!stale || stale.length === 0)
        return;
    console.log(`[Recovery] Found ${stale.length} stale pending withdrawal(s) to resolve`);
    for (const w of stale) {
        if (!w.tx_hash) {
            // sendTransaction never got a hash — safe to refund
            await (0, balance_js_1.addBalance)(w.discord_id, w.amount_sats);
            await db_js_1.supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
            console.log(`[Recovery] Withdrawal ${w.id}: no tx_hash → refunded ${w.amount_sats} sats`);
            continue;
        }
        try {
            const receipt = await rawRpcCall("eth_getTransactionReceipt", [w.tx_hash]);
            if (receipt !== null) {
                const status = parseInt(receipt.status, 16);
                if (status === 1) {
                    await db_js_1.supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
                    console.log(`[Recovery] Withdrawal ${w.id}: tx confirmed on-chain → marked completed (no refund)`);
                }
                else {
                    await (0, balance_js_1.addBalance)(w.discord_id, w.amount_sats);
                    await db_js_1.supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
                    console.log(`[Recovery] Withdrawal ${w.id}: tx reverted → refunded ${w.amount_sats} sats`);
                }
            }
            else {
                // No receipt — check if tx is mined without a receipt
                const tx = await rawRpcCall("eth_getTransactionByHash", [w.tx_hash]);
                if (tx?.blockNumber != null) {
                    // Tx is in a block but receipt unavailable — treat as confirmed
                    await db_js_1.supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
                    console.log(`[Recovery] Withdrawal ${w.id}: tx in block (no receipt) → marked completed`);
                }
                else if (tx !== null) {
                    // Tx exists on-chain but blockNumber is null = still in mempool.
                    // Mezo confirms in seconds so this is unusual, but don't refund —
                    // leave pending and let the next recovery pass resolve it.
                    console.log(`[Recovery] Withdrawal ${w.id}: tx ${w.tx_hash} still in mempool — leaving pending`);
                }
                else {
                    // tx === null: this node has no record of it.
                    // Could be RPC lag at startup, so retry once before refunding.
                    await new Promise((r) => setTimeout(r, 4000));
                    const txRetry = await rawRpcCall("eth_getTransactionByHash", [w.tx_hash]);
                    if (txRetry?.blockNumber != null) {
                        await db_js_1.supabase.from("withdrawals").update({ status: "completed" }).eq("id", w.id);
                        console.log(`[Recovery] Withdrawal ${w.id}: tx found in block on retry → marked completed`);
                    }
                    else if (txRetry !== null) {
                        console.log(`[Recovery] Withdrawal ${w.id}: tx in mempool on retry — leaving pending`);
                    }
                    else {
                        // Still null after retry — tx genuinely dropped
                        await (0, balance_js_1.addBalance)(w.discord_id, w.amount_sats);
                        await db_js_1.supabase.from("withdrawals").update({ status: "failed" }).eq("id", w.id);
                        console.log(`[Recovery] Withdrawal ${w.id}: tx not found after retry → refunded ${w.amount_sats} sats`);
                    }
                }
            }
        }
        catch (err) {
            console.error(`[Recovery] Withdrawal ${w.id}: RPC error —`, err?.message ?? err);
        }
    }
}
/** Get treasury native balance in sats */
async function getTreasuryBalanceSats() {
    const bal = await provider.getBalance(wallet.address);
    return (0, config_js_1.tokenUnitsToSats)(bal);
}
