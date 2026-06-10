import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

export async function replyInsufficientBalance(
  interaction: ChatInputCommandInteraction,
  content = "❌ Insufficient balance.",
) {
  if (!interaction.deferred && !interaction.replied) {
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  try {
    await interaction.deleteReply();
  } catch {
    // The original response may already be gone or unavailable; still send the private notice.
  }

  return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
}
