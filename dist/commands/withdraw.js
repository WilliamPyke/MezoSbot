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
const MIN_WITHDRAWAL_SATS = parseFloat(process.env.MIN_WITHDRAWAL_SATS ?? "50");
exports.data = {
    name: "withdraw",
    description: "Withdraw sats to an EVM address",
    options: [
        { name: "amount", type: 10, description: "Amount in sats", required: true, minValue: 0.000001 },
        { name: "address", type: 3, description: "Destination address (0x...) — defaults to linked wallet", required: false },
    ],
};
async function execute(interaction) {
    const amount = interaction.options.getNumber("amount", true);
    const addressOpt = interaction.options.getString("address");
    if (addressOpt && !/^0x[a-fA-F0-9]{40}$/i.test(addressOpt)) {
        return interaction.reply({ content: "❌ Invalid address.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (!config_js_1.config.evm.skipWithdrawalMin && amount < MIN_WITHDRAWAL_SATS) {
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
    // 2. Deduct balance atomically
    if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, amount))) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    // 2. Insert withdrawal as PENDING
    const { data: row } = await db_js_1.supabase.from("withdrawals").insert({
        discord_id: interaction.user.id,
        amount_sats: amount,
        to_address: address.toLowerCase(),
        status: "pending",
    }).select("id").single();
    const withdrawalId = row?.id;
    (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
        type: "withdrawal",
        amountSats: amount,
        senderId: interaction.user.id,
        receiverId: "treasury",
        guildId: interaction.guildId,
        referenceType: "withdrawals",
        referenceId: withdrawalId != null ? String(withdrawalId) : null,
    });
    // 3. Send the transaction and wait for receipt
    const result = await (0, evm_js_1.withdraw)(address, amount);
    // 4. Handle failure — refund balance + mark failed
    if (result.error && !result.confirmed) {
        await (0, balance_js_1.addBalance)(interaction.user.id, amount);
        (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
            type: "withdrawal_refund",
            amountSats: amount,
            senderId: "treasury",
            receiverId: interaction.user.id,
            guildId: interaction.guildId,
            referenceType: "withdrawals",
            referenceId: withdrawalId != null ? String(withdrawalId) : null,
            metadata: { reason: "withdrawal_failed" },
        });
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
    // 5. Transaction confirmed on-chain — mark completed
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
        .addFields({ name: "Amount", value: `**${(0, format_js_1.formatSats)(amount)}**`, inline: true }, { name: "To", value: `\`${address.slice(0, 10)}...${address.slice(-8)}\``, inline: true });
    if (result.gasSats) {
        embed.addFields({ name: "Network Fee", value: `~${(0, format_js_1.formatSats)(result.gasSats)}`, inline: true }, { name: "Received", value: `~${(0, format_js_1.formatSats)(result.sentSats)}`, inline: true });
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
