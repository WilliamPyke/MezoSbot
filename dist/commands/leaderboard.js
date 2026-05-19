"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const db_js_1 = require("../db.js");
const format_js_1 = require("../format.js");
exports.data = {
    name: "leaderboard",
    description: "Display server leaderboards",
    options: [
        {
            name: "type",
            type: 3, // string
            description: "Type of leaderboard to show (default: Sats Balance)",
            required: false,
            choices: [
                { name: "Sats Balance", value: "balance" },
                { name: "Most Tipped", value: "tipped" },
                { name: "Most Rained", value: "rained" },
            ],
        },
    ],
};
async function execute(interaction) {
    await interaction.deferReply();
    const type = interaction.options.getString("type") ?? "balance";
    let title = "Sats Leaderboard";
    let suffix = "";
    let rows = [];
    if (type === "balance") {
        title = "Sats Leaderboard";
        suffix = "";
        const { data: dbRows } = await db_js_1.supabase
            .from("users")
            .select("discord_id, balance_sats")
            .gt("balance_sats", 0)
            .order("balance_sats", { ascending: false })
            .limit(10);
        rows = (dbRows ?? []).map((r) => ({ discord_id: r.discord_id, value: r.balance_sats }));
    }
    else if (type === "tipped") {
        title = "Most Tipped Leaderboard";
        suffix = " tipped";
        const { data: dbRows } = await db_js_1.supabase
            .from("user_tip_stats")
            .select("discord_id, total_tipped_sats")
            .gt("total_tipped_sats", 0)
            .order("total_tipped_sats", { ascending: false })
            .limit(10);
        rows = (dbRows ?? []).map((r) => ({ discord_id: r.discord_id, value: r.total_tipped_sats }));
    }
    else if (type === "rained") {
        title = "Most Rained Leaderboard";
        suffix = " rained";
        const { data: dbRows } = await db_js_1.supabase
            .from("user_rain_stats")
            .select("discord_id, total_rained_sats")
            .gt("total_rained_sats", 0)
            .order("total_rained_sats", { ascending: false })
            .limit(10);
        rows = (dbRows ?? []).map((r) => ({ discord_id: r.discord_id, value: r.total_rained_sats }));
    }
    if (rows.length === 0) {
        return interaction.editReply({ content: "No entries found for this leaderboard!" });
    }
    const medals = ["🥇", "🥈", "🥉"];
    const lines = rows.map((r, i) => {
        const rank = medals[i] ?? `**${i + 1}.**`;
        return `${rank} <@${r.discord_id}> — **${(0, format_js_1.formatSats)(r.value)}**${suffix}`;
    });
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle(`🏆 ${title}`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Top ${rows.length} user${rows.length === 1 ? "" : "s"}` })
        .setTimestamp();
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
