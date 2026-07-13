"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const evm_js_1 = require("../evm.js");
const tokens_js_1 = require("../tokens.js");
const config_js_1 = require("../config.js");
exports.data = {
    name: "treasury",
    description: "View the bot's treasury balance",
};
async function execute(interaction) {
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    try {
        const balances = await (0, evm_js_1.getTreasuryBalances)();
        const addr = (0, evm_js_1.getTreasuryAddress)();
        const explorer = config_js_1.config.evm.explorerUrl;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0xf0b232)
            .setTitle("🏦 Treasury")
            .addFields({ name: "Balances", value: tokens_js_1.TOKEN_SYMBOLS.map((token) => `**${(0, tokens_js_1.tokenLabel)(token)}:** ${(0, tokens_js_1.formatTokenAmount)(balances[token], token)}`).join("\n"), inline: true }, { name: "Address", value: `[\`${addr.slice(0, 10)}...${addr.slice(-8)}\`](${explorer}/address/${addr})`, inline: true })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    }
    catch {
        await interaction.editReply({ content: "❌ Could not fetch treasury balance." });
    }
}
