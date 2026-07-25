"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const evm_js_1 = require("../evm.js");
const balance_js_1 = require("../balance.js");
const db_js_1 = require("../db.js");
const config_js_1 = require("../config.js");
const ledger_js_1 = require("../ledger.js");
const format_js_1 = require("../format.js");
const tokens_js_1 = require("../tokens.js");
const MIN_WITHDRAWAL_SATS = parseFloat(process.env.MIN_WITHDRAWAL_SATS ?? "50");
exports.data = {
    name: "withdraw",
    description: "Withdraw a token to an EVM address",
    options: [
        { name: "amount", type: 10, description: "Token amount", required: true, minValue: 0.000001 },
        { name: "address", type: 3, description: "Destination address (0x...) — defaults to linked wallet", required: false },
        { name: "token", type: 3, description: "Token to withdraw", required: false, choices: tokens_js_1.TOKEN_CHOICES },
    ],
};
async function execute(interaction) {
    const addressOpt = interaction.options.getString("address");
    const token = (0, tokens_js_1.parseToken)(interaction.options.getString("token"));
    const amount = (0, tokens_js_1.roundTokenAmount)(interaction.options.getNumber("amount", true), token);
    if (addressOpt && !/^0x[a-fA-F0-9]{40}$/i.test(addressOpt)) {
        return interaction.reply({ content: "❌ Invalid address.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (token === "SATS" && !config_js_1.config.evm.skipWithdrawalMin && amount < MIN_WITHDRAWAL_SATS) {
        return interaction.reply({ content: `❌ Minimum withdrawal is **${MIN_WITHDRAWAL_SATS.toLocaleString()} sats**.`, flags: discord_js_1.MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const address = addressOpt || (await (0, balance_js_1.getWalletForUser)(interaction.user.id));
    if (!address) {
        return interaction.editReply({
            content: "❌ No address provided and no linked wallet. Either provide an address or `/link` one first.",
        });
    }
    // 0. Block withdrawals while mid-combat in SatQuest (HP = balance, so this
    //    would otherwise let a player yank sats out to dodge an in-progress loss).
    const { data: sq } = await db_js_1.supabase
        .from("sat_players")
        .select("state")
        .eq("discord_id", interaction.user.id)
        .maybeSingle();
    if (sq?.state === "combat") {
        return interaction.editReply({
            content: "⚔️ You can't withdraw mid-combat in SatQuest. Win the fight, flee, or faint first.",
        });
    }
    // 1. Block concurrent withdrawals (only consider pending records < 10 min old)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: pending } = await db_js_1.supabase
        .from("withdrawals")
        .select("id")
        .eq("discord_id", interaction.user.id)
        .eq("status", "pending")
        .gte("created_at", tenMinutesAgo)
        .limit(1)
        .single();
    if (pending) {
        return interaction.editReply({
            content: "⏳ You already have a withdrawal in progress. Please wait for it to complete.",
        });
    }
    // 2. Reserve the asset and, for ERC-20s, the sats required for network gas.
    let gasQuote;
    if (token === "SATS") {
        if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, amount, token))) {
            return interaction.editReply({ content: "❌ Insufficient balance." });
        }
    }
    else {
        try {
            gasQuote = await (0, evm_js_1.quoteErc20WithdrawalGas)(address, amount, token);
        }
        catch (error) {
            return interaction.editReply({ content: `❌ Unable to estimate withdrawal gas: ${error.message}` });
        }
        const reserved = await (0, balance_js_1.reserveWithdrawalBalances)(interaction.user.id, amount, token, gasQuote.gasSats);
        if (reserved === "insufficient_token") {
            return interaction.editReply({ content: `❌ Insufficient ${token} balance.` });
        }
        if (reserved === "insufficient_sats") {
            return interaction.editReply({
                content: `❌ Insufficient sats balance to fund the network fee (~${(0, format_js_1.formatSats)(gasQuote.gasSats)}).`,
            });
        }
    }
    // 3. Insert withdrawal as PENDING
    const { data: row, error: insertError } = await db_js_1.supabase.from("withdrawals").insert({
        discord_id: interaction.user.id,
        amount_sats: amount,
        to_address: address.toLowerCase(),
        status: "pending",
        token,
    }).select("id").single();
    if (insertError) {
        await (0, balance_js_1.addBalance)(interaction.user.id, amount, token);
        if (gasQuote)
            await (0, balance_js_1.addBalance)(interaction.user.id, gasQuote.gasSats, "SATS");
        return interaction.editReply({ content: "❌ Could not create the withdrawal. Your balance was refunded." });
    }
    const withdrawalId = row?.id;
    (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
        type: "withdrawal",
        amountSats: amount,
        token,
        senderId: interaction.user.id,
        receiverId: "treasury",
        guildId: interaction.guildId,
        referenceType: "withdrawals",
        referenceId: withdrawalId != null ? String(withdrawalId) : null,
    });
    if (gasQuote) {
        (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
            type: "withdrawal_network_fee",
            amountSats: gasQuote.gasSats,
            token: "SATS",
            senderId: interaction.user.id,
            receiverId: "treasury",
            guildId: interaction.guildId,
            referenceType: "withdrawals",
            referenceId: withdrawalId != null ? String(withdrawalId) : null,
            metadata: { withdrawal_token: token },
        });
    }
    // 4. Send the transaction and wait for receipt
    const result = await (0, evm_js_1.withdraw)(address, amount, token, gasQuote);
    // 5. Handle failure — refund both the asset and reserved gas
    if (result.error && !result.confirmed) {
        await (0, balance_js_1.addBalance)(interaction.user.id, amount, token);
        if (gasQuote)
            await (0, balance_js_1.addBalance)(interaction.user.id, gasQuote.gasSats, "SATS");
        (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
            type: "withdrawal_refund",
            amountSats: amount,
            token,
            senderId: "treasury",
            receiverId: interaction.user.id,
            guildId: interaction.guildId,
            referenceType: "withdrawals",
            referenceId: withdrawalId != null ? String(withdrawalId) : null,
            metadata: { reason: "withdrawal_failed", refunded_gas_sats: gasQuote?.gasSats ?? 0 },
        });
        if (gasQuote) {
            (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
                type: "withdrawal_network_fee_refund",
                amountSats: gasQuote.gasSats,
                token: "SATS",
                senderId: "treasury",
                receiverId: interaction.user.id,
                guildId: interaction.guildId,
                referenceType: "withdrawals",
                referenceId: withdrawalId != null ? String(withdrawalId) : null,
            });
        }
        if (withdrawalId) {
            await db_js_1.supabase.from("withdrawals").update({
                status: "failed",
                tx_hash: result.txHash ?? null,
            }).eq("id", withdrawalId);
        }
        const failMsg = { content: `❌ Withdrawal failed: ${result.error}` };
        try {
            return await interaction.editReply(failMsg);
        }
        catch {
            // Interaction expired (e.g. bot restarted mid-poll) — fall back to DM
            interaction.user.send(failMsg).catch(() => { });
            return;
        }
    }
    // The quote reserves the gas-limit maximum; return any unused portion after
    // the receipt reports the actual gas consumed.
    if (gasQuote && result.confirmed && result.gasSats != null) {
        const unusedGasSats = Math.max(0, gasQuote.gasSats - result.gasSats);
        if (unusedGasSats > 0) {
            await (0, balance_js_1.addBalance)(interaction.user.id, unusedGasSats, "SATS");
            (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
                type: "withdrawal_network_fee_refund",
                amountSats: unusedGasSats,
                token: "SATS",
                senderId: "treasury",
                receiverId: interaction.user.id,
                guildId: interaction.guildId,
                referenceType: "withdrawals",
                referenceId: withdrawalId != null ? String(withdrawalId) : null,
                metadata: { reason: "unused_gas_reservation" },
            });
        }
    }
    // 6. Transaction confirmed on-chain — mark completed
    if (withdrawalId) {
        await db_js_1.supabase.from("withdrawals").update({
            status: "completed",
            tx_hash: result.txHash ?? null,
        }).eq("id", withdrawalId);
    }
    const explorer = config_js_1.config.evm.explorerUrl;
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("✅ Withdrawal Confirmed")
        .addFields({ name: "Amount", value: `**${(0, tokens_js_1.formatTokenAmount)(amount, token)}**`, inline: true }, { name: "To", value: `\`${address.slice(0, 10)}...${address.slice(-8)}\``, inline: true });
    if (result.gasSats) {
        embed.addFields({ name: "Network Fee", value: `~${(0, format_js_1.formatSats)(result.gasSats)}`, inline: true });
        if (token === "SATS") {
            embed.addFields({ name: "Received", value: `~${(0, format_js_1.formatSats)(result.sentSats)}`, inline: true });
        }
    }
    if (result.txHash) {
        embed.addFields({ name: "Transaction", value: `[View on Explorer](${explorer}/tx/${result.txHash})` });
    }
    embed.setTimestamp();
    try {
        await interaction.editReply({ embeds: [embed] });
    }
    catch {
        // Interaction expired (e.g. bot restarted mid-poll) — fall back to DM
        interaction.user.send({ embeds: [embed] }).catch(() => { });
    }
}
