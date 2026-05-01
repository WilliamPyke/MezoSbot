"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const config_js_1 = require("../config.js");
const balance_js_1 = require("../balance.js");
const format_js_1 = require("../format.js");
exports.data = {
    name: "credit",
    description: "Admin: manually credit or debit a user's balance",
    default_member_permissions: "0",
    options: [
        { name: "user", type: 6, description: "User to credit", required: true },
        { name: "amount", type: 10, description: "Sats to add (negative to debit)", required: true },
        { name: "reason", type: 3, description: "Reason for adjustment", required: false },
    ],
};
async function execute(interaction) {
    if (!config_js_1.config.discord.adminIds.includes(interaction.user.id)) {
        return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }
    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getNumber("amount", true);
    const reason = interaction.options.getString("reason") ?? "Manual adjustment";
    if (amount === 0) {
        return interaction.reply({ content: "❌ Amount can't be zero.", ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    if (amount > 0) {
        await (0, balance_js_1.addBalance)(target.id, amount);
    }
    else {
        if (!(await (0, balance_js_1.subtractBalance)(target.id, Math.abs(amount)))) {
            return interaction.editReply({ content: "❌ User doesn't have enough balance to debit that amount." });
        }
    }
    const action = amount > 0 ? "Credited" : "Debited";
    const color = amount > 0 ? 0x00cc6a : 0xff4444;
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(color)
        .setTitle(`🔧 Balance ${action}`)
        .addFields({ name: "User", value: `<@${target.id}>`, inline: true }, { name: "Amount", value: `**${(0, format_js_1.formatSats)(Math.abs(amount))}**`, inline: true }, { name: "Reason", value: reason })
        .setTimestamp();
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
