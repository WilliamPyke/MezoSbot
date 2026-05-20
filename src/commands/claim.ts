import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { processClaim, updateDropMessage, type Drop } from "../drops.js";
import { formatSats } from "../format.js";
import { sendTransferReceivedDm } from "../notifications.js";
import { updateUserBadges } from "../badges.js";


export const data = {
  name: "claim",
  description: "Claim sats from the active drop in this channel",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { data: drop } = await supabase
    .from("drops")
    .select("*")
    .eq("channel_id", interaction.channelId!)
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

  const result = await processClaim(
    drop.id,
    interaction.user.id,
    claimantRoleIds,
    interaction.client,
    interaction.guildId,
  );

  if (!result.ok) {
    return interaction.editReply({ content: `❌ ${result.error}` });
  }

  await sendTransferReceivedDm({
    client: interaction.client,
    recipientId: interaction.user.id,
    senderId: result.creatorId ?? drop.creator_id,
    amountSats: result.amountSats ?? drop.per_claim_sats,
    kind: "drop",
  });

  // Update drop creator's badge roles in Discord (since their rained total increased)
  if (interaction.guildId && (result.creatorId ?? drop.creator_id)) {
    updateUserBadges(interaction.client, interaction.guildId, result.creatorId ?? drop.creator_id).catch((err) => {
      console.error("[Badges] Error updating drop creator badges after claim:", err);
    });
  }


  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("🎉 Claimed!")
    .addFields(
      { name: "Amount", value: `**${formatSats(drop.per_claim_sats)}**`, inline: true },
      { name: "Remaining", value: `**${result.remaining}**`, inline: true },
    );

  await interaction.editReply({ embeds: [embed] });

  if (interaction.client) {
    updateDropMessage(interaction.client, drop as Drop).catch(() => {});
  }
}
