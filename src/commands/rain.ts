import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type TextChannel } from "discord.js";
import { subtractBalance, addBalance, getBalance } from "../balance.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats, roundSats } from "../format.js";
import { sendTransferReceivedDm } from "../notifications.js";
import { getRainBannedTerms, messageMatchesRainBan } from "../rainBans.js";

export const data = {
  name: "rain",
  description: "Rain sats on recently active users in this channel",
  options: [
    { name: "amount", type: 10 as const, description: "Total sats to rain", required: true, minValue: 0.000001 },
    { name: "count", type: 4 as const, description: "Number of users to rain on", required: true, minValue: 1, maxValue: 50 },
    { name: "role", type: 8 as const, description: "Only rain on users with this role", required: false },
    { name: "message", type: 3 as const, description: "Optional message for recipients", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ Rain only works in servers.", flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.channel;
  if (!channel || !("messages" in channel)) {
    return interaction.reply({ content: "❌ Rain only works in text channels.", flags: MessageFlags.Ephemeral });
  }

  const totalAmount = interaction.options.getNumber("amount", true);
  await interaction.deferReply();

  const balance = await getBalance(interaction.user.id);
  if (balance < totalAmount) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  const count = interaction.options.getInteger("count", true);
  const role = interaction.options.getRole("role");
  const rawMessage = interaction.options.getString("message");
  const trimmedMessage = rawMessage?.trim() ?? "";
  const customMessage = trimmedMessage.length > 0 ? trimmedMessage : undefined;

  if (customMessage && customMessage.length > 200) {
    return interaction.editReply({ content: "❌ Message must be 200 characters or fewer." });
  }

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
  const seen = new Set<string>();

  for (const msg of sorted) {
    if (msg.author.bot || msg.author.id === interaction.user.id || seen.has(msg.author.id) || bannedUserIds.has(msg.author.id)) continue;

    seen.add(msg.author.id);

    if (role) {
      const member = await interaction.guild.members.fetch(msg.author.id).catch(() => null);
      if (!member || !member.roles.cache.has(role.id)) {
        continue;
      }
    }

    activeUserIds.push(msg.author.id);
    if (activeUserIds.length >= count) break;
  }

  if (activeUserIds.length === 0) {
    if (role) {
      return interaction.editReply({ content: `❌ No recently active users found in this channel with the **${role.name}** role.` });
    }
    return interaction.editReply({ content: "❌ No recently active users found in this channel." });
  }

  const perUser = roundSats(totalAmount / activeUserIds.length);
  if (perUser <= 0) {
    return interaction.editReply({ content: "❌ Amount too small to split." });
  }

  const totalNeeded = roundSats(perUser * activeUserIds.length);

  if (!(await subtractBalance(interaction.user.id, totalNeeded))) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  // Parallelize balance additions, address registrations, and recipient DMs.
  await Promise.all(
    activeUserIds.map(async (uid) => {
      await addBalance(uid, perUser);
      await registerDepositAddress(uid).catch(() => {});
      await sendTransferReceivedDm({
        client: interaction.client,
        recipientId: uid,
        senderId: interaction.user.id,
        amountSats: perUser,
        kind: "rain",
        customMessage,
      });
    })
  );

  const recipients = activeUserIds.map((id) => `<@${id}>`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("🌧️ It's Raining Sats!")
    .setDescription(`<@${interaction.user.id}> made it rain!`)
    .addFields(
      { name: "Per User", value: `**${formatSats(perUser)}**`, inline: true },
      { name: "Total", value: `**${formatSats(totalNeeded)}**`, inline: true },
      { name: "Recipients", value: `**${activeUserIds.length}** users`, inline: true },
      { name: "Rained On", value: recipients },
    )
    .setTimestamp();

  if (role) {
    embed.addFields({ name: "Eligible Role", value: `<@&${role.id}>`, inline: true });
  }
  if (customMessage) {
    embed.addFields({ name: "Message", value: customMessage });
  }

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
