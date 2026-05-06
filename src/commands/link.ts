import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { linkWallet } from "../balance.js";

export const data = {
  name: "link",
  description: "Link a default withdrawal address",
  options: [
    { name: "address", type: 3 as const, description: "Your wallet address (0x...)", required: true },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const address = interaction.options.getString("address", true);
  const { ok, error } = await linkWallet(interaction.user.id, address);
  if (!ok) {
    return interaction.editReply({ content: `❌ ${error}` });
  }

  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("✅ Wallet Linked")
    .setDescription(`Default withdrawal address set.`)
    .addFields(
      { name: "Address", value: `\`${address.slice(0, 10)}...${address.slice(-8)}\`` },
    )
    .setFooter({ text: "You can now use /withdraw without specifying an address" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
