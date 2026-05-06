import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config, tokenUnitsToSats } from "../config.js";
import {
  getProvider,
  getUserDepositAddress,
  registerDepositAddress,
  sweepToTreasury,
} from "../evm.js";
import { addBalance } from "../balance.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";

export const data = {
  name: "backfill",
  description: "Admin: manually check and credit a user's uncredited deposit",
  default_member_permissions: "0",
  options: [
    { name: "user", type: 6 as const, description: "User to check", required: true },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!config.discord.adminIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ Admin only.", flags: MessageFlags.Ephemeral });
  }

  const target = interaction.options.getUser("user", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await registerDepositAddress(target.id);

  const address = getUserDepositAddress(target.id);
  const provider = getProvider();

  try {
    const bal = await provider.getBalance(address);
    if (bal === 0n) {
      const embed = new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle("🔍 Backfill Check")
        .addFields(
          { name: "User", value: `<@${target.id}>`, inline: true },
          { name: "Address", value: `\`${address.slice(0, 12)}...\``, inline: true },
          { name: "Result", value: "No funds found at deposit address." },
        );
      return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    const { data: row } = await supabase
      .from("deposit_addresses")
      .select("last_checked_balance")
      .eq("discord_id", target.id)
      .single();

    const alreadyTracked = BigInt(row?.last_checked_balance || "0");

    if (bal <= alreadyTracked) {
      const embed = new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle("🔍 Backfill Check")
        .addFields(
          { name: "User", value: `<@${target.id}>`, inline: true },
          { name: "On-Chain", value: `**${formatSats(tokenUnitsToSats(bal))}**`, inline: true },
          { name: "Already Tracked", value: `**${formatSats(tokenUnitsToSats(alreadyTracked))}**`, inline: true },
          { name: "Result", value: "Nothing to backfill. Use `/sweep` to move funds or `/credit` for manual adjustments." },
        );
      return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    const diff = bal - alreadyTracked;
    const diffSats = tokenUnitsToSats(diff);
    const txId = `backfill-${Date.now()}-${target.id}`;

    await supabase.from("deposits").insert({
      discord_id: target.id,
      tx_hash: txId,
      amount_sats: diffSats,
      block_number: 0,
    });

    await addBalance(target.id, diffSats);

    await supabase
      .from("deposit_addresses")
      .update({ last_checked_balance: bal.toString() })
      .eq("discord_id", target.id);

    sweepToTreasury(target.id).catch(() => {});

    const embed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle("✅ Backfill Complete")
      .addFields(
        { name: "User", value: `<@${target.id}>`, inline: true },
        { name: "Credited", value: `**${formatSats(diffSats)}**`, inline: true },
      )
      .setFooter({ text: "Sweep to treasury attempted" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    await interaction.editReply({
      content: `❌ Could not check the deposit address: ${(err as Error)?.message ?? err}`,
    });
  }
}
