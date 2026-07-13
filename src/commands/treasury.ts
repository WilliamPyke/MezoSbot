import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { getTreasuryAddress, getTreasuryBalances } from "../evm.js";
import { formatTokenAmount, tokenLabel, TOKEN_SYMBOLS } from "../tokens.js";
import { config } from "../config.js";

export const data = {
  name: "treasury",
  description: "View the bot's treasury balance",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const balances = await getTreasuryBalances();
    const addr = getTreasuryAddress();
    const explorer = config.evm.explorerUrl;

    const embed = new EmbedBuilder()
      .setColor(0xf0b232)
      .setTitle("🏦 Treasury")
      .addFields(
        { name: "Balances", value: TOKEN_SYMBOLS.map((token) => `**${tokenLabel(token)}:** ${formatTokenAmount(balances[token], token)}`).join("\n"), inline: true },
        { name: "Address", value: `[\`${addr.slice(0, 10)}...${addr.slice(-8)}\`](${explorer}/address/${addr})`, inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply({ content: "❌ Could not fetch treasury balance." });
  }
}
