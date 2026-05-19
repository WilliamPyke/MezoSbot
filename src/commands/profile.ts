import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { getOrCreateUser } from "../balance.js";
import { formatSats } from "../format.js";
import { updateUserBadges, TIPPER_STAGES, RAINER_STAGES } from "../badges.js";

export const data = {
  name: "profile",
  description: "View a user's stats, balance, and achievements",
  options: [
    {
      name: "user",
      type: 6 as const, // User type
      description: "User to view profile of",
      required: false,
    },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser("user") ?? interaction.user;

  await interaction.deferReply();

  // Run self-healing badge role updates in guild
  if (interaction.guildId) {
    await updateUserBadges(interaction.client, interaction.guildId, target.id).catch((err) => {
      console.error("[Profile] Error updating user badges:", err);
    });
  }

  // Get user profile data from DB
  const dbUser = await getOrCreateUser(target.id);

  // Fetch totals from views
  const { data: tipData } = await supabase
    .from("user_tip_stats")
    .select("total_tipped_sats")
    .eq("discord_id", target.id)
    .single();

  const { data: rainData } = await supabase
    .from("user_rain_stats")
    .select("total_rained_sats")
    .eq("discord_id", target.id)
    .single();

  const totalTipped = tipData?.total_tipped_sats ?? 0;
  const totalRained = rainData?.total_rained_sats ?? 0;

  // Find earned stages
  const earnedTipperStages = TIPPER_STAGES.filter((s) => totalTipped >= s.thresholdSats);
  const earnedRainerStages = RAINER_STAGES.filter((s) => totalRained >= s.thresholdSats);

  const activeTipper = earnedTipperStages[earnedTipperStages.length - 1] ?? null;
  const activeRainer = earnedRainerStages[earnedRainerStages.length - 1] ?? null;

  const nextTipper = TIPPER_STAGES.find((s) => totalTipped < s.thresholdSats) ?? null;
  const nextRainer = RAINER_STAGES.find((s) => totalRained < s.thresholdSats) ?? null;

  // Build progress bar helper
  const buildProgressBar = (current: number, target: number, size = 10) => {
    const fraction = Math.min(Math.max(current / target, 0), 1);
    const filledCount = Math.round(fraction * size);
    const emptyCount = size - filledCount;
    return `\`[${"█".repeat(filledCount)}${"░".repeat(emptyCount)}]\` ${Math.round(fraction * 100)}%`;
  };

  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle(`${target.displayName ?? target.username}'s Profile`)
    .setDescription(`<@${target.id}>`)
    .setThumbnail(target.displayAvatarURL({ size: 128 }) || null)
    .addFields(
      { name: "🪙 Balance", value: `**${formatSats(dbUser.balance_sats)}**`, inline: true },
      { name: "📊 Statistics", value: `📤 Tipped: **${formatSats(totalTipped)}**\n🌧️ Rained: **${formatSats(totalRained)}**`, inline: true }
    );

  // Achievements section
  const achievementLines: string[] = [];

  if (activeTipper) {
    achievementLines.push(`${activeTipper.emoji} **${activeTipper.stageName}** (Tier ${earnedTipperStages.length}/6)`);
  } else {
    achievementLines.push("⚪ *No Tipping Badges earned*");
  }

  if (nextTipper) {
    achievementLines.push(`↳ Next: **${nextTipper.stageName}** (${formatSats(totalTipped)} / ${formatSats(nextTipper.thresholdSats)})\n${buildProgressBar(totalTipped, nextTipper.thresholdSats)}`);
  } else {
    achievementLines.push("🏆 *Max Tipping Level Reached!*");
  }

  achievementLines.push(""); // Spacing

  if (activeRainer) {
    achievementLines.push(`${activeRainer.emoji} **${activeRainer.stageName}** (Tier ${earnedRainerStages.length}/6)`);
  } else {
    achievementLines.push("⚪ *No Raining Badges earned*");
  }

  if (nextRainer) {
    achievementLines.push(`↳ Next: **${nextRainer.stageName}** (${formatSats(totalRained)} / ${formatSats(nextRainer.thresholdSats)})\n${buildProgressBar(totalRained, nextRainer.thresholdSats)}`);
  } else {
    achievementLines.push("🏆 *Max Raining Level Reached!*");
  }

  embed.addFields({ name: "🏆 Badges & Achievements", value: achievementLines.join("\n"), inline: false });
  embed.setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
