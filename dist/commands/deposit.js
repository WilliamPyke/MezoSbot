"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const qrcode_1 = __importDefault(require("qrcode"));
const evm_js_1 = require("../evm.js");
const config_js_1 = require("../config.js");
exports.data = {
    name: "deposit",
    description: "Get your personal deposit address",
};
async function execute(interaction) {
    if (config_js_1.config.depositAdminOnly && !config_js_1.config.discord.adminIds.includes(interaction.user.id)) {
        return interaction.reply({ content: "❌ Deposits are currently disabled.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const address = await (0, evm_js_1.registerDepositAddress)(interaction.user.id);
    const explorer = config_js_1.config.evm.explorerUrl;
    const qrBuffer = await qrcode_1.default.toBuffer(address, {
        width: 256,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
    });
    const attachment = new discord_js_1.AttachmentBuilder(qrBuffer, { name: "deposit-qr.png" });
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📍 Your Deposit Address")
        .setDescription(`\`${address}\``)
        .addFields({ name: "How It Works", value: "Send BTC to this address from any wallet. Your balance is credited **automatically** within ~15 seconds." }, { name: "Network Fee", value: "A small gas fee (~3 sats) is deducted per deposit." }, { name: "Explorer", value: `[View on Explorer](${explorer}/address/${address})` })
        .setThumbnail("attachment://deposit-qr.png")
        .setFooter({ text: "This address is unique to you" })
        .setTimestamp();
    const webButton = new discord_js_1.ButtonBuilder()
        .setLabel("Deposit via Wallet")
        .setStyle(discord_js_1.ButtonStyle.Link)
        .setURL(`${config_js_1.config.depositWebUrl}?uid=${interaction.user.id}`)
        .setEmoji("🌐");
    const row = new discord_js_1.ActionRowBuilder().addComponents(webButton);
    await interaction.editReply({
        embeds: [embed],
        files: [attachment],
        components: [row],
    });
}
