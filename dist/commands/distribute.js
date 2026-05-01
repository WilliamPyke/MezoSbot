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
    name: "distribute",
    description: "Split sats among multiple users",
    options: [
        { name: "amount", type: 10, description: "Total sats to distribute (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
        { name: "users", type: 3, description: "Space-separated user mentions (@user1 @user2)", required: true },
    ],
};
async function execute(interaction) {
    const totalAmount = interaction.options.getNumber("amount", true);
    const usersStr = interaction.options.getString("users", true);
    const mentions = usersStr.match(/<@!?(\d+)>/g) ?? [];
    const userIds = [...new Set(mentions.map((m) => m.replace(/<@!?(\d+)>/, "$1")))];
    const validUsers = userIds.filter((id) => id !== interaction.user.id);
    if (validUsers.length === 0) {
        return interaction.reply({
            content: "❌ Include at least one valid user mention, e.g. `@user1 @user2`",
            ephemeral: true,
        });
    }
    const perUser = (0, format_js_1.roundSats)(totalAmount / validUsers.length);
    if (perUser < 0.000001) {
        return interaction.reply({
            content: "❌ Amount per user must be at least 0.000001 sats.",
            ephemeral: true,
        });
    }
    const totalNeeded = (0, format_js_1.roundSats)(perUser * validUsers.length);
    await interaction.deferReply();
    const balance = await (0, balance_js_1.getBalance)(interaction.user.id);
    if (balance < totalNeeded) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, totalNeeded))) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    // Parallelize balance additions, address registrations, and recipient DMs.
    await Promise.all(validUsers.map(async (uid) => {
        await (0, balance_js_1.addBalance)(uid, perUser);
        await (0, evm_js_1.registerDepositAddress)(uid).catch(() => { });
        await (0, notifications_js_1.sendTransferReceivedDm)({
            client: interaction.client,
            recipientId: uid,
            senderId: interaction.user.id,
            amountSats: perUser,
            kind: "distribute",
        });
    }));
    const recipients = validUsers.map((id) => `<@${id}>`).join("\n");
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle("📤 Sats Distributed!")
        .setDescription(`<@${interaction.user.id}> split sats across ${validUsers.length} user${validUsers.length === 1 ? "" : "s"}.`)
        .addFields({ name: "Per User", value: `**${(0, format_js_1.formatSats)(perUser)}**`, inline: true }, { name: "Total", value: `**${(0, format_js_1.formatSats)(totalNeeded)}**`, inline: true }, { name: "Recipients", value: recipients })
        .setTimestamp();
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
