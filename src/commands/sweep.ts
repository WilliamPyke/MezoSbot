import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config, tokenUnitsToSats } from "../config.js";
import {
  fundGasAndSweep,
  treasurySignerAvailable,
  getNativeBalance,
  getTokenBalance,
  getUserDepositAddress,
  registerDepositAddress,
  sweepDepositTokenToTreasury,
  sweepToTreasury,
} from "../evm.js";
import { supabase } from "../db.js";
import { sweepForwarderNow } from "../custody/deposits.js";
import { getCustodyMode, isCustodyFrozen } from "../custody/state.js";
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
  const v2 = getCustodyMode() === "v2";
  if (!v2 && !treasurySignerAvailable()) {
    return interaction.reply({ content: "⏸️ Deposit sweeps are disabled while custody is paused.", flags: MessageFlags.Ephemeral });
  }
  if (v2 && isCustodyFrozen()) {
    return interaction.reply({ content: "🧊 Custody is frozen: sweeps are blocked until `/custody unfreeze`.", flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = interaction.options.getUser("user");
  const shouldFundGas = interaction.options.getBoolean("fund_gas") ?? true;
  const requested = interaction.options.getString("token") ?? "ALL";
  const tokens: TokenSymbol[] = requested === "ALL"
    ? ["SATS", "MUSD", "MEZO", "MUSDC"]
    : [parseToken(requested)];

  if (v2) return sweepForwarders(interaction, target?.id ?? null, tokens);

  // Legacy (v1) sweeps only touch rows that still hold this key's v1 address:
  // never a retired (NULL) address or a v2 forwarder.
  let rows: Row[];
  if (target) {
    const address = await registerDepositAddress(target.id);
    rows = address ? [{ discord_id: target.id, address }] : [];
  } else {
    const { data: addresses, error } = await supabase
      .from("deposit_addresses")
      .select("discord_id, address")
      .not("address", "is", null);
    if (error) throw error;
    rows = ((addresses ?? []) as Row[]).filter(
      (row) => row.address.toLowerCase() === getUserDepositAddress(row.discord_id).toLowerCase(),
    );
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

/**
 * Custody v2: ask the factory to sweep forwarders to the vault now, whatever
 * their size. Balances are credited by the Swept-event scanner, not here.
 */
async function sweepForwarders(
  interaction: ChatInputCommandInteraction,
  discordId: string | null,
  tokens: TokenSymbol[],
) {
  let ids: string[];
  if (discordId) {
    ids = [discordId];
  } else {
    const { data, error } = await supabase
      .from("deposit_addresses")
      .select("discord_id")
      .eq("address_version", 2)
      .eq("deposits_enabled", true);
    if (error) throw error;
    ids = (data ?? []).map((row) => String(row.discord_id));
  }

  let sent = 0;
  let failed = 0;
  const details: string[] = [];
  for (const id of ids) {
    try {
      for (const result of await sweepForwarderNow(id, tokens)) {
        const amount = formatTokenAmount(result.amount, result.token);
        if (result.txHash) {
          sent++;
          details.push(`✅ <@${id}> — ${amount} → [tx](${config.evm.explorerUrl}/tx/${result.txHash})`);
        } else if (result.error) {
          failed++;
          details.push(`❌ <@${id}> — ${result.token}: ${result.error.slice(0, 120)}`);
        } else {
          details.push(`⏳ <@${id}> — ${amount}: a sweep is already in flight`);
        }
      }
    } catch (err) {
      failed++;
      details.push(`❌ <@${id}>: ${((err as Error)?.message ?? String(err)).slice(0, 120)}`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(sent > 0 ? 0x00cc6a : 0x95a5a6)
    .setTitle("🧹 Forwarder Sweeps Sent")
    .setDescription("Funds move to the vault; balances are credited once each Swept event is confirmed.")
    .addFields(
      { name: "Sent", value: `**${sent}**`, inline: true },
      { name: "Failed", value: `**${failed}**`, inline: true },
      { name: "Checked", value: `**${ids.length}** address(es)`, inline: true },
    )
    .setTimestamp();
  if (details.length) embed.addFields({ name: "Details", value: details.join("\n").slice(0, 1024) });
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
