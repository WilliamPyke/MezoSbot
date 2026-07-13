"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const db_js_1 = require("../db.js");
const balance_js_1 = require("../balance.js");
const drops_js_1 = require("../drops.js");
const ledger_js_1 = require("../ledger.js");
const responses_js_1 = require("./responses.js");
const tokens_js_1 = require("../tokens.js");
exports.data = {
    name: "drop",
    description: "Create a token drop",
    options: [
        { name: "total", type: 10, description: "Total token amount to drop", required: true, minValue: 0.000001 },
        { name: "per_claim", type: 10, description: "Token amount per claim", required: true, minValue: 0.000001 },
        { name: "max_claims", type: 4, description: "Max number of claims", required: true, minValue: 1 },
        { name: "token", type: 3, description: "Token to drop", required: false, choices: tokens_js_1.TOKEN_CHOICES },
        { name: "role", type: 8, description: "Only members with this role can claim", required: false },
    ],
};
async function execute(interaction) {
    const token = (0, tokens_js_1.parseToken)(interaction.options.getString("token"));
    const total = (0, tokens_js_1.roundTokenAmount)(interaction.options.getNumber("total", true), token);
    const perClaim = (0, tokens_js_1.roundTokenAmount)(interaction.options.getNumber("per_claim", true), token);
    const maxClaims = interaction.options.getInteger("max_claims", true);
    const role = interaction.options.getRole("role");
    if (perClaim * maxClaims > total) {
        return interaction.reply({
            content: "❌ `per_claim` × `max_claims` cannot exceed `total`.",
            flags: discord_js_1.MessageFlags.Ephemeral,
        });
    }
    const balance = await (0, balance_js_1.getBalance)(interaction.user.id, token);
    if (balance < total) {
        return (0, responses_js_1.replyInsufficientBalance)(interaction);
    }
    if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, total, token))) {
        return (0, responses_js_1.replyInsufficientBalance)(interaction);
    }
    await interaction.deferReply();
    const { data: inserted } = await db_js_1.supabase
        .from("drops")
        .insert({
        channel_id: interaction.channelId,
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
    (0, ledger_js_1.recordLedgerEntry)(interaction.client, {
        type: "drop_create",
        amountSats: total,
        token,
        senderId: interaction.user.id,
        receiverId: null,
        guildId: interaction.guildId,
        referenceType: "drops",
        referenceId: String(dropId),
    });
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
        token,
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
