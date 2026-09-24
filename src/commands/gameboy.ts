/**
 * Game Boy button slash commands (fallback — text input in the game channel is faster).
 * Each one submits a vote to the current democracy round. Tips are summed per button.
 */
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getBalance } from "../balance.js";
import type { EmulatorButton as GBButton } from "@mezosbot/contracts";
import { config } from "../config.js";
import { registerDepositAddress } from "../evm.js";
import { formatSats } from "../format.js";
import { discordIdempotencyKey, sendEmulatorVote, serviceErrorMessage } from "../serviceClient.js";
import { metric } from "../telemetry.js";

const BUTTON_EMOJI: Record<GBButton, string> = {
  A: "🅰️", B: "🅱️", UP: "⬆️", DOWN: "⬇️", LEFT: "⬅️", RIGHT: "➡️", START: "▶️", SELECT: "⏸️",
};

function getButtonEmoji(button: GBButton): string { return BUTTON_EMOJI[button]; }

/** Shared handler for all button commands */
async function handlePress(interaction: ChatInputCommandInteraction, button: GBButton) {
  const emoji = getButtonEmoji(button);
  const minBid = config.gameboy.minBid;
  const amount = interaction.options.getNumber("amount") ?? minBid;

  if (amount < minBid) {
    return interaction.reply({ content: `❌ Minimum bid is ${formatSats(minBid)}.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  metric("discord_ack_ms", Date.now() - interaction.createdTimestamp, { command: button.toLowerCase() });

  // Check balance
  const balance = await getBalance(interaction.user.id);
  if (balance < amount) {
    return interaction.editReply({ content: "❌ Not enough sats." });
  }

  // Submit bid
  const result = config.services.emulatorRemote
    ? await sendEmulatorVote(
      { version: 1, domain: "emulator", actorId: interaction.user.id, button, amountSats: amount },
      discordIdempotencyKey(interaction.id, "emulator.vote"),
    )
    : await import("../emulator.js").then((module) => module.submitBid(interaction.user.id, button, amount));
  if (!result.ok) {
    return interaction.editReply({
      content: "error" in result ? serviceErrorMessage(result.error) : `❌ ${result.reason}`,
    });
  }

  await registerDepositAddress(interaction.user.id);

  // Vote accepted — charged only if this button wins the round
  await interaction.editReply({
    content: `${emoji} Voted **${formatSats(amount)}** on **${button}** — tips are pooled, highest total wins!`,
  });
}

/* ── Command definitions ──────────────────────────────────────────── */

function btn(name: string, button: GBButton, emoji: string) {
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(`${emoji} Vote to press ${button} (tips pooled per button)`)
    .addNumberOption((opt) =>
      opt.setName("amount")
        .setDescription(`Sats to tip (min ${config.gameboy.minBid}, all tips pooled per button)`)
        .setRequired(false)
        .setMinValue(config.gameboy.minBid)
    );

  return {
    data: data.toJSON(),
    execute: (i: ChatInputCommandInteraction) => handlePress(i, button),
  };
}

export const a      = btn("a",      "A",      "🅰️");
export const b      = btn("b",      "B",      "🅱️");
export const up     = btn("up",     "UP",     "⬆️");
export const down   = btn("down",   "DOWN",   "⬇️");
export const left   = btn("left",   "LEFT",   "⬅️");
export const right  = btn("right",  "RIGHT",  "➡️");
export const start  = btn("start",  "START",  "▶️");
export const select = btn("select", "SELECT", "⏸️");

/** All GB button commands as an array for easy registration */
export const gameboyCommands = [a, b, up, down, left, right, start, select];
