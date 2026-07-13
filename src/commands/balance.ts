import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { getBalances } from "../balance.js";
import { formatTokenAmount, tokenLabel, TOKEN_SYMBOLS } from "../tokens.js";

export const data = {
  name: "balance",
  description: "Check your token balances",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const balances = await getBalances(interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("💰 Your Balance")
    .setDescription(TOKEN_SYMBOLS.map((token) => `**${tokenLabel(token)}**  ${formatTokenAmount(balances[token], token)}`).join("\n"))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
