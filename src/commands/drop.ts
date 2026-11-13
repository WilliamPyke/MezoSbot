import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { isDefiniteDbFailure } from "../depositPolicy.js";
import { buildDropEmbed, buildClaimButton, cancelDropAndRefund, createFundedDrop, type Drop } from "../drops.js";
import { recordLedgerEntry } from "../ledger.js";
import { replyInsufficientBalance } from "./responses.js";
import { TOKEN_CHOICES, formatTokenAmount, parseToken, roundTokenAmount } from "../tokens.js";

export const data = {
  name: "drop",
  description: "Create a token drop",
  options: [
    { name: "total", type: 10 as const, description: "Total token amount to drop", required: true, minValue: 0.000001 },
    { name: "per_claim", type: 10 as const, description: "Token amount per claim", required: true, minValue: 0.000001 },
    { name: "max_claims", type: 4 as const, description: "Max number of claims", required: true, minValue: 1 },
    { name: "token", type: 3 as const, description: "Token to drop", required: false, choices: TOKEN_CHOICES },
    { name: "role", type: 8 as const, description: "Only members with this role can claim", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const token = parseToken(interaction.options.getString("token"));
  const total = roundTokenAmount(interaction.options.getNumber("total", true), token);
  const perClaim = roundTokenAmount(interaction.options.getNumber("per_claim", true), token);
  const maxClaims = interaction.options.getInteger("max_claims", true);
  const role = interaction.options.getRole("role");

  if (perClaim * maxClaims > total) {
    return interaction.reply({
      content: "❌ `per_claim` × `max_claims` cannot exceed `total`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Acknowledge before any balance changes. If this interaction is delivered
  // twice (two instances overlap during a deploy), the second copy fails here
  // with nothing debited, and a slow database cannot expire the interaction
  // after the creator has paid.
  await interaction.deferReply();

  let dropId: number | null;
  try {
    dropId = await createFundedDrop({
      channelId: interaction.channelId!,
      creatorId: interaction.user.id,
      token,
      total,
      perClaim,
      maxClaims,
      eligibleRoleId: role?.id ?? null,
    });
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    if (isDefiniteDbFailure(error)) {
      console.error(`[Drop] Creating a drop for ${interaction.user.id} failed: ${message}`);
      return interaction.editReply({ content: "❌ The drop could not be created and nothing was taken from your balance. Please try again." });
    }
    console.error(
      `[Drop] MANUAL REPAIR: drop of ${total} ${token} by ${interaction.user.id} is unconfirmed (${message}); ` +
      `check drops and the creator's balance`,
    );
    return interaction.editReply({ content: "⚠️ The drop could not be confirmed. An admin has been alerted. Please don't retry yet." });
  }
  if (dropId == null) {
    return replyInsufficientBalance(interaction);
  }

  recordLedgerEntry(interaction.client, {
    type: "drop_create",
    amountSats: total,
    token,
    senderId: interaction.user.id,
    receiverId: null,
    guildId: interaction.guildId,
    referenceType: "drops",
    referenceId: String(dropId),
  });

  const drop: Drop = {
    id: dropId,
    channel_id: interaction.channelId!,
    creator_id: interaction.user.id,
    message_id: null,
    eligible_role_id: role?.id ?? null,
    total_sats: total,
    per_claim_sats: perClaim,
    max_claims: maxClaims,
    claims_count: 0,
    status: "active",
    token,
  };

  let reply;
  try {
    reply = await interaction.editReply({
      embeds: [buildDropEmbed(drop, [])],
      components: [buildClaimButton(dropId)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    // Nobody can see the drop, so it would hold the creator's funds forever.
    console.error(`[Drop] Could not post drop ${dropId}; cancelling it:`, (error as Error)?.message ?? error);
    await refundUnpostedDrop(interaction, dropId, token);
    return;
  }

  await supabase
    .from("drops")
    .update({ message_id: reply.id })
    .eq("id", dropId);
}

async function refundUnpostedDrop(
  interaction: ChatInputCommandInteraction,
  dropId: number,
  token: Drop["token"],
): Promise<void> {
  let notice: string;
  try {
    const refund = await cancelDropAndRefund(interaction.client, {
      id: dropId,
      creatorId: interaction.user.id,
      token,
      guildId: interaction.guildId,
    });
    notice = refund == null
      ? "⚠️ Your drop could not be posted and was already closed."
      : `❌ Your drop could not be posted, so it was cancelled and ${formatTokenAmount(refund, token)} was returned to you.`;
  } catch (error) {
    console.error(
      `[Drop] MANUAL REPAIR: drop ${dropId} by ${interaction.user.id} was not posted and could not be cancelled: ` +
      `${(error as Error)?.message ?? error}`,
    );
    notice = "⚠️ Your drop could not be posted or refunded. An admin has been alerted.";
  }
  await interaction.followUp({ content: notice, flags: MessageFlags.Ephemeral }).catch(() => {});
}
