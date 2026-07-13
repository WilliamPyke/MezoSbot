import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type TextChannel } from "discord.js";
import { subtractBalance, addBalance, getBalance } from "../balance.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats, roundSats } from "../format.js";
import { sendTransferReceivedDm } from "../notifications.js";
import { getRainBannedTerms, messageMatchesAnyRainTerm, messageMatchesRainBan, normalizeRainBannedTerm } from "../rainBans.js";
import { supabase } from "../db.js";
import { updateUserBadges } from "../badges.js";
import { recordLedgerEntry } from "../ledger.js";
import { replyInsufficientBalance } from "./responses.js";
import { getSatsMultiplier } from "../multi.js";
import { TOKEN_CHOICES, floorTokenAmount, formatTokenAmount, parseToken, roundTokenAmount, tokenLabel } from "../tokens.js";


export const data = {
  name: "rain",
  description: "Rain a token on recently active users in this channel",
  options: [
    { name: "amount", type: 10 as const, description: "Total token amount to rain", required: true, minValue: 0.000001 },
    { name: "count", type: 4 as const, description: "Number of users to rain on", required: true, minValue: 1, maxValue: 50 },
    { name: "token", type: 3 as const, description: "Token to rain", required: false, choices: TOKEN_CHOICES },
    { name: "role", type: 8 as const, description: "Only rain on users with this role", required: false },
    { name: "message", type: 3 as const, description: "Optional message for recipients", required: false },
    { name: "words", type: 3 as const, description: "Only count messages containing these words/phrases", required: false },
  ],
};

function parseWordFilter(input: string | null): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  for (const raw of input.split(/[\n,]+/)) {
    const term = normalizeRainBannedTerm(raw);
    if (term) seen.add(term);
  }
  return [...seen].slice(0, 25);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ Rain only works in servers.", flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.channel;
  if (!channel || !("messages" in channel)) {
    return interaction.reply({ content: "❌ Rain only works in text channels.", flags: MessageFlags.Ephemeral });
  }

  const totalAmount = interaction.options.getNumber("amount", true);
  const token = parseToken(interaction.options.getString("token"));
  const balance = await getBalance(interaction.user.id, token);
  if (balance < totalAmount) {
    return replyInsufficientBalance(interaction);
  }

  const count = interaction.options.getInteger("count", true);
  const role = interaction.options.getRole("role");
  const rawMessage = interaction.options.getString("message");
  const trimmedMessage = rawMessage?.trim() ?? "";
  const customMessage = trimmedMessage.length > 0 ? trimmedMessage : undefined;
  const rawWords = interaction.options.getString("words");
  const wordFilter = parseWordFilter(rawWords);

  if (customMessage && customMessage.length > 200) {
    return interaction.reply({ content: "❌ Message must be 200 characters or fewer.", flags: MessageFlags.Ephemeral });
  }

  if ((rawWords?.trim().length ?? 0) > 0 && wordFilter.length === 0) {
    return interaction.reply({ content: "❌ Add at least one word or phrase to use the word filter.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  // Fetch recent messages, sort newest-first, pick the last N unique users
  let fetched;
  try {
    fetched = await (channel as TextChannel).messages.fetch({ limit: 100 });
  } catch {
    return interaction.editReply({ content: "❌ I need **Read Message History** permission in this channel to find active users." });
  }
  const sorted = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  let bannedTerms: Awaited<ReturnType<typeof getRainBannedTerms>> = [];
  try {
    bannedTerms = await getRainBannedTerms(interaction.guild.id);
  } catch (err) {
    console.warn("[Rain] Failed to load banned terms:", (err as Error)?.message ?? err);
  }
  const bannedUserIds = new Set<string>();
  if (bannedTerms.length > 0) {
    for (const msg of sorted) {
      if (msg.author.bot || msg.author.id === interaction.user.id) continue;
      if (messageMatchesRainBan(msg.content, bannedTerms)) {
        bannedUserIds.add(msg.author.id);
      }
    }
  }

  const activeUserIds: string[] = [];
  const recipientRoleIds = new Map<string, string[]>();
  const seen = new Set<string>();

  for (const msg of sorted) {
    if (msg.author.bot || msg.author.id === interaction.user.id || seen.has(msg.author.id) || bannedUserIds.has(msg.author.id)) continue;
    if (wordFilter.length > 0 && !messageMatchesAnyRainTerm(msg.content, wordFilter)) continue;

    seen.add(msg.author.id);

    const member = await interaction.guild.members.fetch(msg.author.id).catch(() => null);
    const roleIds = member ? [...member.roles.cache.keys()] : [];
    if (role && (!member || !member.roles.cache.has(role.id))) continue;

    activeUserIds.push(msg.author.id);
    recipientRoleIds.set(msg.author.id, roleIds);
    if (activeUserIds.length >= count) break;
  }

  if (activeUserIds.length === 0) {
    if (role) {
      return interaction.editReply({ content: `❌ No recently active users found in this channel with the **${role.name}** role.` });
    }
    return interaction.editReply({ content: "❌ No recently active users found in this channel." });
  }

  const recipientPayouts = activeUserIds.map((uid) => ({
    uid,
    multiplier: getSatsMultiplier(recipientRoleIds.get(uid)),
    amount: 0,
  }));
  const totalWeight = recipientPayouts.reduce((sum, recipient) => sum + recipient.multiplier, 0);
  const perUnit = floorTokenAmount(totalAmount / totalWeight, token);
  if (perUnit <= 0) {
    return interaction.editReply({ content: "❌ Amount too small to split." });
  }

  let totalNeeded = 0;
  for (const recipient of recipientPayouts) {
    recipient.amount = roundTokenAmount(perUnit * recipient.multiplier, token);
    totalNeeded = roundTokenAmount(totalNeeded + recipient.amount, token);
  }

  if (!(await subtractBalance(interaction.user.id, totalNeeded, token))) {
    return replyInsufficientBalance(interaction);
  }

  // Parallelize balance additions, address registrations, and recipient DMs.
  await Promise.all(
    recipientPayouts.map(async (recipient) => {
      await addBalance(recipient.uid, recipient.amount, token);
      await registerDepositAddress(recipient.uid).catch(() => {});
      await sendTransferReceivedDm({
        client: interaction.client,
        recipientId: recipient.uid,
        senderId: interaction.user.id,
        amountSats: recipient.amount,
        token,
        kind: "rain",
        customMessage,
      });
    })
  );

  const { data: rainRow } = await supabase.from("rains").insert({
    sender_id: interaction.user.id,
    amount_sats: totalNeeded,
    recipient_count: activeUserIds.length,
    token,
  }).select("id").single();

  recordLedgerEntry(interaction.client, {
    type: "rain",
    amountSats: totalNeeded,
    token,
    senderId: interaction.user.id,
    receiverId: null,
    guildId: interaction.guildId,
    referenceType: "rains",
    referenceId: rainRow?.id != null ? String(rainRow.id) : null,
    metadata: { recipient_count: activeUserIds.length, per_unit_sats: perUnit, multi_recipient_count: recipientPayouts.filter((recipient) => recipient.multiplier === 2).length },
  });

  // Update rainer badge roles in Discord
  if (interaction.guildId) {
    updateUserBadges(interaction.client, interaction.guildId, interaction.user.id).catch((err) => {
      console.error("[Badges] Error updating rainer badges:", err);
    });
  }


  const recipients = activeUserIds.map((id) => `<@${id}>`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`🌧️ It's Raining ${tokenLabel(token)}!`)
    .setDescription(`<@${interaction.user.id}> made it rain!`)
    .addFields(
      { name: "Base Share", value: `**${formatTokenAmount(perUnit, token)}**`, inline: true },
      { name: "Total", value: `**${formatTokenAmount(totalNeeded, token)}**`, inline: true },
      { name: "Recipients", value: `**${activeUserIds.length}**`, inline: true },
      { name: "Rained On", value: recipients, inline: false },
    )
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
