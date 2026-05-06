"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const balance_js_1 = require("../balance.js");
const evm_js_1 = require("../evm.js");
const format_js_1 = require("../format.js");
const notifications_js_1 = require("../notifications.js");
exports.data = {
    name: "tip",
    description: "Send sats to another user",
    options: [
        { name: "user", type: 6, description: "User to tip", required: true },
        { name: "amount", type: 10, description: "Amount in sats (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
        { name: "message", type: 3, description: "Optional message for the recipient", required: false },
    ],
};
async function execute(interaction) {
    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getNumber("amount", true);
    const rawMessage = interaction.options.getString("message");
    const trimmedMessage = rawMessage?.trim() ?? "";
    const customMessage = trimmedMessage.length > 0 ? trimmedMessage : undefined;
    if (customMessage && customMessage.length > 200) {
        return interaction.reply({ content: "❌ Message must be 200 characters or fewer.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (target.id === interaction.user.id) {
        return interaction.reply({ content: "❌ You can't tip yourself.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (target.bot) {
        return interaction.reply({ content: "❌ You can't tip bots.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    const balance = await (0, balance_js_1.getBalance)(interaction.user.id);
    if (balance < amount) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, amount))) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    await (0, balance_js_1.addBalance)(target.id, amount);
    await (0, evm_js_1.registerDepositAddress)(target.id);
    await (0, notifications_js_1.sendTransferReceivedDm)({
        client: interaction.client,
        recipientId: target.id,
        senderId: interaction.user.id,
        amountSats: amount,
        kind: "tip",
        customMessage,
    });
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("💫 Tip Sent!")
        .addFields({ name: "From", value: `<@${interaction.user.id}>`, inline: true }, { name: "To", value: `<@${target.id}>`, inline: true }, { name: "Amount", value: `**${(0, format_js_1.formatSats)(amount)}**`, inline: true })
        .setTimestamp();
    if (customMessage) {
        embed.addFields({ name: "Message", value: customMessage });
    }
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
