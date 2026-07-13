import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config, tokenUnitsToSats } from "../config.js";
import {
  getNativeBalance,
  sweepToTreasury,
  fundGasAndSweep,
  registerDepositAddress,
} from "../evm.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";

export const data = {
  name: "sweep",
  description: "Admin: sweep deposit wallets to treasury",
  default_member_permissions: "0",
  options: [
    {
      name: "user",
      type: 6 as const,
      description: "Specific user to sweep (omit for all registered wallets)",
      required: false,
    },
    {
      name: "fund_gas",
      type: 5 as const,
      description: "Fund gas from treasury if deposit wallet can't cover it (default: true)",
      required: false,
    },
  ],
};

type Row = { discord_id: string; address: string };

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!config.discord.adminIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ Admin only.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser("user");
  const shouldFundGas = interaction.options.getBoolean("fund_gas") ?? true;

  let rows: Row[];
  if (target) {
    const addr = await registerDepositAddress(target.id);
    rows = [{ discord_id: target.id, address: addr }];
  } else {
    const { data } = await supabase
      .from("deposit_addresses")
      .select("discord_id, address");
    rows = (data ?? []) as Row[];
  }

  let swept = 0;
  let failed = 0;
  let skipped = 0;
  let totalSats = 0;
  const details: string[] = [];

  for (const row of rows) {
    try {
      const bal = await getNativeBalance(row.address);
      if (bal === 0n) {
        skipped++;
        continue;
      }

      const balSats = tokenUnitsToSats(bal);

      let hash = await sweepToTreasury(row.discord_id);

      if (!hash && shouldFundGas) {
        hash = await fundGasAndSweep(row.discord_id);
      }

      if (hash) {
        swept++;
        totalSats += balSats;
        details.push(
          `✅ <@${row.discord_id}> — ~${formatSats(balSats)} → [tx](${config.evm.explorerUrl}/tx/${hash})`
        );
      } else {
        failed++;
        details.push(
          `❌ <@${row.discord_id}> — ${formatSats(balSats)} — could not sweep`
        );
      }
    } catch (err) {
      failed++;
      const msg = (err as Error)?.message ?? String(err);
      details.push(
        `❌ <@${row.discord_id}> — error: ${msg.slice(0, 100)}`
      );
    }
  }

  const embed = new EmbedBuilder()
    .setColor(swept > 0 ? 0x00cc6a : 0x95a5a6)
    .setTitle("🧹 Sweep Complete")
    .addFields(
      { name: "Swept", value: `**${swept}** wallet(s)`, inline: true },
      { name: "Total", value: `~${formatSats(totalSats)}`, inline: true },
      { name: "Failed", value: `**${failed}**`, inline: true },
      { name: "Skipped (empty)", value: `**${skipped}**`, inline: true },
    );

  if (details.length > 0) {
    const detailStr = details.join("\n").slice(0, 1024);
    embed.addFields({ name: "Details", value: detailStr });
  }

  embed.setTimestamp();

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
