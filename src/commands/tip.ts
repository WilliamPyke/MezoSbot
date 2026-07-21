import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { subtractBalance, addBalance, getBalance } from "../balance.js";
import { getSweepGasSponsorAddress, registerDepositAddress, withdraw } from "../evm.js";
import { formatSats } from "../format.js";
import { sendTransferReceivedDm } from "../notifications.js";
import { supabase } from "../db.js";
import { updateUserBadges } from "../badges.js";
import { recordLedgerEntry } from "../ledger.js";
import { replyInsufficientBalance } from "./responses.js";
import { TOKEN_CHOICES, formatTokenAmount, parseToken, roundTokenAmount } from "../tokens.js";
import { config } from "../config.js";


export const data = {
  name: "tip",
  description: "Send a token to another user",
  options: [
    { name: "amount", type: 10 as const, description: "Token amount (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
    { name: "user", type: 6 as const, description: "User to tip", required: false },
    { name: "sponsor", type: 5 as const, description: "Admin: tip SATS to the sweep gas sponsor", required: false },
    { name: "token", type: 3 as const, description: "Token to tip (defaults to SATS)", required: false, choices: TOKEN_CHOICES },
    { name: "message", type: 3 as const, description: "Optional message for the recipient", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser("user");
  const sponsor = interaction.options.getBoolean("sponsor") ?? false;
  const token = parseToken(interaction.options.getString("token"));
  const amount = roundTokenAmount(interaction.options.getNumber("amount", true), token);
  const rawMessage = interaction.options.getString("message");
  const trimmedMessage = rawMessage?.trim() ?? "";
  const customMessage = trimmedMessage.length > 0 ? trimmedMessage : undefined;

  if ((target == null) === !sponsor) {
    return interaction.reply({ content: "❌ Choose exactly one destination: a user or the gas sponsor.", flags: MessageFlags.Ephemeral });
  }
  if (sponsor && !config.discord.adminIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ Gas sponsor tips are admin only.", flags: MessageFlags.Ephemeral });
  }
  if (sponsor && token !== "SATS") {
    return interaction.reply({ content: "❌ The gas sponsor accepts SATS only.", flags: MessageFlags.Ephemeral });
  }


  if (customMessage && customMessage.length > 200) {
    return interaction.reply({ content: "❌ Message must be 200 characters or fewer.", flags: MessageFlags.Ephemeral });
  }

  if (target?.id === interaction.user.id) {
    return interaction.reply({ content: "❌ You can't tip yourself.", flags: MessageFlags.Ephemeral });
  }

  if (target?.bot) {
    return interaction.reply({ content: "❌ You can't tip bots.", flags: MessageFlags.Ephemeral });
  }

  const balance = await getBalance(interaction.user.id, token);
  if (balance < amount) {
    return replyInsufficientBalance(interaction);
  }

  if (!(await subtractBalance(interaction.user.id, amount, token))) {
    return replyInsufficientBalance(interaction);
  }

  await interaction.deferReply();

  if (sponsor) {
    const result = await withdraw(getSweepGasSponsorAddress(), amount, "SATS");
    if (result.error || !result.confirmed) {
      await addBalance(interaction.user.id, amount, "SATS");
      return interaction.editReply({ content: `❌ Sponsor tip failed and was refunded: ${result.error ?? "transaction was not confirmed"}` });
    }
    recordLedgerEntry(interaction.client, {
      type: "tip",
      amountSats: amount,
      token: "SATS",
      senderId: interaction.user.id,
      receiverId: "platform",
      guildId: interaction.guildId,
      referenceType: "gas_sponsor_tip",
      referenceId: result.txHash ?? null,
      metadata: { destination: "sweep_gas_sponsor", sent_sats: result.sentSats, gas_sats: result.gasSats },
    });
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("⛽ Gas Sponsor Funded")
        .addFields(
          { name: "Contributed", value: `**${formatSats(amount)}**`, inline: true },
          { name: "Received", value: `**${formatSats(result.sentSats ?? 0)}**`, inline: true },
          { name: "Network gas", value: `~${formatSats(result.gasSats ?? 0)}`, inline: true },
        )
        .setTimestamp()],
    });
  }

  if (!target) throw new Error("Tip destination was not resolved");

  await addBalance(target.id, amount, token);
  await registerDepositAddress(target.id);
  await sendTransferReceivedDm({
    client: interaction.client,
    recipientId: target.id,
    senderId: interaction.user.id,
    amountSats: amount,
    token,
    kind: "tip",
    customMessage,
  });

  const { data: tipRow } = await supabase.from("tips").insert({
    sender_id: interaction.user.id,
    recipient_id: target.id,
    amount_sats: amount,
    token,
  }).select("id").single();

  recordLedgerEntry(interaction.client, {
    type: "tip",
    amountSats: amount,
    token,
    senderId: interaction.user.id,
    receiverId: target.id,
    guildId: interaction.guildId,
    referenceType: "tips",
    referenceId: tipRow?.id != null ? String(tipRow.id) : null,
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
      { name: "Amount", value: `**${formatTokenAmount(amount, token)}**`, inline: true },
    )
    .setTimestamp();

  if (customMessage) {
    embed.addFields({ name: "Message", value: customMessage });
  }

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
