"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const balance_js_1 = require("../balance.js");
const tokens_js_1 = require("../tokens.js");
exports.data = {
    name: "balance",
    description: "Check your token balances",
};
async function execute(interaction) {
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const balances = await (0, balance_js_1.getBalances)(interaction.user.id);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("💰 Your Balance")
        .setDescription(tokens_js_1.TOKEN_SYMBOLS.map((token) => `**${(0, tokens_js_1.tokenLabel)(token)}**  ${(0, tokens_js_1.formatTokenAmount)(balances[token], token)}`).join("\n"))
        .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
}
