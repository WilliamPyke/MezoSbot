import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config } from "../config.js";
import { addBalance, subtractBalance } from "../balance.js";
import { formatSats } from "../format.js";
import { recordLedgerEntry } from "../ledger.js";

export const data = {
  name: "credit",
  description: "Admin: manually credit or debit a user's balance",
  default_member_permissions: "0",
  options: [
    { name: "user", type: 6 as const, description: "User to credit", required: true },
    { name: "amount", type: 10 as const, description: "Sats to add (negative to debit)", required: true },
    { name: "reason", type: 3 as const, description: "Reason for adjustment", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!config.discord.adminIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ Admin only.", flags: MessageFlags.Ephemeral });
  }

  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getNumber("amount", true);
  const reason = interaction.options.getString("reason") ?? "Manual adjustment";

  if (amount === 0) {
    return interaction.reply({ content: "❌ Amount can't be zero.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (amount > 0) {
    await addBalance(target.id, amount);
  } else {
    if (!(await subtractBalance(target.id, Math.abs(amount)))) {
      return interaction.editReply({ content: "❌ User doesn't have enough balance to debit that amount." });
    }
  }

  recordLedgerEntry(interaction.client, {
    type: amount > 0 ? "admin_credit" : "admin_debit",
    amountSats: Math.abs(amount),
    senderId: amount > 0 ? "treasury" : target.id,
    receiverId: amount > 0 ? target.id : "treasury",
    guildId: interaction.guildId,
    metadata: { reason, admin_id: interaction.user.id },
  });

  const action = amount > 0 ? "Credited" : "Debited";
  const color = amount > 0 ? 0x00cc6a : 0xff4444;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🔧 Balance ${action}`)
    .addFields(
      { name: "User", value: `<@${target.id}>`, inline: true },
      { name: "Amount", value: `**${formatSats(Math.abs(amount))}**`, inline: true },
      { name: "Reason", value: reason },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
