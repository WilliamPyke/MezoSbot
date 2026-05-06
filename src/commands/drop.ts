import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { supabase } from "../db.js";
import { subtractBalance, getBalance } from "../balance.js";
import { roundSats } from "../format.js";
import { buildDropEmbed, buildClaimButton, type Drop } from "../drops.js";

export const data = {
  name: "drop",
  description: "Create a sats drop - first users to claim get sats",
  options: [
    { name: "total", type: 10 as const, description: "Total sats to drop (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
    { name: "per_claim", type: 10 as const, description: "Sats per claim (e.g. 10 or 10.5)", required: true, minValue: 0.000001 },
    { name: "max_claims", type: 4 as const, description: "Max number of claims", required: true, minValue: 1 },
    { name: "role", type: 8 as const, description: "Only members with this role can claim", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const total = roundSats(interaction.options.getNumber("total", true));
  const perClaim = roundSats(interaction.options.getNumber("per_claim", true));
  const maxClaims = interaction.options.getInteger("max_claims", true);
  const role = interaction.options.getRole("role");

  if (perClaim * maxClaims > total) {
    return interaction.reply({
      content: "❌ `per_claim` × `max_claims` cannot exceed `total`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();

  const balance = await getBalance(interaction.user.id);
  if (balance < total) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  if (!(await subtractBalance(interaction.user.id, total))) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  const { data: inserted } = await supabase
    .from("drops")
    .insert({
      channel_id: interaction.channelId!,
      creator_id: interaction.user.id,
      total_sats: total,
      per_claim_sats: perClaim,
      max_claims: maxClaims,
      eligible_role_id: role?.id ?? null,
    })
    .select("id")
    .single();

  if (!inserted) {
    return interaction.editReply({ content: "❌ Failed to create drop." });
  }

  const dropId = inserted.id;

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
