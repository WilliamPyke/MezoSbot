import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { withdraw } from "../evm.js";
import { subtractBalance, addBalance, getWalletForUser } from "../balance.js";
import { supabase } from "../db.js";
import { config } from "../config.js";
import { formatSats } from "../format.js";

const MIN_WITHDRAWAL_SATS = parseFloat(process.env.MIN_WITHDRAWAL_SATS ?? "50");

export const data = {
  name: "withdraw",
  description: "Withdraw sats to an EVM address",
  options: [
    { name: "amount", type: 10 as const, description: "Amount in sats", required: true, minValue: 0.000001 },
    { name: "address", type: 3 as const, description: "Destination address (0x...) — defaults to linked wallet", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const amount = interaction.options.getNumber("amount", true);
  const addressOpt = interaction.options.getString("address");

  if (addressOpt && !/^0x[a-fA-F0-9]{40}$/i.test(addressOpt)) {
    return interaction.reply({ content: "❌ Invalid address.", flags: MessageFlags.Ephemeral });
  }

  if (!config.evm.skipWithdrawalMin && amount < MIN_WITHDRAWAL_SATS) {
    return interaction.reply({ content: `❌ Minimum withdrawal is **${MIN_WITHDRAWAL_SATS.toLocaleString()} sats**.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const address = addressOpt || (await getWalletForUser(interaction.user.id));
  if (!address) {
    return interaction.editReply({
      content: "❌ No address provided and no linked wallet. Either provide an address or `/link` one first.",
    });
  }

  // 1. Block concurrent withdrawals (only consider pending records < 10 min old)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: pending } = await supabase
    .from("withdrawals")
    .select("id")
    .eq("discord_id", interaction.user.id)
    .eq("status", "pending")
    .gte("created_at", tenMinutesAgo)
    .limit(1)
    .single();

  if (pending) {
    return interaction.editReply({
      content: "⏳ You already have a withdrawal in progress. Please wait for it to complete.",
    });
  }

  // 2. Deduct balance atomically
  if (!(await subtractBalance(interaction.user.id, amount))) {
    return interaction.editReply({ content: "❌ Insufficient balance." });
  }

  // 2. Insert withdrawal as PENDING
  const { data: row } = await supabase.from("withdrawals").insert({
    discord_id: interaction.user.id,
    amount_sats: amount,
    to_address: address.toLowerCase(),
    status: "pending",
  }).select("id").single();

  const withdrawalId = row?.id;

  // 3. Send the transaction and wait for receipt
  const result = await withdraw(address, amount);

  // 4. Handle failure — refund balance + mark failed
  if (result.error && !result.confirmed) {
    await addBalance(interaction.user.id, amount);

    if (withdrawalId) {
      await supabase.from("withdrawals").update({
        status: "failed",
        tx_hash: result.txHash ?? null,
      }).eq("id", withdrawalId);
    }

    const failMsg = { content: `❌ Withdrawal failed: ${result.error}` };
    try {
      return await interaction.editReply(failMsg);
    } catch {
      // Interaction expired (e.g. bot restarted mid-poll) — fall back to DM
      interaction.user.send(failMsg).catch(() => {});
      return;
    }
  }

  // 5. Transaction confirmed on-chain — mark completed
  if (withdrawalId) {
    await supabase.from("withdrawals").update({
      status: "completed",
      tx_hash: result.txHash ?? null,
    }).eq("id", withdrawalId);
  }

  const explorer = config.evm.explorerUrl;

  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("✅ Withdrawal Confirmed")
    .addFields(
      { name: "Amount", value: `**${formatSats(amount)}**`, inline: true },
      { name: "To", value: `\`${address.slice(0, 10)}...${address.slice(-8)}\``, inline: true },
    );

  if (result.gasSats) {
    embed.addFields(
      { name: "Network Fee", value: `~${formatSats(result.gasSats)}`, inline: true },
      { name: "Received", value: `~${formatSats(result.sentSats!)}`, inline: true },
    );
  }

  if (result.txHash) {
    embed.addFields({ name: "Transaction", value: `[View on Explorer](${explorer}/tx/${result.txHash})` });
  }

  embed.setTimestamp();

  try {
    await interaction.editReply({ embeds: [embed] });
  } catch {
    // Interaction expired (e.g. bot restarted mid-poll) — fall back to DM
    interaction.user.send({ embeds: [embed] }).catch(() => {});
  }
}
