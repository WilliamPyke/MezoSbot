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
import { registerDepositAddress } from "./evm.js";
import { recordLedgerEntry } from "./ledger.js";
import { formatSats } from "./format.js";
import { getMultiDropEnabled, getSatsMultiplier } from "./multi.js";
import { formatTokenAmount, parseToken, type TokenSymbol } from "./tokens.js";

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
  token: TokenSymbol;
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
  /** Inserted drop_claims row id */
  claimId?: number;
  token?: TokenSymbol;
}

type AtomicClaimRpcResult = {
  ok?: boolean;
  reason?: string;
  newCount?: number;
  new_count?: number;
  remaining?: number;
  completed?: boolean;
  amountSats?: number;
  amount_sats?: number;
  creatorId?: string;
  creator_id?: string;
  claimId?: number;
  claim_id?: number;
  claimUnits?: number;
  claim_units?: number;
  eligibleRoleId?: string;
  eligible_role_id?: string;
};

/* ------------------------------------------------------------------ */
/*  Build the drop embed + button                                     */
/* ------------------------------------------------------------------ */

export function buildDropEmbed(drop: Drop, claimedBy: string[]): EmbedBuilder {
  const remaining = drop.max_claims - drop.claims_count;
  const completed = drop.status === "completed";

  const embed = new EmbedBuilder()
    .setColor(completed ? 0x95a5a6 : 0xf0b232)
    .setTitle(`🎁 ${drop.token ?? "SATS"} Drop!`)
    .setDescription(`<@${drop.creator_id}> dropped **${formatTokenAmount(drop.total_sats, drop.token ?? "SATS")}**!`)
    .addFields(
      { name: "Per Claim", value: `**${formatTokenAmount(drop.per_claim_sats, drop.token ?? "SATS")}**`, inline: true },
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
  const { data: dropRow, error: dropError } = await supabase
    .from("drops")
    .select("creator_id, token")
    .eq("id", dropId)
    .maybeSingle();

  if (dropError || !dropRow?.creator_id) {
    if (dropError) console.error("[Drops] Failed to load drop creator:", dropError.message);
    return { ok: false, error: "This drop could not be claimed. Please try again." };
  }

  const requestedMultiplier = getSatsMultiplier(claimantRoleIds);
  const creatorAllowsMulti = await getMultiDropEnabled(dropRow.creator_id as string);
  const token = parseToken(dropRow.token);

  const { data, error } = await supabase.rpc("claim_drop_atomic", {
    p_drop_id: dropId,
    p_claimant_id: claimantId,
    p_claimant_role_ids: claimantRoleIds,
    p_claimant_multiplier: requestedMultiplier,
    p_creator_allows_multi: creatorAllowsMulti,
  });

  if (error) {
    console.error("[Drops] claim_drop_atomic failed:", error.message);
    return { ok: false, error: "This drop could not be claimed. Please try again." };
  }

  const result = (data ?? {}) as AtomicClaimRpcResult;
  if (!result.ok) {
    const eligibleRoleId = result.eligibleRoleId ?? result.eligible_role_id;
    switch (result.reason) {
      case "already_claimed":
        return { ok: false, error: "You've already claimed from this drop." };
      case "own_drop":
        return { ok: false, error: "You can't claim your own drop." };
      case "insufficient_remaining":
        return { ok: false, error: "There aren't enough claims left for a 2x claim." };
      case "ineligible_role":
        return {
          ok: false,
          error: eligibleRoleId
            ? `Only members with <@&${eligibleRoleId}> can claim this drop.`
            : "You're not eligible to claim this drop.",
        };
      default:
        return { ok: false, error: "This drop is no longer active." };
    }
  }

  const newCount = result.newCount ?? result.new_count ?? 0;
  const amountSats = result.amountSats ?? result.amount_sats ?? 0;
  const creatorId = result.creatorId ?? result.creator_id;
  const claimId = result.claimId ?? result.claim_id;
  const remaining = result.remaining ?? 0;
  const completed = result.completed === true;

  if (!creatorId || amountSats <= 0) {
    console.error("[Drops] claim_drop_atomic returned an incomplete success payload:", result);
    return { ok: false, error: "This drop could not be claimed. Please try again." };
  }

  await registerDepositAddress(claimantId).catch((err) => {
    console.warn(
      `[Drops] Failed to register deposit address for claimant ${claimantId}:`,
      (err as Error)?.message ?? err,
    );
  });

  recordLedgerEntry(client, {
    type: "drop_claim",
    amountSats,
    token,
    senderId: creatorId,
    receiverId: claimantId,
    guildId,
    referenceType: "drop_claims",
    referenceId: claimId ? String(claimId) : String(dropId),
  });

  return {
    ok: true,
    newCount,
    remaining,
    completed,
    amountSats,
    creatorId,
    claimId,
    token,
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
