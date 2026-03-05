import { EmbedBuilder, type ChatInputCommandInteraction, type TextChannel } from "discord.js";
import { subtractBalance, addBalance, getBalance } from "../balance.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats, roundSats } from "../format.js";

export const data = {
  name: "rain",
  description: "Rain sats on recently active users in this channel",
  options: [
    { name: "amount", type: 10 as const, description: "Total sats to rain", required: true, minValue: 0.000001 },
    { name: "count", type: 4 as const, description: "Number of users to rain on", required: true, minValue: 1, maxValue: 50 },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ Rain only works in servers.", ephemeral: true });
  }

  const channel = interaction.channel;
  if (!channel || !("messages" in channel)) {
    return interaction.reply({ content: "❌ Rain only works in text channels.", ephemeral: true });
  }

  const totalAmount = interaction.options.getNumber("amount", true);

  const balance = await getBalance(interaction.user.id);
  if (balance < totalAmount) {
    return interaction.reply({ content: "❌ Insufficient balance.", ephemeral: true });
  }

  await interaction.deferReply();
  const count = interaction.options.getInteger("count", true);

  // Fetch recent messages, sort newest-first, pick the last N unique users
  let fetched;
  try {
    fetched = await (channel as TextChannel).messages.fetch({ limit: 100 });
  } catch {
    return interaction.editReply({ content: "❌ I need **Read Message History** permission in this channel to find active users." });
  }
  const sorted = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  const activeUserIds: string[] = [];
  const seen = new Set<string>();

  for (const msg of sorted) {
    if (!msg.author.bot && msg.author.id !== interaction.user.id && !seen.has(msg.author.id)) {
      seen.add(msg.author.id);
      activeUserIds.push(msg.author.id);
    }
    if (activeUserIds.length >= count) break;
  }

  if (activeUserIds.length === 0) {
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

  for (const uid of activeUserIds) {
    await addBalance(uid, perUser);
    await registerDepositAddress(uid);
  }

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

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
