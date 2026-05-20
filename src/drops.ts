/**
 * Shared drop logic: claim processing & message building.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type TextChannel,
} from "discord.js";
import { supabase } from "./db.js";
import { addBalance } from "./balance.js";
import { registerDepositAddress } from "./evm.js";
import { recordLedgerEntry } from "./ledger.js";
import { formatSats } from "./format.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface Drop {
  id: number;
  channel_id: string;
  creator_id: string;
  message_id: string | null;
  eligible_role_id: string | null;
  total_sats: number;
  per_claim_sats: number;
  max_claims: number;
  claims_count: number;
  status: string;
}

export interface ClaimResult {
  ok: boolean;
  error?: string;
  /** Updated claims count after this claim */
  newCount?: number;
  /** Number of claims remaining */
  remaining?: number;
  /** Whether the drop is now fully claimed */
  completed?: boolean;
  /** Claimed amount in sats */
  amountSats?: number;
  /** Drop creator (sender) */
  creatorId?: string;
}

/* ------------------------------------------------------------------ */
/*  Build the drop embed + button                                     */
/* ------------------------------------------------------------------ */

export function buildDropEmbed(drop: Drop, claimedBy: string[]): EmbedBuilder {
  const remaining = drop.max_claims - drop.claims_count;
  const completed = drop.status === "completed";

  const embed = new EmbedBuilder()
    .setColor(completed ? 0x95a5a6 : 0xf0b232)
    .setTitle("🎁 Sats Drop!")
    .setDescription(`<@${drop.creator_id}> dropped **${formatSats(drop.total_sats)}**!`)
    .addFields(
      { name: "Per Claim", value: `**${formatSats(drop.per_claim_sats)}**`, inline: true },
      { name: "Claimed", value: `**${drop.claims_count}/${drop.max_claims}**`, inline: true },
      { name: "Remaining", value: completed ? "✅ All claimed!" : `**${remaining}**`, inline: true },
    )
    .setTimestamp();

  if (drop.eligible_role_id) {
    embed.addFields({ name: "Eligible Role", value: `<@&${drop.eligible_role_id}>`, inline: true });
  }

  if (claimedBy.length > 0) {
    embed.addFields({
      name: "Claimed By",
      value: claimedBy.map((id) => `<@${id}>`).join(", "),
    });
  }

  if (completed) {
    embed.setFooter({ text: "This drop has ended" });
  }

  return embed;
}

export function buildClaimButton(dropId: number, disabled = false) {
  const button = new ButtonBuilder()
    .setCustomId(`claim_drop_${dropId}`)
    .setLabel("🎁 Claim")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/* ------------------------------------------------------------------ */
/*  Fetch claimants for a drop                                        */
/* ------------------------------------------------------------------ */

export async function getClaimants(dropId: number): Promise<string[]> {
  const { data } = await supabase
    .from("drop_claims")
    .select("claimant_id")
    .eq("drop_id", dropId)
    .order("claimed_at", { ascending: true });
  return (data ?? []).map((r) => r.claimant_id);
}

/* ------------------------------------------------------------------ */
/*  Process a claim (shared by button handler and /claim command)      */
/* ------------------------------------------------------------------ */

export async function processClaim(
  dropId: number,
  claimantId: string,
  claimantRoleIds: string[] = [],
  client: Client | null = null,
  guildId: string | null = null,
): Promise<ClaimResult> {
  // Re-fetch the drop to get latest state
  const { data: drop } = await supabase
    .from("drops")
    .select("*")
    .eq("id", dropId)
    .single();

  if (!drop || drop.status !== "active" || drop.claims_count >= drop.max_claims) {
    return { ok: false, error: "This drop is no longer active." };
  }

  if (drop.creator_id === claimantId) {
    return { ok: false, error: "You can't claim your own drop." };
  }

  const eligibleRoleId = drop.eligible_role_id as string | null | undefined;
  if (eligibleRoleId && !claimantRoleIds.includes(eligibleRoleId)) {
    return { ok: false, error: `Only members with <@&${eligibleRoleId}> can claim this drop.` };
  }

  // Check if already claimed
  const { data: existing } = await supabase
    .from("drop_claims")
    .select("id")
    .eq("drop_id", dropId)
    .eq("claimant_id", claimantId)
    .single();

  if (existing) {
    return { ok: false, error: "You've already claimed from this drop." };
  }

  // Insert claim
  const { error: claimError } = await supabase.from("drop_claims").insert({
    drop_id: dropId,
    claimant_id: claimantId,
    amount_sats: drop.per_claim_sats,
  });

  if (claimError) {
    return { ok: false, error: "You've already claimed from this drop." };
  }

  // Log the drop claim as rain in the database
  const { error: rainError } = await supabase
    .from("rains")
    .insert({
      sender_id: drop.creator_id,
      amount_sats: drop.per_claim_sats,
      recipient_count: 1,
    });

  if (rainError) {
    console.error("[Drops] Failed to log drop claim to rains table:", rainError.message);
  }

  // Update drop state
  const newCount = drop.claims_count + 1;
  const completed = newCount >= drop.max_claims;
  const newStatus = completed ? "completed" : "active";
  await supabase
    .from("drops")
    .update({ claims_count: newCount, status: newStatus })
    .eq("id", dropId);

  // Credit the claimant
  await addBalance(claimantId, drop.per_claim_sats);
  await registerDepositAddress(claimantId);

  recordLedgerEntry(client, {
    type: "drop_claim",
    amountSats: drop.per_claim_sats,
    senderId: drop.creator_id,
    receiverId: claimantId,
    guildId,
    referenceType: "drop_claims",
    referenceId: String(dropId),
  });

  return {
    ok: true,
    newCount,
    remaining: drop.max_claims - newCount,
    completed,
    amountSats: drop.per_claim_sats,
    creatorId: drop.creator_id,
  };
}

/* ------------------------------------------------------------------ */
/*  Update the original drop message in the channel                   */
/* ------------------------------------------------------------------ */

export async function updateDropMessage(
  client: Client,
  drop: Drop,
): Promise<void> {
  if (!drop.message_id || !drop.channel_id) return;

  try {
    const channel = await client.channels.fetch(drop.channel_id);
    if (!channel || !("messages" in channel)) return;

    const msg = await (channel as TextChannel).messages.fetch(drop.message_id);
    if (!msg) return;

    const claimedBy = await getClaimants(drop.id);

    // Rebuild drop object with latest count
    const { data: freshDrop } = await supabase
      .from("drops")
      .select("*")
      .eq("id", drop.id)
      .single();

    if (!freshDrop) return;

    const embed = buildDropEmbed(freshDrop as Drop, claimedBy);
    const row = buildClaimButton(drop.id, freshDrop.status === "completed");

    await msg.edit({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(
      `Failed to update drop message ${drop.message_id}:`,
      (err as Error)?.message ?? err,
    );
  }
}
