import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { subtractBalance, addBalance, getBalance } from "../balance.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats, roundSats } from "../format.js";
import { sendTransferReceivedDm } from "../notifications.js";
import { recordLedgerEntry } from "../ledger.js";
import { replyInsufficientBalance } from "./responses.js";
import { TOKEN_CHOICES, formatTokenAmount, parseToken, roundTokenAmount, tokenLabel } from "../tokens.js";

export const data = {
  name: "distribute",
  description: "Split a token among multiple users",
  options: [
    { name: "amount", type: 10 as const, description: "Total token amount to distribute", required: true, minValue: 0.000001 },
    { name: "users", type: 3 as const, description: "Space-separated user mentions (@user1 @user2)", required: true },
    { name: "token", type: 3 as const, description: "Token to distribute", required: false, choices: TOKEN_CHOICES },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const totalAmount = interaction.options.getNumber("amount", true);
  const usersStr = interaction.options.getString("users", true);
  const token = parseToken(interaction.options.getString("token"));

  const mentions = usersStr.match(/<@!?(\d+)>/g) ?? [];
  const userIds = [...new Set(mentions.map((m) => m.replace(/<@!?(\d+)>/, "$1")))];
  const validUsers = userIds.filter((id) => id !== interaction.user.id);

  if (validUsers.length === 0) {
    return interaction.reply({
      content: "❌ Include at least one valid user mention, e.g. `@user1 @user2`",
      flags: MessageFlags.Ephemeral,
    });
  }

  const perUser = roundTokenAmount(totalAmount / validUsers.length, token);
  if (perUser < 0.000001) {
    return interaction.reply({
      content: "❌ Amount per user must be at least 0.000001 sats.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const totalNeeded = roundTokenAmount(perUser * validUsers.length, token);

  const balance = await getBalance(interaction.user.id, token);
  if (balance < totalNeeded) {
    return replyInsufficientBalance(interaction);
  }

  if (!(await subtractBalance(interaction.user.id, totalNeeded, token))) {
    return replyInsufficientBalance(interaction);
  }

  await interaction.deferReply();

  // Parallelize balance additions, address registrations, and recipient DMs.
  await Promise.all(
    validUsers.map(async (uid) => {
      await addBalance(uid, perUser, token);
      await registerDepositAddress(uid).catch(() => {});
      await sendTransferReceivedDm({
        client: interaction.client,
        recipientId: uid,
        senderId: interaction.user.id,
        amountSats: perUser,
        token,
        kind: "distribute",
      });
    })
  );

  recordLedgerEntry(interaction.client, {
    type: "distribute",
    amountSats: totalNeeded,
    token,
    senderId: interaction.user.id,
    receiverId: null,
    guildId: interaction.guildId,
    metadata: { recipient_count: validUsers.length, per_user_sats: perUser, recipient_ids: validUsers },
  });

  const recipients = validUsers.map((id) => `<@${id}>`).join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`📤 ${tokenLabel(token)} Distributed!`)
    .setDescription(`<@${interaction.user.id}> split ${tokenLabel(token)} across ${validUsers.length} user${validUsers.length === 1 ? "" : "s"}.`)
    .addFields(
      { name: "Per User", value: `**${formatTokenAmount(perUser, token)}**`, inline: true },
      { name: "Total", value: `**${formatTokenAmount(totalNeeded, token)}**`, inline: true },
      { name: "Recipients", value: recipients },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
