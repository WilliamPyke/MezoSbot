import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { getSatsBackingSnapshot, getTreasuryAddress, getTreasuryBalances } from "../evm.js";
import { formatSats } from "../format.js";
import { formatTokenAmount, tokenLabel, TOKEN_SYMBOLS } from "../tokens.js";
import { config } from "../config.js";

export const data = {
  name: "treasury",
  description: "View the bot's treasury balance",
};

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const [balances, backing] = await Promise.all([getTreasuryBalances(), getSatsBackingSnapshot()]);
    const addr = getTreasuryAddress();
    const explorer = config.evm.explorerUrl;
    const liabilities = backing.userLiabilities + backing.poolLiabilities;
    const shortfall = Math.max(0, liabilities + backing.reserveSats - backing.treasurySats);
    const underbacked = shortfall > 0;

    const embed = new EmbedBuilder()
      .setColor(underbacked ? 0xff4444 : 0xf0b232)
      .setTitle("🏦 Treasury")
      .addFields(
        { name: "Balances", value: TOKEN_SYMBOLS.map((token) => `**${tokenLabel(token)}:** ${formatTokenAmount(balances[token], token)}`).join("\n"), inline: true },
        { name: "Address", value: `[\`${addr.slice(0, 10)}...${addr.slice(-8)}\`](${explorer}/address/${addr})`, inline: true },
        {
          name: "SATS backing",
          value: [
            `On-chain: **${formatSats(backing.treasurySats)}**`,
            `User balances: **${formatSats(liabilities)}**`,
            underbacked
              ? `Shortfall: **${formatSats(shortfall)}** (includes ${formatSats(backing.reserveSats)} gas reserve)`
              : `Excess: **${formatSats(backing.excessSats)}** · reserve ${formatSats(backing.reserveSats)}`,
          ].join("\n"),
        },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply({ content: "❌ Could not fetch treasury balance." });
  }
}
