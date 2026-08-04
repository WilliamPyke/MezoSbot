import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import { config } from "../config.js";
import { formatSats } from "../format.js";
import { formatTokenAmount, parseToken, TOKEN_CHOICES, tokenLabel } from "../tokens.js";
import { cancelSwapQuote, createSwapQuote, executeSwapQuote } from "../swap/service.js";
import type { SwapQuote } from "../swap/types.js";

const PREFIX = "swap";
const COLOR = 0x00cc6a;

export const data = {
  name: "swap",
  description: "Swap between SATS, MUSD, and mUSDC (gas for on-chain legs paid in sats)",
  options: [
    {
      name: "amount",
      type: 10 as const,
      description: "Amount of the token you are selling",
      required: true,
      minValue: 0.000001,
    },
    {
      name: "from",
      type: 3 as const,
      description: "Token to sell",
      required: true,
      choices: TOKEN_CHOICES.filter((c) => c.value !== "MEZO"),
    },
    {
      name: "to",
      type: 3 as const,
      description: "Token to buy",
      required: true,
      choices: TOKEN_CHOICES.filter((c) => c.value !== "MEZO"),
    },
    {
      name: "slippage",
      type: 10 as const,
      description: "Max slippage % for on-chain path (default 0.5–1%)",
      required: false,
      minValue: 0.05,
      maxValue: 5,
    },
    {
      name: "onchain",
      type: 5 as const,
      description: "Force on-chain Mezo Pools swap (skip inventory)",
      required: false,
    },
  ],
};

function buildQuoteEmbed(quote: SwapQuote): EmbedBuilder {
  const modeLabel =
    quote.mode === "internal"
      ? "Instant · treasury inventory"
      : "On-chain · Mezo Pools";
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("Confirm swap")
    .setDescription(
      `Sell **${formatTokenAmount(quote.fromAmount, quote.fromToken)}**\n` +
        `Receive **~${formatTokenAmount(quote.quotedToAmount, quote.toToken)}**` +
        (quote.mode === "onchain"
          ? `\nMinimum: **${formatTokenAmount(quote.minToAmount, quote.toToken)}**`
          : ""),
    )
    .addFields(
      { name: "Rate", value: quote.rateLabel, inline: false },
      { name: "Path", value: modeLabel, inline: true },
      {
        name: "Network fee",
        value: quote.mode === "onchain" ? `~${formatSats(quote.gasReservedSats)} (reserved)` : "None (internal)",
        inline: true,
      },
      {
        name: "Slippage",
        value: `${(quote.slippageBps / 100).toFixed(2)}%`,
        inline: true,
      },
    )
    .setFooter({
      text: `Quote expires in ~${Math.round(config.swap.quoteTtlMs / 1000)}s · free ${tokenLabel(quote.toToken)} inventory ≈ ${formatTokenAmount(quote.freeInventoryTo, quote.toToken)}`,
    })
    .setTimestamp(quote.expiresAt);

  if (quote.mode === "onchain") {
    embed.addFields({
      name: "You need",
      value:
        quote.fromToken === "SATS"
          ? `**${formatTokenAmount(quote.fromAmount + quote.gasReservedSats, "SATS")}** (amount + gas)`
          : `**${formatTokenAmount(quote.fromAmount, quote.fromToken)}** + **${formatSats(quote.gasReservedSats)}** gas`,
      inline: false,
    });
  }
  return embed;
}

function buildButtons(quoteId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:confirm:${quoteId}`)
      .setLabel("Confirm swap")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:cancel:${quoteId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!config.swap.enabled) {
    await interaction.reply({
      content: "Swaps are temporarily disabled.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const fromToken = parseToken(interaction.options.getString("from", true));
  const toToken = parseToken(interaction.options.getString("to", true));
  const amount = interaction.options.getNumber("amount", true);
  const slippagePct = interaction.options.getNumber("slippage");
  const forceOnchain = interaction.options.getBoolean("onchain") ?? false;
  const slippageBps = slippagePct != null ? Math.round(slippagePct * 100) : null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const quote = await createSwapQuote({
      discordId: interaction.user.id,
      fromToken,
      toToken,
      fromAmount: amount,
      slippageBps,
      forceOnchain,
      guildId: interaction.guildId,
    });

    await interaction.editReply({
      embeds: [buildQuoteEmbed(quote)],
      components: [buildButtons(quote.quoteId)],
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ ${(error as Error).message}`,
      embeds: [],
      components: [],
    });
  }
}

export function isSwapInteraction(interaction: Interaction): boolean {
  return "customId" in interaction && typeof interaction.customId === "string"
    && interaction.customId.startsWith(`${PREFIX}:`);
}

export async function handleSwapInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  const btn = interaction as ButtonInteraction;
  const parts = btn.customId.split(":");
  const action = parts[1];
  const quoteId = parts[2];
  if (!quoteId || (action !== "confirm" && action !== "cancel")) return;

  await btn.deferUpdate();

  if (action === "cancel") {
    await cancelSwapQuote(quoteId, btn.user.id).catch(() => false);
    await btn.editReply({
      content: "Swap cancelled.",
      embeds: [],
      components: [],
    });
    return;
  }

  try {
    const result = await executeSwapQuote(quoteId, btn.user.id, btn.client);
    if (!result.ok) {
      await btn.editReply({
        content: `❌ ${result.error}`,
        embeds: [],
        components: [],
      });
      return;
    }

    const explorer = config.evm.explorerUrl;
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle("✅ Swap complete")
      .setDescription(
        result.mode === "internal"
          ? "Filled from treasury inventory (no network fee)."
          : "Filled via Mezo Pools on-chain.",
      )
      .addFields(
        {
          name: "Sold",
          value: `**${formatTokenAmount(result.fromAmount, result.fromToken)}**`,
          inline: true,
        },
        {
          name: "Received",
          value: `**${formatTokenAmount(result.receivedToAmount, result.toToken)}**`,
          inline: true,
        },
        {
          name: "Path",
          value: result.mode === "internal" ? "Instant inventory" : "Mezo Pools",
          inline: true,
        },
      )
      .setTimestamp();

    if (result.gasActualSats > 0) {
      embed.addFields({
        name: "Network fee",
        value: `~${formatSats(result.gasActualSats)}` +
          (result.gasRefundedSats > 0
            ? ` · unused ~${formatSats(result.gasRefundedSats)} refunded`
            : ""),
        inline: true,
      });
    }
    if (result.txHash) {
      embed.addFields({
        name: "Transaction",
        value: `[View on Explorer](${explorer}/tx/${result.txHash})`,
      });
    }

    await btn.editReply({ embeds: [embed], components: [], content: null });
  } catch (error) {
    await btn.editReply({
      content: `❌ Swap failed: ${(error as Error).message}`,
      embeds: [],
      components: [],
    });
  }
}
