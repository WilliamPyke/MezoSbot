import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import {
  executeWithdrawal,
  finalizeWithdrawal,
  preflightWithdrawal,
  quoteErc20WithdrawalGas,
  reserveWithdrawal,
  type Erc20WithdrawalGasQuote,
  type WithdrawalPreflight,
} from "../evm.js";
import { getWalletForUser } from "../balance.js";
import { settledState } from "../depositPolicy.js";
import { supabase } from "../db.js";
import { config } from "../config.js";
import { recordLedgerEntry } from "../ledger.js";
import { formatSats } from "../format.js";
import { TOKEN_CHOICES, formatTokenAmount, parseToken, roundTokenAmount } from "../tokens.js";

const MIN_WITHDRAWAL_SATS = parseFloat(process.env.MIN_WITHDRAWAL_SATS ?? "50");

export const data = {
  name: "withdraw",
  description: "Withdraw a token to an EVM address",
  options: [
    { name: "amount", type: 10 as const, description: "Token amount", required: true, minValue: 0.000001 },
    { name: "address", type: 3 as const, description: "Destination address (0x...) — defaults to linked wallet", required: false },
    { name: "token", type: 3 as const, description: "Token to withdraw", required: false, choices: TOKEN_CHOICES },
  ],
};

/** Maintenance reply shared by every command that sends user funds on-chain. */
export function withdrawalsPausedMessage(): string {
  return (
    "🛠️ **Withdrawals are temporarily disabled.**\n" +
    `MezoSBOT is currently undergoing account upgrades. Estimated completion: **${config.withdrawals.eta}**.\n` +
    "Your balance is safe — please try again after the upgrade is complete."
  );
}

/** User-facing text for a failed pre-debit check. Nothing has been debited at this point. */
export function withdrawalPreflightMessage(preflight: Exclude<WithdrawalPreflight, { ok: true }>): string {
  if (preflight.code === "underbacked") {
    return (
      "⚠️ **SATS withdrawals are paused** while the treasury's on-chain backing is topped up.\n" +
      "Your balance is safe and has not been debited — please try again later."
    );
  }
  if (preflight.code === "backing_unavailable") {
    return "⚠️ Could not verify treasury backing right now. Nothing was debited — please try again shortly.";
  }
  return `❌ ${preflight.error}`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!config.withdrawals.enabled) {
    return interaction.reply({ content: withdrawalsPausedMessage(), flags: MessageFlags.Ephemeral });
  }

  const addressOpt = interaction.options.getString("address");
  const token = parseToken(interaction.options.getString("token"));
  const amount = roundTokenAmount(interaction.options.getNumber("amount", true), token);

  if (addressOpt && !/^0x[a-fA-F0-9]{40}$/i.test(addressOpt)) {
    return interaction.reply({ content: "❌ Invalid address.", flags: MessageFlags.Ephemeral });
  }

  if (token === "SATS" && !config.evm.skipWithdrawalMin && amount < MIN_WITHDRAWAL_SATS) {
    return interaction.reply({ content: `❌ Minimum withdrawal is **${MIN_WITHDRAWAL_SATS.toLocaleString()} sats**.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const address = addressOpt || (await getWalletForUser(interaction.user.id));
  if (!address) {
    return interaction.editReply({
      content: "❌ No address provided and no linked wallet. Either provide an address or `/link` one first.",
    });
  }

  // 0. Block withdrawals while mid-combat in SatQuest (HP = balance, so this
  //    would otherwise let a player yank sats out to dodge an in-progress loss).
  const { data: sq } = await supabase
    .from("sat_players")
    .select("state")
    .eq("discord_id", interaction.user.id)
    .maybeSingle();
  if (sq?.state === "combat") {
    return interaction.editReply({
      content: "⚔️ You can't withdraw mid-combat in SatQuest. Win the fight, flee, or faint first.",
    });
  }

  // 1. Block concurrent withdrawals (only consider in-flight records < 10 min old)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: pending } = await supabase
    .from("withdrawals")
    .select("id")
    .eq("discord_id", interaction.user.id)
    .eq("status", "pending")
    .gte("created_at", tenMinutesAgo)
    .limit(1)
    .maybeSingle();

  if (pending) {
    return interaction.editReply({
      content: "⏳ You already have a withdrawal in progress. Please wait for it to complete.",
    });
  }

  // 2. Every check runs before the user is debited: SATS needs a solvent
  //    treasury that holds the amount and an amount that covers gas; ERC-20s
  //    need a gas quote and treasury token coverage.
  let gasQuote: Erc20WithdrawalGasQuote | undefined;
  if (token !== "SATS") {
    try {
      gasQuote = await quoteErc20WithdrawalGas(address, amount, token);
    } catch (error) {
      return interaction.editReply({ content: `❌ Unable to estimate withdrawal gas: ${(error as Error).message}` });
    }
  }
  const preflight = await preflightWithdrawal(address, amount, token);
  if (!preflight.ok) {
    return interaction.editReply({ content: withdrawalPreflightMessage(preflight) });
  }

  // 3. Debit + pending row in one transaction (reserve_withdrawal_v2).
  const reservation = await reserveWithdrawal({
    discordId: interaction.user.id,
    toAddress: address,
    amount,
    token,
    gasSats: gasQuote?.gasSats,
  });
  if (!reservation.ok) {
    if (reservation.reason === "insufficient_token") {
      return interaction.editReply({ content: token === "SATS" ? "❌ Insufficient balance." : `❌ Insufficient ${token} balance.` });
    }
    if (reservation.reason === "insufficient_sats") {
      return interaction.editReply({
        content: `❌ Insufficient sats balance to fund the network fee (~${formatSats(gasQuote?.gasSats ?? 0)}).`,
      });
    }
    return interaction.editReply({ content: reservationFailureMessage(reservation.reason) });
  }

  const record = reservation.record;
  const withdrawalId = record.id;

  recordLedgerEntry(interaction.client, {
    type: "withdrawal",
    amountSats: amount,
    token,
    senderId: interaction.user.id,
    receiverId: "treasury",
    guildId: interaction.guildId,
    referenceType: "withdrawals",
    referenceId: String(withdrawalId),
  });
  if (gasQuote) {
    recordLedgerEntry(interaction.client, {
      type: "withdrawal_network_fee",
      amountSats: gasQuote.gasSats,
      token: "SATS",
      senderId: interaction.user.id,
      receiverId: "treasury",
      guildId: interaction.guildId,
      referenceType: "withdrawals",
      referenceId: String(withdrawalId),
      metadata: { withdrawal_token: token },
    });
  }

  // 4. Sign → persist hash/nonce on the row → broadcast → poll (~2 min).
  const result = await executeWithdrawal(record, gasQuote);

  // 5. Apply the verdict once. Refunds happen only when the tx provably can
  //    never land; anything uncertain stays pending for recovery.
  const final = await finalizeWithdrawal(record, result, {
    client: interaction.client,
    guildId: interaction.guildId,
  });

  const explorer = config.evm.explorerUrl;
  const txLink = result.txHash ? `[View on Explorer](${explorer}/tx/${result.txHash})` : null;
  const state = settledState(final);

  if (state === "refunded") {
    return deliver(interaction, {
      content: `❌ Withdrawal failed: ${result.error ?? "transaction did not go through"}. Your balance was refunded.`,
    });
  }
  if (state === "refund_pending") {
    // The row is still 'pending' (or already refunded by a lost-response
    // call); recovery re-runs the idempotent refund every minute.
    return deliver(interaction, {
      content:
        `❌ Withdrawal failed: ${result.error ?? "transaction did not go through"}. ` +
        "Your refund is being processed and should appear in your balance within a few minutes.",
    });
  }
  if (state === "pending") {
    return deliver(interaction, {
      content:
        `⏳ **Withdrawal submitted — still confirming.** ${formatTokenAmount(amount, token)} to ` +
        `\`${address.slice(0, 10)}...${address.slice(-8)}\`.\n` +
        (txLink ? `${txLink}\n` : "") +
        "Please don't retry. It will be finalized automatically; you are refunded only if the network " +
        "rejects the transaction. Check `/history` for status.",
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("✅ Withdrawal Confirmed")
    .addFields(
      { name: "Amount", value: `**${formatTokenAmount(amount, token)}**`, inline: true },
      { name: "To", value: `\`${address.slice(0, 10)}...${address.slice(-8)}\``, inline: true },
    );

  if (result.gasSats) {
    embed.addFields({ name: "Network Fee", value: `~${formatSats(result.gasSats)}`, inline: true });
    if (token === "SATS" && result.sentSats != null) {
      embed.addFields({ name: "Received", value: `~${formatSats(result.sentSats)}`, inline: true });
    }
  }
  if (final.unusedGasRefundSats) {
    embed.addFields({ name: "Unused Fee Returned", value: `~${formatSats(final.unusedGasRefundSats)}`, inline: true });
  }

  if (txLink) {
    embed.addFields({ name: "Transaction", value: txLink });
  }

  embed.setTimestamp();

  return deliver(interaction, { embeds: [embed] });
}

/** Reply for a reservation that did not produce a row we can use. */
export function reservationFailureMessage(reason: "unavailable" | "unconfirmed"): string {
  if (reason === "unconfirmed") {
    return (
      "⚠️ Could not confirm the withdrawal was created. If your balance was debited, it is refunded " +
      "automatically within about 10 minutes — please check `/balance` before retrying."
    );
  }
  return "❌ Could not create the withdrawal. Nothing was debited — please try again later.";
}

async function deliver(
  interaction: ChatInputCommandInteraction,
  payload: { content?: string; embeds?: EmbedBuilder[] },
): Promise<void> {
  try {
    await interaction.editReply(payload);
  } catch {
    // Interaction expired (polling outlived the token) — fall back to DM
    interaction.user.send(payload).catch(() => {});
  }
}
