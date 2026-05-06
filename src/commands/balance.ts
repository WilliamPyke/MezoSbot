import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { getBalance } from "../balance.js";
import { formatSats } from "../format.js";

export const data = {
  name: "balance",
  description: "Check your sats balance",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const bal = await getBalance(interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("💰 Your Balance")
    .setDescription(`**${formatSats(bal)}**`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
