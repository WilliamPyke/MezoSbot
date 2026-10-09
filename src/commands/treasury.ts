import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { ethers } from "ethers";
import { getNativeBalance, getSatsBackingSnapshot } from "../evm.js";
import { getHoldingsBreakdown, noBackingReason, type HoldingBalances } from "../custody/holdings.js";
import { readPayoutStates, type PayoutTokenState } from "../custody/payout.js";
import { getCustodyMode, getCustodyReasons, getFreezeState, getV2Settings } from "../custody/state.js";
import { formatSats } from "../format.js";
import { formatTokenAmount, tokenLabel, tokenUnitsToAmount, TOKEN_SYMBOLS, type TokenSymbol } from "../tokens.js";
import { config, tokenUnitsToSats } from "../config.js";

export const data = {
  name: "treasury",
  description: "View the bot's treasury balance",
};

const MODE_LABELS = {
  v2: "**v2**: cold vault + capped HotPayout float",
  legacy: "**legacy**: treasury hot wallet",
  paused: "**paused**: on-chain deposits and withdrawals are off",
} as const;

function link(address: string): string {
  const checksummed = ethers.getAddress(address);
  return `[\`${checksummed.slice(0, 10)}...${checksummed.slice(-8)}\`](${config.evm.explorerUrl}/address/${checksummed})`;
}

function units(amount: bigint, token: TokenSymbol): string {
  return formatTokenAmount(tokenUnitsToAmount(amount, token), token);
}

function accountField(account: HoldingBalances): { name: string; value: string; inline: boolean } {
  const label = account.label === "vault" ? "Vault" : account.label === "payout" ? "HotPayout float" : "Treasury";
  const balances = TOKEN_SYMBOLS.map((token) => `**${tokenLabel(token)}:** ${units(account.balances[token], token)}`);
  return { name: label, value: [link(account.address), ...balances].join("\n"), inline: true };
}

function payoutLine(state: PayoutTokenState): string {
  if (!state.allowed || state.dailyCap === 0n) return `**${tokenLabel(state.token)}:** not enabled`;
  return `**${tokenLabel(state.token)}:** ${units(state.remainingDaily, state.token)} of ${units(state.dailyCap, state.token)} ` +
    `left today · max ${units(state.perTxCap, state.token)} per withdrawal`;
}

/** Custody overview shared by /treasury and /custody status. Details (reasons, gas wallets) are admin-only. */
export async function buildCustodyEmbed(details: boolean): Promise<EmbedBuilder> {
  const mode = getCustodyMode();
  const v2 = mode === "v2" ? getV2Settings() : null;
  const frozen = getFreezeState();
  const [holdings, backing, payout] = await Promise.all([
    getHoldingsBreakdown(),
    getSatsBackingSnapshot(),
    v2 ? readPayoutStates(v2).catch(() => null) : Promise.resolve(null),
  ]);
  const liabilities = backing.userLiabilities + backing.poolLiabilities;
  const shortfall = Math.max(0, liabilities + backing.reserveSats - backing.treasurySats);
  const underbacked = shortfall > 0;

  const status: string[] = [MODE_LABELS[mode]];
  const noBacking = noBackingReason();
  if (noBacking) status.push(noBacking);
  if (frozen) status.push(`🧊 **Frozen** since ${frozen.at || "an earlier run"}: withdrawals and sweeps are blocked.`);
  if (details) {
    for (const reason of getCustodyReasons()) status.push(`• ${reason}`);
    if (frozen) status.push(`Freeze reason: ${frozen.reason}`);
  }

  const embed = new EmbedBuilder()
    .setColor(mode !== "paused" && !frozen && !underbacked ? 0xf0b232 : 0xff4444)
    .setTitle("🏦 Treasury")
    .addFields({ name: "Custody", value: status.join("\n").slice(0, 1024) });

  for (const account of holdings) embed.addFields(accountField(account));

  if (v2) {
    embed.addFields({
      name: `HotPayout limits${payout?.[0]?.paused ? " (⏸️ paused on-chain)" : ""}`,
      value: payout ? payout.map(payoutLine).join("\n").slice(0, 1024) : "Unavailable",
    });
    if (details) {
      const wallets = [
        { label: "Payout operator", address: v2.operator },
        { label: "Sweep gas", address: v2.sweepGas },
        ...(v2.guardian ? [{ label: "Guardian", address: v2.guardian }] : []),
      ];
      const lines = await Promise.all(wallets.map(async (wallet) => {
        const sats = await getNativeBalance(wallet.address).then(tokenUnitsToSats).catch(() => null);
        const low = sats != null && sats < config.custody.lowGasSats ? " ⚠️ low" : "";
        return `**${wallet.label}:** ${sats == null ? "Unavailable" : formatSats(sats)}${low} · ${link(wallet.address)}`;
      }));
      embed.addFields({ name: "Gas wallets", value: lines.join("\n").slice(0, 1024) });
    }
  }

  embed.addFields({
    name: "SATS backing",
    value: [
      `On-chain: **${formatSats(backing.treasurySats)}**`,
      `Owed to users: **${formatSats(liabilities)}** (balances + funds in flight)`,
      underbacked
        ? `Shortfall: **${formatSats(shortfall)}** (includes ${formatSats(backing.reserveSats)} gas reserve)`
        : `Excess: **${formatSats(backing.excessSats)}** · reserve ${formatSats(backing.reserveSats)}`,
    ].join("\n"),
  });
  return embed.setTimestamp();
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const embed = await buildCustodyEmbed(config.discord.adminIds.includes(interaction.user.id));
    await interaction.editReply({ embeds: [embed] });
  } catch {
    await interaction.editReply({ content: "❌ Could not fetch treasury balance." });
  }
}
