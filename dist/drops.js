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
const balance_js_1 = require("./balance.js");
const evm_js_1 = require("./evm.js");
const format_js_1 = require("./format.js");
/* ------------------------------------------------------------------ */
/*  Build the drop embed + button                                     */
/* ------------------------------------------------------------------ */
function buildDropEmbed(drop, claimedBy) {
    const remaining = drop.max_claims - drop.claims_count;
    const completed = drop.status === "completed";
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(completed ? 0x95a5a6 : 0xf0b232)
        .setTitle("🎁 Sats Drop!")
        .setDescription(`<@${drop.creator_id}> dropped **${(0, format_js_1.formatSats)(drop.total_sats)}**!`)
        .addFields({ name: "Per Claim", value: `**${(0, format_js_1.formatSats)(drop.per_claim_sats)}**`, inline: true }, { name: "Claimed", value: `**${drop.claims_count}/${drop.max_claims}**`, inline: true }, { name: "Remaining", value: completed ? "✅ All claimed!" : `**${remaining}**`, inline: true })
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
async function processClaim(dropId, claimantId, claimantRoleIds = []) {
    // Re-fetch the drop to get latest state
    const { data: drop } = await db_js_1.supabase
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
    const eligibleRoleId = drop.eligible_role_id;
    if (eligibleRoleId && !claimantRoleIds.includes(eligibleRoleId)) {
        return { ok: false, error: `Only members with <@&${eligibleRoleId}> can claim this drop.` };
    }
    // Check if already claimed
    const { data: existing } = await db_js_1.supabase
        .from("drop_claims")
        .select("id")
        .eq("drop_id", dropId)
        .eq("claimant_id", claimantId)
        .single();
    if (existing) {
        return { ok: false, error: "You've already claimed from this drop." };
    }
    // Insert claim
    const { error: claimError } = await db_js_1.supabase.from("drop_claims").insert({
        drop_id: dropId,
        claimant_id: claimantId,
        amount_sats: drop.per_claim_sats,
    });
    if (claimError) {
        return { ok: false, error: "You've already claimed from this drop." };
    }
    // Log the drop claim as rain in the database
    const { error: rainError } = await db_js_1.supabase
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
    await db_js_1.supabase
        .from("drops")
        .update({ claims_count: newCount, status: newStatus })
        .eq("id", dropId);
    // Credit the claimant
    await (0, balance_js_1.addBalance)(claimantId, drop.per_claim_sats);
    await (0, evm_js_1.registerDepositAddress)(claimantId);
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
