"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const balance_js_1 = require("../balance.js");
const evm_js_1 = require("../evm.js");
const format_js_1 = require("../format.js");
const notifications_js_1 = require("../notifications.js");
const db_js_1 = require("../db.js");
const badges_js_1 = require("../badges.js");
const ledger_js_1 = require("../ledger.js");
const responses_js_1 = require("./responses.js");
const tokens_js_1 = require("../tokens.js");
const config_js_1 = require("../config.js");
exports.data = {
    name: "tip",
    description: "Send a token to another user",
    options: [
        { name: "amount", type: 10, description: "Token amount (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
        { name: "user", type: 6, description: "User to tip", required: false },
        { name: "sponsor", type: 5, description: "Admin: tip SATS to the sweep gas sponsor", required: false },
        { name: "token", type: 3, description: "Token to tip (defaults to SATS)", required: false, choices: tokens_js_1.TOKEN_CHOICES },
        { name: "message", type: 3, description: "Optional message for the recipient", required: false },
    ],
};
async function execute(interaction) {
    const target = interaction.options.getUser("user");
    const sponsor = interaction.options.getBoolean("sponsor") ?? false;
    const token = (0, tokens_js_1.parseToken)(interaction.options.getString("token"));
    const amount = (0, tokens_js_1.roundTokenAmount)(interaction.options.getNumber("amount", true), token);
    const rawMessage = interaction.options.getString("message");
    const trimmedMessage = rawMessage?.trim() ?? "";
    const customMessage = trimmedMessage.length > 0 ? trimmedMessage : undefined;
    if ((target == null) === !sponsor) {
        return interaction.reply({ content: "❌ Choose exactly one destination: a user or the gas sponsor.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sponsor && !config_js_1.config.discord.adminIds.includes(interaction.user.id)) {
        return interaction.reply({ content: "❌ Gas sponsor tips are admin only.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (sponsor && token !== "SATS") {
        return interaction.reply({ content: "❌ The gas sponsor accepts SATS only.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (customMessage && customMessage.length > 200) {
        return interaction.reply({ content: "❌ Message must be 200 characters or fewer.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (target?.id === interaction.user.id) {
        return interaction.reply({ content: "❌ You can't tip yourself.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (target?.bot) {
        return interaction.reply({ content: "❌ You can't tip bots.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    const balance = await (0, balance_js_1.getBalance)(interaction.user.id, token);
    if (balance < amount) {
        return (0, responses_js_1.replyInsufficientBalance)(interaction);
    }
    if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, amount, token))) {
        return (0, responses_js_1.replyInsufficientBalance)(interaction);
    }
    await interaction.deferReply();
    if (sponsor) {
        const result = await (0, evm_js_1.withdraw)((0, evm_js_1.getSweepGasSponsorAddress)(), amount, "SATS");
        if (result.error || !result.confirmed) {
            await (0, balance_js_1.addBalance)(interaction.user.id, amount, "SATS");
            return interaction.editReply({ content: `❌ Sponsor tip failed and was refunded: ${result.error ?? "transaction was not confirmed"}` });
        }
        (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
            type: "tip",
            amountSats: amount,
            token: "SATS",
            senderId: interaction.user.id,
            receiverId: "platform",
            guildId: interaction.guildId,
            referenceType: "gas_sponsor_tip",
            referenceId: result.txHash ?? null,
            metadata: { destination: "sweep_gas_sponsor", sent_sats: result.sentSats, gas_sats: result.gasSats },
        });
        return interaction.editReply({
            embeds: [new discord_js_1.EmbedBuilder()
                    .setColor(0x00cc6a)
                    .setTitle("⛽ Gas Sponsor Funded")
                    .addFields({ name: "Contributed", value: `**${(0, format_js_1.formatSats)(amount)}**`, inline: true }, { name: "Received", value: `**${(0, format_js_1.formatSats)(result.sentSats ?? 0)}**`, inline: true }, { name: "Network gas", value: `~${(0, format_js_1.formatSats)(result.gasSats ?? 0)}`, inline: true })
                    .setTimestamp()],
        });
    }
    if (!target)
        throw new Error("Tip destination was not resolved");
    await (0, balance_js_1.addBalance)(target.id, amount, token);
    await (0, evm_js_1.registerDepositAddress)(target.id);
    await (0, notifications_js_1.sendTransferReceivedDm)({
        client: interaction.client,
        recipientId: target.id,
        senderId: interaction.user.id,
        amountSats: amount,
        token,
        kind: "tip",
        customMessage,
    });
    const { data: tipRow } = await db_js_1.supabase.from("tips").insert({
        sender_id: interaction.user.id,
        recipient_id: target.id,
        amount_sats: amount,
        token,
    }).select("id").single();
    (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
        type: "tip",
        amountSats: amount,
        token,
        senderId: interaction.user.id,
        receiverId: target.id,
        guildId: interaction.guildId,
        referenceType: "tips",
        referenceId: tipRow?.id != null ? String(tipRow.id) : null,
    });
    // Update user badge roles in Discord
    if (interaction.guildId) {
        (0, badges_js_1.updateUserBadges)(interaction.client, interaction.guildId, interaction.user.id).catch((err) => {
            console.error("[Badges] Error updating badges for user after tip:", err);
        });
    }
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("💫 Tip Sent!")
        .addFields({ name: "From", value: `<@${interaction.user.id}>`, inline: true }, { name: "To", value: `<@${target.id}>`, inline: true }, { name: "Amount", value: `**${(0, tokens_js_1.formatTokenAmount)(amount, token)}**`, inline: true })
        .setTimestamp();
    if (customMessage) {
        embed.addFields({ name: "Message", value: customMessage });
    }
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
