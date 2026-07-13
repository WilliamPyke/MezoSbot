"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const balance_js_1 = require("../balance.js");
const evm_js_1 = require("../evm.js");
const notifications_js_1 = require("../notifications.js");
const ledger_js_1 = require("../ledger.js");
const responses_js_1 = require("./responses.js");
const tokens_js_1 = require("../tokens.js");
exports.data = {
    name: "distribute",
    description: "Split a token among multiple users",
    options: [
        { name: "amount", type: 10, description: "Total token amount to distribute", required: true, minValue: 0.000001 },
        { name: "users", type: 3, description: "Space-separated user mentions (@user1 @user2)", required: true },
        { name: "token", type: 3, description: "Token to distribute", required: false, choices: tokens_js_1.TOKEN_CHOICES },
    ],
};
async function execute(interaction) {
    const totalAmount = interaction.options.getNumber("amount", true);
    const usersStr = interaction.options.getString("users", true);
    const token = (0, tokens_js_1.parseToken)(interaction.options.getString("token"));
    const mentions = usersStr.match(/<@!?(\d+)>/g) ?? [];
    const userIds = [...new Set(mentions.map((m) => m.replace(/<@!?(\d+)>/, "$1")))];
    const validUsers = userIds.filter((id) => id !== interaction.user.id);
    if (validUsers.length === 0) {
        return interaction.reply({
            content: "❌ Include at least one valid user mention, e.g. `@user1 @user2`",
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    const perUser = (0, tokens_js_1.roundTokenAmount)(totalAmount / validUsers.length, token);
    if (perUser < 0.000001) {
        return interaction.reply({
            content: "❌ Amount per user must be at least 0.000001 sats.",
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    const totalNeeded = (0, tokens_js_1.roundTokenAmount)(perUser * validUsers.length, token);
    const balance = await (0, balance_js_1.getBalance)(interaction.user.id, token);
    if (balance < totalNeeded) {
        return (0, responses_js_1.replyInsufficientBalance)(interaction);
    }
    if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, totalNeeded, token))) {
        return (0, responses_js_1.replyInsufficientBalance)(interaction);
    }
    await interaction.deferReply();
    // Parallelize balance additions, address registrations, and recipient DMs.
    await Promise.all(validUsers.map(async (uid) => {
        await (0, balance_js_1.addBalance)(uid, perUser, token);
        await (0, evm_js_1.registerDepositAddress)(uid).catch(() => { });
        await (0, notifications_js_1.sendTransferReceivedDm)({
            client: interaction.client,
            recipientId: uid,
            senderId: interaction.user.id,
            amountSats: perUser,
            token,
            kind: "distribute",
        });
    }));
    (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
        type: "distribute",
        amountSats: totalNeeded,
        token,
        senderId: interaction.user.id,
        receiverId: null,
        guildId: interaction.guildId,
        metadata: { recipient_count: validUsers.length, per_user_sats: perUser, recipient_ids: validUsers },
    });
    const recipients = validUsers.map((id) => `<@${id}>`).join("\n");
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`📤 ${(0, tokens_js_1.tokenLabel)(token)} Distributed!`)
        .setDescription(`<@${interaction.user.id}> split ${(0, tokens_js_1.tokenLabel)(token)} across ${validUsers.length} user${validUsers.length === 1 ? "" : "s"}.`)
        .addFields({ name: "Per User", value: `**${(0, tokens_js_1.formatTokenAmount)(perUser, token)}**`, inline: true }, { name: "Total", value: `**${(0, tokens_js_1.formatTokenAmount)(totalNeeded, token)}**`, inline: true }, { name: "Recipients", value: recipients })
        .setTimestamp();
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
