"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateUser = getOrCreateUser;
exports.getBalance = getBalance;
exports.addBalance = addBalance;
exports.subtractBalance = subtractBalance;
exports.subtractBalances = subtractBalances;
exports.linkWallet = linkWallet;
exports.getWalletForUser = getWalletForUser;
exports.getDiscordForWallet = getDiscordForWallet;
const db_js_1 = require("./db.js");
const format_js_1 = require("./format.js");
async function getOrCreateUser(discordId) {
    // Use upsert with onConflict to avoid duplicate inserts, select to return the row
    const { data, error } = await db_js_1.supabase
        .from("users")
        .upsert({ discord_id: discordId }, { onConflict: "discord_id", ignoreDuplicates: true })
        .select("*")
        .single();
    if (error) {
        // If upsert failed, fall back to select (row may already exist)
        const { data: existing } = await db_js_1.supabase
            .from("users")
            .select("*")
            .eq("discord_id", discordId)
            .single();
        return existing;
    }
    return data;
}
async function getBalance(discordId) {
    const { data } = await db_js_1.supabase
        .from("users")
        .select("balance_sats")
        .eq("discord_id", discordId)
        .single();
    return data?.balance_sats ?? 0;
}
async function addBalance(discordId, amountSats) {
    await getOrCreateUser(discordId);
    const rounded = (0, format_js_1.roundSats)(amountSats);
    await db_js_1.supabase.rpc("add_balance", { p_discord_id: discordId, p_amount: rounded });
}
async function subtractBalance(discordId, amountSats) {
    const rounded = (0, format_js_1.roundSats)(amountSats);
    if (rounded <= 0)
        return false;
    const { data } = await db_js_1.supabase.rpc("subtract_balance_if_sufficient", {
        p_discord_id: discordId,
        p_amount: rounded,
    });
    return data === true;
}
async function subtractBalances(debits) {
    const payload = debits
        .map((debit) => ({
        discord_id: debit.discordId,
        amount: (0, format_js_1.roundSats)(debit.amountSats),
    }))
        .filter((debit) => debit.discord_id && debit.amount > 0);
    if (payload.length === 0)
        return;
    const { error } = await db_js_1.supabase.rpc("subtract_balances_batch", {
        p_debits: payload,
    });
    if (!error)
        return;
    console.warn("Batch balance debit failed; falling back to per-user debits:", error.message);
    await Promise.all(payload.map((debit) => subtractBalance(debit.discord_id, debit.amount).catch(() => false)));
}
async function linkWallet(discordId, walletAddress) {
    const normalized = walletAddress.toLowerCase().trim();
    if (!/^0x[a-f0-9]{40}$/.test(normalized))
        return { ok: false, error: "Invalid EVM address" };
    try {
        await getOrCreateUser(discordId);
        // Check if wallet is already linked to someone else
        const { data: existing } = await db_js_1.supabase
            .from("links")
            .select("discord_id")
            .eq("wallet_address", normalized)
            .single();
        if (existing && existing.discord_id !== discordId) {
            return { ok: false, error: "Wallet already linked to another user" };
        }
        if (existing)
            return { ok: true }; // Already linked to this user
        await db_js_1.supabase
            .from("links")
            .upsert({ discord_id: discordId, wallet_address: normalized }, { onConflict: "discord_id,wallet_address" });
        await db_js_1.supabase
            .from("users")
            .update({ wallet_address: normalized })
            .eq("discord_id", discordId);
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: String(e) };
    }
}
async function getWalletForUser(discordId) {
    const { data } = await db_js_1.supabase
        .from("links")
        .select("wallet_address")
        .eq("discord_id", discordId)
        .single();
    return data?.wallet_address ?? null;
}
async function getDiscordForWallet(walletAddress) {
    const normalized = walletAddress.toLowerCase();
    const { data } = await db_js_1.supabase
        .from("links")
        .select("discord_id")
        .eq("wallet_address", normalized)
        .single();
    return data?.discord_id ?? null;
}
