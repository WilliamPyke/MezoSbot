import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { subtractBalance, addBalance, getBalance } from "../balance.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats, roundSats } from "../format.js";

export const data = {
  name: "tip",
  description: "Send sats to another user",
  options: [
    { name: "user", type: 6 as const, description: "User to tip", required: true },
    { name: "amount", type: 10 as const, description: "Amount in sats (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getNumber("amount", true);

  if (target.id === interaction.user.id) {
    return interaction.reply({ content: "❌ You can't tip yourself.", ephemeral: true });
  }

  if (target.bot) {
    return interaction.reply({ content: "❌ You can't tip bots.", ephemeral: true });
  }

  const roundedAmount = roundSats(amount);
  const balance = await getBalance(interaction.user.id);
  if (balance < roundedAmount) {
    return interaction.reply({ content: "❌ Insufficient balance.", ephemeral: true });
  }

  await interaction.deferReply();

  if (!(await subtractBalance(interaction.user.id, amount))) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  await addBalance(target.id, amount);
  await registerDepositAddress(target.id);

  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("💫 Tip Sent!")
    .addFields(
      { name: "From", value: `<@${interaction.user.id}>`, inline: true },
      { name: "To", value: `<@${target.id}>`, inline: true },
      { name: "Amount", value: `**${formatSats(amount)}**`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
