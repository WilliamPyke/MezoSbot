"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDropEmbed = buildDropEmbed;
exports.buildClaimButton = buildClaimButton;
exports.getClaimants = getClaimants;
exports.processClaim = processClaim;
exports.updateDropMessage = updateDropMessage;
/**
 * Shared drop logic: claim processing & message building.
 */
const discord_js_1 = require("discord.js");
const db_js_1 = require("./db.js");
const evm_js_1 = require("./evm.js");
const ledger_js_1 = require("./ledger.js");
const multi_js_1 = require("./multi.js");
const tokens_js_1 = require("./tokens.js");
/* ------------------------------------------------------------------ */
/*  Build the drop embed + button                                     */
/* ------------------------------------------------------------------ */
function buildDropEmbed(drop, claimedBy) {
    const remaining = drop.max_claims - drop.claims_count;
    const completed = drop.status === "completed";
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(completed ? 0x95a5a6 : 0xf0b232)
        .setTitle(`🎁 ${drop.token ?? "SATS"} Drop!`)
        .setDescription(`<@${drop.creator_id}> dropped **${(0, tokens_js_1.formatTokenAmount)(drop.total_sats, drop.token ?? "SATS")}**!`)
        .addFields({ name: "Per Claim", value: `**${(0, tokens_js_1.formatTokenAmount)(drop.per_claim_sats, drop.token ?? "SATS")}**`, inline: true }, { name: "Claimed", value: `**${drop.claims_count}/${drop.max_claims}**`, inline: true }, { name: "Remaining", value: completed ? "✅ All claimed!" : `**${remaining}**`, inline: true })
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
function buildClaimButton(dropId, disabled = false) {
    const button = new discord_js_1.ButtonBuilder()
        .setCustomId(`claim_drop_${dropId}`)
        .setLabel("🎁 Claim")
        .setStyle(discord_js_1.ButtonStyle.Success)
        .setDisabled(disabled);
    return new discord_js_1.ActionRowBuilder().addComponents(button);
}
/* ------------------------------------------------------------------ */
/*  Fetch claimants for a drop                                        */
/* ------------------------------------------------------------------ */
async function getClaimants(dropId) {
    const { data } = await db_js_1.supabase
        .from("drop_claims")
        .select("claimant_id")
        .eq("drop_id", dropId)
        .order("claimed_at", { ascending: true });
    return (data ?? []).map((r) => r.claimant_id);
}
/* ------------------------------------------------------------------ */
/*  Process a claim (shared by button handler and /claim command)      */
/* ------------------------------------------------------------------ */
async function processClaim(dropId, claimantId, claimantRoleIds = [], client = null, guildId = null) {
    const { data: dropRow, error: dropError } = await db_js_1.supabase
        .from("drops")
        .select("creator_id, token")
        .eq("id", dropId)
        .maybeSingle();
    if (dropError || !dropRow?.creator_id) {
        if (dropError)
            console.error("[Drops] Failed to load drop creator:", dropError.message);
        return { ok: false, error: "This drop could not be claimed. Please try again." };
    }
    const requestedMultiplier = (0, multi_js_1.getSatsMultiplier)(claimantRoleIds);
    const creatorAllowsMulti = await (0, multi_js_1.getMultiDropEnabled)(dropRow.creator_id);
    const token = (0, tokens_js_1.parseToken)(dropRow.token);
    const { data, error } = await db_js_1.supabase.rpc("claim_drop_atomic", {
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
    const result = (data ?? {});
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
    await (0, evm_js_1.registerDepositAddress)(claimantId).catch((err) => {
        console.warn(`[Drops] Failed to register deposit address for claimant ${claimantId}:`, err?.message ?? err);
    });
    (0, ledger_js_1.recordLedgerEntry)(client, {
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
async function updateDropMessage(client, drop) {
    if (!drop.message_id || !drop.channel_id)
        return;
    try {
        const channel = await client.channels.fetch(drop.channel_id);
        if (!channel || !("messages" in channel))
            return;
        const msg = await channel.messages.fetch(drop.message_id);
        if (!msg)
            return;
        const claimedBy = await getClaimants(drop.id);
        // Rebuild drop object with latest count
        const { data: freshDrop } = await db_js_1.supabase
            .from("drops")
            .select("*")
            .eq("id", drop.id)
            .single();
        if (!freshDrop)
            return;
        const embed = buildDropEmbed(freshDrop, claimedBy);
        const row = buildClaimButton(drop.id, freshDrop.status === "completed");
        await msg.edit({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    }
    catch (err) {
        console.error(`Failed to update drop message ${drop.message_id}:`, err?.message ?? err);
    }
}
