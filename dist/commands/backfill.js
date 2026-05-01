"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const config_js_1 = require("../config.js");
const evm_js_1 = require("../evm.js");
const balance_js_1 = require("../balance.js");
const db_js_1 = require("../db.js");
const format_js_1 = require("../format.js");
exports.data = {
    name: "backfill",
    description: "Admin: manually check and credit a user's uncredited deposit",
    default_member_permissions: "0",
    options: [
        { name: "user", type: 6, description: "User to check", required: true },
    ],
};
async function execute(interaction) {
    if (!config_js_1.config.discord.adminIds.includes(interaction.user.id)) {
        return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }
    const target = interaction.options.getUser("user", true);
    await interaction.deferReply({ ephemeral: true });
    await (0, evm_js_1.registerDepositAddress)(target.id);
    const address = (0, evm_js_1.getUserDepositAddress)(target.id);
    const provider = (0, evm_js_1.getProvider)();
    try {
        const bal = await provider.getBalance(address);
        if (bal === 0n) {
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0x95a5a6)
                .setTitle("🔍 Backfill Check")
                .addFields({ name: "User", value: `<@${target.id}>`, inline: true }, { name: "Address", value: `\`${address.slice(0, 12)}...\``, inline: true }, { name: "Result", value: "No funds found at deposit address." });
            return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
        }
        const { data: row } = await db_js_1.supabase
            .from("deposit_addresses")
            .select("last_checked_balance")
            .eq("discord_id", target.id)
            .single();
        const alreadyTracked = BigInt(row?.last_checked_balance || "0");
        if (bal <= alreadyTracked) {
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0x95a5a6)
                .setTitle("🔍 Backfill Check")
                .addFields({ name: "User", value: `<@${target.id}>`, inline: true }, { name: "On-Chain", value: `**${(0, format_js_1.formatSats)((0, config_js_1.tokenUnitsToSats)(bal))}**`, inline: true }, { name: "Already Tracked", value: `**${(0, format_js_1.formatSats)((0, config_js_1.tokenUnitsToSats)(alreadyTracked))}**`, inline: true }, { name: "Result", value: "Nothing to backfill. Use `/sweep` to move funds or `/credit` for manual adjustments." });
            return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
        }
        const diff = bal - alreadyTracked;
        const diffSats = (0, config_js_1.tokenUnitsToSats)(diff);
        const txId = `backfill-${Date.now()}-${target.id}`;
        await db_js_1.supabase.from("deposits").insert({
            discord_id: target.id,
            tx_hash: txId,
            amount_sats: diffSats,
            block_number: 0,
        });
        await (0, balance_js_1.addBalance)(target.id, diffSats);
        await db_js_1.supabase
            .from("deposit_addresses")
            .update({ last_checked_balance: bal.toString() })
            .eq("discord_id", target.id);
        (0, evm_js_1.sweepToTreasury)(target.id).catch(() => { });
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x00cc6a)
            .setTitle("✅ Backfill Complete")
            .addFields({ name: "User", value: `<@${target.id}>`, inline: true }, { name: "Credited", value: `**${(0, format_js_1.formatSats)(diffSats)}**`, inline: true })
            .setFooter({ text: "Sweep to treasury attempted" })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
    catch (err) {
        await interaction.editReply({
            content: `❌ Could not check the deposit address: ${err?.message ?? err}`,
        });
    }
}
