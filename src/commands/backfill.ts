import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config, tokenUnitsToSats } from "../config.js";
import { getNativeBalance, getUserDepositAddress } from "../evm.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";

export const data = {
  name: "backfill",
  description: "Admin: inspect a user's deposit address against the credited checkpoint",
  default_member_permissions: "0",
  options: [
    { name: "user", type: 6 as const, description: "User to check", required: true },
  ],
};

/**
 * Read-only. This command used to mint `balance − last_checked_balance`
 * directly, outside the atomic credit_native_deposit path: it ignored sweep
 * markers, wallet-verification deposits and gas, and raced the poller (a
 * double-credit path). The deposit poller is the only crediting path; this
 * shows what it sees so an admin can tell whether anything is uncredited.
 */
export async function execute(interaction: ChatInputCommandInteraction) {
  if (!config.discord.adminIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ Admin only.", flags: MessageFlags.Ephemeral });
  }

  const target = interaction.options.getUser("user", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const address = getUserDepositAddress(target.id);

  try {
    const [bal, { data: row, error }] = await Promise.all([
      getNativeBalance(address),
      supabase
        .from("deposit_addresses")
        .select("last_checked_balance, deposits_enabled, native_sweep_tx_hash, native_sweep_started_at")
        .eq("discord_id", target.id)
        .maybeSingle(),
    ]);
    if (error) throw error;

    const tracked = BigInt(row?.last_checked_balance || "0");
    let result: string;
    if (!row) {
      result = "No deposit address is registered for this user, so nothing is polled or credited.";
    } else if (!row.deposits_enabled) {
      result = "Deposits are not enabled for this address; the poller does not credit it.";
    } else if (row.native_sweep_tx_hash) {
      result = `A sweep (\`${String(row.native_sweep_tx_hash).slice(0, 12)}...\`) is in flight; the poller reconciles it before crediting again.`;
    } else if (bal > tracked) {
      result = "On-chain balance is above the checkpoint; the deposit poller will credit the difference (net of sweep gas) on its next pass.";
    } else {
      result = "Nothing uncredited. Use `/sweep` to move funds or `/credit` for manual adjustments.";
    }

    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle("🔍 Deposit Check")
      .addFields(
        { name: "User", value: `<@${target.id}>`, inline: true },
        { name: "Address", value: `\`${address.slice(0, 12)}...\``, inline: true },
        { name: "On-Chain", value: `**${formatSats(tokenUnitsToSats(bal))}**`, inline: true },
        { name: "Credited Checkpoint", value: `**${formatSats(tokenUnitsToSats(tracked))}**`, inline: true },
        { name: "Result", value: result },
      )
      .setFooter({ text: "Read-only: deposits are credited only by the atomic deposit poller" })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    await interaction.editReply({
      content: `❌ Could not check the deposit address: ${(err as Error)?.message ?? err}`,
    });
  }
}
