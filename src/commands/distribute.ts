import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { subtractBalance, addBalance, getBalance } from "../balance.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats, roundSats } from "../format.js";
import { sendTransferReceivedDm } from "../notifications.js";

export const data = {
  name: "distribute",
  description: "Split sats among multiple users",
  options: [
    { name: "amount", type: 10 as const, description: "Total sats to distribute (e.g. 100 or 100.5)", required: true, minValue: 0.000001 },
    { name: "users", type: 3 as const, description: "Space-separated user mentions (@user1 @user2)", required: true },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const totalAmount = interaction.options.getNumber("amount", true);
  const usersStr = interaction.options.getString("users", true);

  const mentions = usersStr.match(/<@!?(\d+)>/g) ?? [];
  const userIds = [...new Set(mentions.map((m) => m.replace(/<@!?(\d+)>/, "$1")))];
  const validUsers = userIds.filter((id) => id !== interaction.user.id);

  if (validUsers.length === 0) {
    return interaction.reply({
      content: "❌ Include at least one valid user mention, e.g. `@user1 @user2`",
      flags: MessageFlags.Ephemeral,
    });
  }

  const perUser = roundSats(totalAmount / validUsers.length);
  if (perUser < 0.000001) {
    return interaction.reply({
      content: "❌ Amount per user must be at least 0.000001 sats.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const totalNeeded = roundSats(perUser * validUsers.length);
  await interaction.deferReply();

  const balance = await getBalance(interaction.user.id);
  if (balance < totalNeeded) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  if (!(await subtractBalance(interaction.user.id, totalNeeded))) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  // Parallelize balance additions, address registrations, and recipient DMs.
  await Promise.all(
    validUsers.map(async (uid) => {
      await addBalance(uid, perUser);
      await registerDepositAddress(uid).catch(() => {});
      await sendTransferReceivedDm({
        client: interaction.client,
        recipientId: uid,
        senderId: interaction.user.id,
        amountSats: perUser,
        kind: "distribute",
      });
    })
  );

  const recipients = validUsers.map((id) => `<@${id}>`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("📤 Sats Distributed!")
    .setDescription(`<@${interaction.user.id}> split sats across ${validUsers.length} user${validUsers.length === 1 ? "" : "s"}.`)
    .addFields(
      { name: "Per User", value: `**${formatSats(perUser)}**`, inline: true },
      { name: "Total", value: `**${formatSats(totalNeeded)}**`, inline: true },
      { name: "Recipients", value: recipients },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
