"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const balance_js_1 = require("../balance.js");
const evm_js_1 = require("../evm.js");
const format_js_1 = require("../format.js");
const notifications_js_1 = require("../notifications.js");
const rainBans_js_1 = require("../rainBans.js");
exports.data = {
    name: "rain",
    description: "Rain sats on recently active users in this channel",
    options: [
        { name: "amount", type: 10, description: "Total sats to rain", required: true, minValue: 0.000001 },
        { name: "count", type: 4, description: "Number of users to rain on", required: true, minValue: 1, maxValue: 50 },
        { name: "role", type: 8, description: "Only rain on users with this role", required: false },
        { name: "message", type: 3, description: "Optional message for recipients", required: false },
        { name: "words", type: 3, description: "Only count messages containing these words/phrases", required: false },
    ],
};
function parseWordFilter(input) {
    if (!input)
        return [];
    const seen = new Set();
    for (const raw of input.split(/[\n,]+/)) {
        const term = (0, rainBans_js_1.normalizeRainBannedTerm)(raw);
        if (term)
            seen.add(term);
    }
    return [...seen].slice(0, 25);
}
async function execute(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: "❌ Rain only works in servers.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    const channel = interaction.channel;
    if (!channel || !("messages" in channel)) {
        return interaction.reply({ content: "❌ Rain only works in text channels.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    const totalAmount = interaction.options.getNumber("amount", true);
    await interaction.deferReply();
    const balance = await (0, balance_js_1.getBalance)(interaction.user.id);
    if (balance < totalAmount) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    const count = interaction.options.getInteger("count", true);
    const role = interaction.options.getRole("role");
    const rawMessage = interaction.options.getString("message");
    const trimmedMessage = rawMessage?.trim() ?? "";
    const customMessage = trimmedMessage.length > 0 ? trimmedMessage : undefined;
    const rawWords = interaction.options.getString("words");
    const wordFilter = parseWordFilter(rawWords);
    if (customMessage && customMessage.length > 200) {
        return interaction.editReply({ content: "❌ Message must be 200 characters or fewer." });
    }
    if ((rawWords?.trim().length ?? 0) > 0 && wordFilter.length === 0) {
        return interaction.editReply({ content: "❌ Add at least one word or phrase to use the word filter." });
    }
    // Fetch recent messages, sort newest-first, pick the last N unique users
    let fetched;
    try {
        fetched = await channel.messages.fetch({ limit: 100 });
    }
    catch {
        return interaction.editReply({ content: "❌ I need **Read Message History** permission in this channel to find active users." });
    }
    const sorted = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    let bannedTerms = [];
    try {
        bannedTerms = await (0, rainBans_js_1.getRainBannedTerms)(interaction.guild.id);
    }
    catch (err) {
        console.warn("[Rain] Failed to load banned terms:", err?.message ?? err);
    }
    const bannedUserIds = new Set();
    if (bannedTerms.length > 0) {
        for (const msg of sorted) {
            if (msg.author.bot || msg.author.id === interaction.user.id)
                continue;
            if ((0, rainBans_js_1.messageMatchesRainBan)(msg.content, bannedTerms)) {
                bannedUserIds.add(msg.author.id);
            }
        }
    }
    const activeUserIds = [];
    const seen = new Set();
    for (const msg of sorted) {
        if (msg.author.bot || msg.author.id === interaction.user.id || seen.has(msg.author.id) || bannedUserIds.has(msg.author.id))
            continue;
        if (wordFilter.length > 0 && !(0, rainBans_js_1.messageMatchesAnyRainTerm)(msg.content, wordFilter))
            continue;
        seen.add(msg.author.id);
        if (role) {
            const member = await interaction.guild.members.fetch(msg.author.id).catch(() => null);
            if (!member || !member.roles.cache.has(role.id)) {
                continue;
            }
        }
        activeUserIds.push(msg.author.id);
        if (activeUserIds.length >= count)
            break;
    }
    if (activeUserIds.length === 0) {
        if (role) {
            return interaction.editReply({ content: `❌ No recently active users found in this channel with the **${role.name}** role.` });
        }
        return interaction.editReply({ content: "❌ No recently active users found in this channel." });
    }
    const perUser = (0, format_js_1.roundSats)(totalAmount / activeUserIds.length);
    if (perUser <= 0) {
        return interaction.editReply({ content: "❌ Amount too small to split." });
    }
    const totalNeeded = (0, format_js_1.roundSats)(perUser * activeUserIds.length);
    if (!(await (0, balance_js_1.subtractBalance)(interaction.user.id, totalNeeded))) {
        return interaction.editReply({ content: "❌ Insufficient balance." });
    }
    // Parallelize balance additions, address registrations, and recipient DMs.
    await Promise.all(activeUserIds.map(async (uid) => {
        await (0, balance_js_1.addBalance)(uid, perUser);
        await (0, evm_js_1.registerDepositAddress)(uid).catch(() => { });
        await (0, notifications_js_1.sendTransferReceivedDm)({
            client: interaction.client,
            recipientId: uid,
            senderId: interaction.user.id,
            amountSats: perUser,
            kind: "rain",
            customMessage,
        });
    }));
    const recipients = activeUserIds.map((id) => `<@${id}>`).join("\n");
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x3498db)
        .setTitle("🌧️ It's Raining Sats!")
        .setDescription(`<@${interaction.user.id}> made it rain!`)
        .addFields({ name: "Per User", value: `**${(0, format_js_1.formatSats)(perUser)}**`, inline: true }, { name: "Total", value: `**${(0, format_js_1.formatSats)(totalNeeded)}**`, inline: true }, { name: "Recipients", value: `**${activeUserIds.length}**`, inline: true }, { name: "Rained On", value: recipients, inline: false })
        .setTimestamp();
    if (role) {
        embed.addFields({ name: "Eligible Role", value: `<@&${role.id}>`, inline: true });
    }
    if (wordFilter.length > 0) {
        embed.addFields({ name: "Matched Words", value: wordFilter.map((term) => `\`${term.replace(/`/g, "'")}\``).join(", "), inline: true });
    }
    if (customMessage) {
        embed.addFields({ name: "Message", value: customMessage });
    }
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
