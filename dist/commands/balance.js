"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const balance_js_1 = require("../balance.js");
const format_js_1 = require("../format.js");
exports.data = {
    name: "balance",
    description: "Check your sats balance",
};
async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const bal = await (0, balance_js_1.getBalance)(interaction.user.id);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("💰 Your Balance")
        .setDescription(`**${(0, format_js_1.formatSats)(bal)}**`)
        .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
}
