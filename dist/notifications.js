"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTransferReceivedDm = sendTransferReceivedDm;
const discord_js_1 = require("discord.js");
const format_js_1 = require("./format.js");
const TITLES = {
    tip: "⚡ You Received a Tip!",
    rain: "🌧️ You Were Rained On!",
    distribute: "📤 You Received a Distribution!",
    drop: "🎁 You Claimed a Drop!",
    quest: "Quest Reward Earned",
};
const LABELS = {
    tip: "Tip",
    rain: "Rain",
    distribute: "Distribution",
    drop: "Drop Claim",
    quest: "Event Quest",
};
const COLORS = {
    tip: 0x00cc6a,
    rain: 0x3498db,
    distribute: 0x9b59b6,
    drop: 0xf0b232,
    quest: 0x00cc6a,
};
async function sendTransferReceivedDm({ client, recipientId, senderId, amountSats, kind, customMessage, }) {
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(COLORS[kind])
        .setTitle(TITLES[kind])
        .addFields({ name: "From", value: `<@${senderId}>`, inline: true }, { name: "Type", value: LABELS[kind], inline: true }, { name: "Amount", value: `**${(0, format_js_1.formatSats)(amountSats)}**`, inline: true })
        .setFooter({ text: "Use /balance to check your total" })
        .setTimestamp();
    if (customMessage) {
        embed.addFields({ name: "Message", value: customMessage });
    }
    try {
        const recipient = await client.users.fetch(recipientId);
        await recipient.send({ embeds: [embed] });
    }
    catch {
        // Intentionally ignore DM failures so successful transfers are never blocked.
    }
}
