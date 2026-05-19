import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { subtractBalance, addBalance, getBalance } from "../balance.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats } from "../format.js";
import { sendTransferReceivedDm } from "../notifications.js";
import { supabase } from "../db.js";
import { updateUserBadges } from "../badges.js";


export const data = {
  name: "tip",
  description: "Send sats to another user",
  options: [
    { name: "user", type: 6 as const, description: "User to tip", required: true },
    { name: "amount", type: 10 as const, description: "Amount in sats (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
    { name: "message", type: 3 as const, description: "Optional message for the recipient", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getNumber("amount", true);
  const rawMessage = interaction.options.getString("message");
  const trimmedMessage = rawMessage?.trim() ?? "";
  const customMessage = trimmedMessage.length > 0 ? trimmedMessage : undefined;

  if (customMessage && customMessage.length > 200) {
    return interaction.reply({ content: "❌ Message must be 200 characters or fewer.", flags: MessageFlags.Ephemeral });
  }

  if (target.id === interaction.user.id) {
    return interaction.reply({ content: "❌ You can't tip yourself.", flags: MessageFlags.Ephemeral });
  }

  if (target.bot) {
    return interaction.reply({ content: "❌ You can't tip bots.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const balance = await getBalance(interaction.user.id);
  if (balance < amount) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  if (!(await subtractBalance(interaction.user.id, amount))) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  await addBalance(target.id, amount);
  await registerDepositAddress(target.id);
  await sendTransferReceivedDm({
    client: interaction.client,
    recipientId: target.id,
    senderId: interaction.user.id,
    amountSats: amount,
    kind: "tip",
    customMessage,
  });

  // Log the tip in the database
  await supabase.from("tips").insert({
    sender_id: interaction.user.id,
    recipient_id: target.id,
    amount_sats: amount,
  });

  // Update user badge roles in Discord
  if (interaction.guildId) {
    updateUserBadges(interaction.client, interaction.guildId, interaction.user.id).catch((err) => {
      console.error("[Badges] Error updating badges for user after tip:", err);
    });
  }


  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("💫 Tip Sent!")
    .addFields(
      { name: "From", value: `<@${interaction.user.id}>`, inline: true },
      { name: "To", value: `<@${target.id}>`, inline: true },
      { name: "Amount", value: `**${formatSats(amount)}**`, inline: true },
    )
    .setTimestamp();

  if (customMessage) {
    embed.addFields({ name: "Message", value: customMessage });
  }

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
