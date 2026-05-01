"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const db_js_1 = require("../db.js");
const format_js_1 = require("../format.js");
const config_js_1 = require("../config.js");
exports.data = {
    name: "history",
    description: "View your recent deposit and withdrawal history",
};
async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.user.id;
    const explorer = config_js_1.config.evm.explorerUrl;
    const { data: deposits } = await db_js_1.supabase
        .from("deposits")
        .select("tx_hash, amount_sats, created_at")
        .eq("discord_id", userId)
        .order("created_at", { ascending: false })
        .limit(5);
    const { data: withdrawals } = await db_js_1.supabase
        .from("withdrawals")
        .select("tx_hash, amount_sats, to_address, status, created_at")
        .eq("discord_id", userId)
        .order("created_at", { ascending: false })
        .limit(5);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📜 Transaction History")
        .setTimestamp();
    // Deposits field
    if (deposits && deposits.length > 0) {
        const lines = deposits.map((d) => {
            const ts = Math.floor(new Date(d.created_at).getTime() / 1000);
            const link = d.tx_hash.startsWith("0x")
                ? `[\`${d.tx_hash.slice(0, 10)}...\`](${explorer}/tx/${d.tx_hash})`
                : `\`${d.tx_hash.slice(0, 16)}...\``;
            return `📥 **${(0, format_js_1.formatSats)(d.amount_sats)}** — ${link} <t:${ts}:R>`;
        });
        embed.addFields({ name: "Deposits", value: lines.join("\n") });
    }
    else {
        embed.addFields({ name: "Deposits", value: "_None yet_" });
    }
    // Withdrawals field
    if (withdrawals && withdrawals.length > 0) {
        const lines = withdrawals.map((w) => {
            const ts = Math.floor(new Date(w.created_at).getTime() / 1000);
            const addr = `\`${w.to_address.slice(0, 10)}...\``;
            const icon = w.status === "pending" ? "⏳" : "✅";
            return `📤 ${icon} **${(0, format_js_1.formatSats)(w.amount_sats)}** → ${addr} <t:${ts}:R>`;
        });
        embed.addFields({ name: "Withdrawals", value: lines.join("\n") });
    }
    else {
        embed.addFields({ name: "Withdrawals", value: "_None yet_" });
    }
    await interaction.editReply({ embeds: [embed] });
}
