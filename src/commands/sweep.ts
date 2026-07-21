import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config, tokenUnitsToSats } from "../config.js";
import {
  fundGasAndSweep,
  getNativeBalance,
  getTokenBalance,
  registerDepositAddress,
  sweepDepositTokenToTreasury,
  sweepToTreasury,
} from "../evm.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";
import {
  formatTokenAmount,
  parseToken,
  tokenUnitsToAmount,
  TOKEN_CHOICES,
  type TokenSymbol,
} from "../tokens.js";

export const data = {
  name: "sweep",
  description: "Admin: sweep deposit wallets to treasury",
  options: [
    { name: "user", type: 6 as const, description: "Specific user (omit for all wallets)", required: false },
    {
      name: "token", type: 3 as const, description: "Asset to sweep (default: all)", required: false,
      choices: [{ name: "All", value: "ALL" }, ...TOKEN_CHOICES],
    },
    { name: "fund_gas", type: 5 as const, description: "Sponsor gas if needed (default: true)", required: false },
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
  const requested = interaction.options.getString("token") ?? "ALL";
  const tokens: TokenSymbol[] = requested === "ALL"
    ? ["SATS", "MUSD", "MEZO", "MUSDC"]
    : [parseToken(requested)];

  let rows: Row[];
  if (target) {
    rows = [{ discord_id: target.id, address: await registerDepositAddress(target.id) }];
  } else {
    const { data: addresses, error } = await supabase.from("deposit_addresses").select("discord_id, address");
    if (error) throw error;
    rows = (addresses ?? []) as Row[];
  }

  let swept = 0;
  let failed = 0;
  let skipped = 0;
  const totals = new Map<TokenSymbol, number>();
  const details: string[] = [];

  for (const row of rows) {
    for (const token of tokens) {
      try {
        if (token === "SATS") {
          const balance = await getNativeBalance(row.address);
          if (balance === 0n) { skipped++; continue; }
          const amount = tokenUnitsToSats(balance);
          let hash = await sweepToTreasury(row.discord_id);
          if (!hash && shouldFundGas) hash = await fundGasAndSweep(row.discord_id);
          if (!hash) throw new Error("native balance cannot cover its sweep transaction");
          swept++;
          totals.set(token, (totals.get(token) ?? 0) + amount);
          details.push(`✅ <@${row.discord_id}> — ~${formatSats(amount)} → [tx](${config.evm.explorerUrl}/tx/${hash})`);
          continue;
        }

        const balance = await getTokenBalance(row.address, token);
        if (balance === 0n) { skipped++; continue; }
        const result = await sweepDepositTokenToTreasury(row.discord_id, token, shouldFundGas);
        if (!result.txHash) throw new Error(`${token} could not be swept`);
        const amount = tokenUnitsToAmount(result.amountAtomic, token);
        swept++;
        totals.set(token, (totals.get(token) ?? 0) + amount);
        details.push(`✅ <@${row.discord_id}> — ${formatTokenAmount(amount, token)} → [tx](${config.evm.explorerUrl}/tx/${result.txHash})`);
      } catch (err) {
        failed++;
        const message = ((err as Error)?.message ?? String(err)).slice(0, 120);
        details.push(`❌ <@${row.discord_id}> — ${token}: ${message}`);
      }
    }
  }

  const totalText = totals.size
    ? Array.from(totals, ([token, amount]) => formatTokenAmount(amount, token)).join("\n")
    : "None";
  const embed = new EmbedBuilder()
    .setColor(swept > 0 ? 0x00cc6a : 0x95a5a6)
    .setTitle("🧹 Sweep Complete")
    .addFields(
      { name: "Swept", value: `**${swept}** asset balance(s)`, inline: true },
      { name: "Total", value: totalText, inline: true },
      { name: "Failed", value: `**${failed}**`, inline: true },
      { name: "Skipped (empty)", value: `**${skipped}**`, inline: true },
    )
    .setTimestamp();
  if (details.length) embed.addFields({ name: "Details", value: details.join("\n").slice(0, 1024) });
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
