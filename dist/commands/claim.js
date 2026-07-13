"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const db_js_1 = require("../db.js");
const drops_js_1 = require("../drops.js");
const notifications_js_1 = require("../notifications.js");
const badges_js_1 = require("../badges.js");
const tokens_js_1 = require("../tokens.js");
exports.data = {
    name: "claim",
    description: "Claim sats from the active drop in this channel",
};
async function execute(interaction) {
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const { data: drop } = await db_js_1.supabase
        .from("drops")
        .select("*")
        .eq("channel_id", interaction.channelId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
    if (!drop) {
        return interaction.editReply({ content: "❌ No active drop in this channel." });
    }
    const member = interaction.guild
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
    const claimantRoleIds = member ? [...member.roles.cache.keys()] : [];
    const result = await (0, drops_js_1.processClaim)(drop.id, interaction.user.id, claimantRoleIds, interaction.client, interaction.guildId);
    if (!result.ok) {
        return interaction.editReply({ content: `❌ ${result.error}` });
    }
    await (0, notifications_js_1.sendTransferReceivedDm)({
        client: interaction.client,
        recipientId: interaction.user.id,
        senderId: result.creatorId ?? drop.creator_id,
        amountSats: result.amountSats ?? drop.per_claim_sats,
        token: (0, tokens_js_1.parseToken)(drop.token),
        kind: "drop",
    });
    // Update drop creator's badge roles in Discord (since their rained total increased)
    if (interaction.guildId && (result.creatorId ?? drop.creator_id)) {
        (0, badges_js_1.updateUserBadges)(interaction.client, interaction.guildId, result.creatorId ?? drop.creator_id).catch((err) => {
            console.error("[Badges] Error updating drop creator badges after claim:", err);
        });
    }
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("🎉 Claimed!")
        .addFields({ name: "Amount", value: `**${(0, tokens_js_1.formatTokenAmount)(result.amountSats ?? drop.per_claim_sats, (0, tokens_js_1.parseToken)(drop.token))}**`, inline: true }, { name: "Remaining", value: `**${result.remaining}**`, inline: true });
    await interaction.editReply({ embeds: [embed] });
    if (interaction.client) {
        (0, drops_js_1.updateDropMessage)(interaction.client, drop).catch(() => { });
    }
}
