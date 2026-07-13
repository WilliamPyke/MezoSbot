import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { subtractBalance, getBalance } from "../balance.js";
import { roundSats } from "../format.js";
import { buildDropEmbed, buildClaimButton, type Drop } from "../drops.js";
import { recordLedgerEntry } from "../ledger.js";
import { replyInsufficientBalance } from "./responses.js";
import { TOKEN_CHOICES, parseToken, roundTokenAmount } from "../tokens.js";

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

  const balance = await getBalance(interaction.user.id, token);
  if (balance < total) {
    return replyInsufficientBalance(interaction);
  }

  if (!(await subtractBalance(interaction.user.id, total, token))) {
    return replyInsufficientBalance(interaction);
  }

  await interaction.deferReply();

  const { data: inserted } = await supabase
    .from("drops")
    .insert({
      channel_id: interaction.channelId!,
      creator_id: interaction.user.id,
      total_sats: total,
      per_claim_sats: perClaim,
      max_claims: maxClaims,
      eligible_role_id: role?.id ?? null,
      token,
    })
    .select("id")
    .single();

  if (!inserted) {
    return interaction.editReply({ content: "❌ Failed to create drop." });
  }

  const dropId = inserted.id;

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

  const embed = buildDropEmbed(drop, []);
  const row = buildClaimButton(dropId);

  const reply = await interaction.editReply({
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  });

  await supabase
    .from("drops")
    .update({ message_id: reply.id })
    .eq("id", dropId);
}
