import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { transferBalance } from "../balance.js";
import { isDefiniteDbFailure, settledState } from "../depositPolicy.js";
import { withdrawalsBlockedMessage } from "../custody/state.js";
import {
  executeWithdrawal,
  finalizeWithdrawal,
  getSweepGasSponsorAddress,
  preflightWithdrawal,
  registerDepositAddress,
  reserveWithdrawal,
} from "../evm.js";
import { formatSats } from "../format.js";
import { sendTransferReceivedDm } from "../notifications.js";
import { supabase } from "../db.js";
import { updateUserBadges } from "../badges.js";
import { recordLedgerEntry } from "../ledger.js";
import { replyInsufficientBalance } from "./responses.js";
import {
  reservationFailureMessage,
  userWithdrawalLimitMessage,
  withdrawalPreflightMessage,
  withdrawalsPausedMessage,
} from "./withdraw.js";
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
  // A sponsor tip sends custodial SATS on-chain, so it obeys the withdrawal switch.
  if (sponsor && !config.withdrawals.enabled) {
    return interaction.reply({ content: withdrawalsPausedMessage(), flags: MessageFlags.Ephemeral });
  }
  const custodyBlocked = sponsor ? withdrawalsBlockedMessage() : null;
  if (custodyBlocked) {
    return interaction.reply({ content: `⏸️ ${custodyBlocked}`, flags: MessageFlags.Ephemeral });
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

  if (sponsor) return tipGasSponsor(interaction, amount);
  if (!target) throw new Error("Tip destination was not resolved");

  // Acknowledge before any balance changes. If this interaction is delivered
  // twice (two instances overlap during a deploy), the second copy fails here
  // with nothing debited, and a slow database cannot expire the interaction
  // after the sender has paid.
  await interaction.deferReply();

  // Debit and credit happen in one database transaction: both or neither.
  let sent: boolean;
  try {
    sent = await transferBalance(interaction.user.id, target.id, amount, token);
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    if (isDefiniteDbFailure(error)) {
      console.error(`[Tip] Transfer of ${amount} ${token} from ${interaction.user.id} to ${target.id} failed: ${message}`);
      return interaction.editReply({ content: TIP_FAILED_MESSAGE });
    }
    console.error(
      `[Tip] MANUAL REPAIR: transfer of ${amount} ${token} from ${interaction.user.id} to ${target.id} ` +
      `is unconfirmed (${message}); check both balances`,
    );
    return interaction.editReply({ content: TIP_UNCONFIRMED_MESSAGE });
  }
  if (!sent) {
    return replyInsufficientBalance(interaction);
  }

  await registerDepositAddress(target.id).catch((err) => {
    console.warn(`[Tip] Failed to register deposit address for ${target.id}:`, (err as Error)?.message ?? err);
  });
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

const TIP_FAILED_MESSAGE = "❌ The tip could not be sent and nothing was taken from your balance. Please try again.";
const TIP_UNCONFIRMED_MESSAGE =
  "⚠️ The tip could not be confirmed. An admin has been alerted to check it. Please don't resend.";

/**
 * Admin SATS contribution to the sweep gas sponsor. It sends custodial SATS
 * on-chain, so it runs the full withdrawal pipeline: pre-debit solvency and
 * coverage checks, a durable withdrawals row, the hash persisted before
 * broadcast, and a refund only when the tx provably cannot land.
 */
async function tipGasSponsor(interaction: ChatInputCommandInteraction, amount: number) {
  await interaction.deferReply();

  const sponsorAddress = getSweepGasSponsorAddress();
  const capMessage = await userWithdrawalLimitMessage(interaction.user.id, "SATS", amount);
  if (capMessage) {
    return interaction.editReply({ content: capMessage });
  }
  const preflight = await preflightWithdrawal(sponsorAddress, amount, "SATS");
  if (!preflight.ok) {
    return interaction.editReply({ content: withdrawalPreflightMessage(preflight) });
  }

  const reservation = await reserveWithdrawal({
    discordId: interaction.user.id,
    toAddress: sponsorAddress,
    amount,
    token: "SATS",
  });
  if (!reservation.ok) {
    if (reservation.reason === "insufficient_token" || reservation.reason === "insufficient_sats") {
      return replyInsufficientBalance(interaction);
    }
    return interaction.editReply({ content: reservationFailureMessage(reservation.reason) });
  }

  recordLedgerEntry(interaction.client, {
    type: "withdrawal",
    amountSats: amount,
    token: "SATS",
    senderId: interaction.user.id,
    receiverId: "treasury",
    guildId: interaction.guildId,
    referenceType: "withdrawals",
    referenceId: String(reservation.record.id),
    metadata: { destination: "sweep_gas_sponsor" },
  });

  const result = await executeWithdrawal(reservation.record);
  const final = await finalizeWithdrawal(reservation.record, result, {
    client: interaction.client,
    guildId: interaction.guildId,
  });

  const state = settledState(final);
  if (state === "refunded") {
    return interaction.editReply({ content: `❌ Sponsor tip failed and was refunded: ${result.error ?? "transaction did not go through"}` });
  }
  if (state === "refund_pending") {
    return interaction.editReply({
      content: `❌ Sponsor tip failed: ${result.error ?? "transaction did not go through"}. The refund is being processed and should land within a few minutes.`,
    });
  }
  if (state === "pending") {
    const link = result.txHash ? ` [View on Explorer](${config.evm.explorerUrl}/tx/${result.txHash})` : "";
    return interaction.editReply({
      content: `⏳ Sponsor tip submitted and still confirming; it will be finalized automatically.${link}`,
    });
  }

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
