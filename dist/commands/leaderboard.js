"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const db_js_1 = require("../db.js");
const format_js_1 = require("../format.js");
exports.data = {
    name: "leaderboard",
    description: "Top sats holders in the server",
};
async function execute(interaction) {
    await interaction.deferReply();
    const { data: rows } = await db_js_1.supabase
        .from("users")
        .select("discord_id, balance_sats")
        .gt("balance_sats", 0)
        .order("balance_sats", { ascending: false })
        .limit(10);
    if (!rows || rows.length === 0) {
        return interaction.editReply({ content: "No one has any sats yet!" });
    }
    const medals = ["🥇", "🥈", "🥉"];
    const lines = rows.map((r, i) => {
        const rank = medals[i] ?? `**${i + 1}.**`;
        return `${rank} <@${r.discord_id}> — **${(0, format_js_1.formatSats)(r.balance_sats)}**`;
    });
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle("🏆 Sats Leaderboard")
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Top ${rows.length} holder${rows.length === 1 ? "" : "s"}` })
        .setTimestamp();
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
