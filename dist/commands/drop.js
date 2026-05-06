"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const db_js_1 = require("../db.js");
const balance_js_1 = require("../balance.js");
const format_js_1 = require("../format.js");
const drops_js_1 = require("../drops.js");
exports.data = {
    name: "drop",
    description: "Create a sats drop - first users to claim get sats",
    options: [
        { name: "total", type: 10, description: "Total sats to drop (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
        { name: "per_claim", type: 10, description: "Sats per claim (e.g. 10 or 10.5)", required: true, minValue: 0.000001 },
        { name: "max_claims", type: 4, description: "Max number of claims", required: true, minValue: 1 },
        { name: "role", type: 8, description: "Only members with this role can claim", required: false },
    ],
};
async function execute(interaction) {
    const total = (0, format_js_1.roundSats)(interaction.options.getNumber("total", true));
    const perClaim = (0, format_js_1.roundSats)(interaction.options.getNumber("per_claim", true));
    const maxClaims = interaction.options.getInteger("max_claims", true);
    const role = interaction.options.getRole("role");
    if (perClaim * maxClaims > total) {
        return interaction.reply({
            content: "❌ `per_claim` × `max_claims` cannot exceed `total`.",
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    await interaction.deferReply();
    const balance = await (0, balance_js_1.getBalance)(interaction.user.id);
    if (balance < total) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, total))) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    const { data: inserted } = await db_js_1.supabase
        .from("drops")
        .insert({
        channel_id: interaction.channelId,
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
    const drop = {
        id: dropId,
        channel_id: interaction.channelId,
        creator_id: interaction.user.id,
        message_id: null,
        eligible_role_id: role?.id ?? null,
        total_sats: total,
        per_claim_sats: perClaim,
        max_claims: maxClaims,
        claims_count: 0,
        status: "active",
    };
    const embed = (0, drops_js_1.buildDropEmbed)(drop, []);
    const row = (0, drops_js_1.buildClaimButton)(dropId);
    const reply = await interaction.editReply({
        embeds: [embed],
        components: [row],
        allowedMentions: { parse: [] },
    });
    await db_js_1.supabase
        .from("drops")
        .update({ message_id: reply.id })
        .eq("id", dropId);
}
