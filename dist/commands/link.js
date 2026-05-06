"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const balance_js_1 = require("../balance.js");
exports.data = {
    name: "link",
    description: "Link a default withdrawal address",
    options: [
        { name: "address", type: 3, description: "Your wallet address (0x...)", required: true },
    ],
};
async function execute(interaction) {
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const address = interaction.options.getString("address", true);
    const { ok, error } = await (0, balance_js_1.linkWallet)(interaction.user.id, address);
    if (!ok) {
        return interaction.editReply({ content: `❌ ${error}` });
    }
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("✅ Wallet Linked")
        .setDescription(`Default withdrawal address set.`)
        .addFields({ name: "Address", value: `\`${address.slice(0, 10)}...${address.slice(-8)}\`` })
        .setFooter({ text: "You can now use /withdraw without specifying an address" })
        .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
}
