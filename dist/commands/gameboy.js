"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gameboyCommands = exports.select = exports.start = exports.right = exports.left = exports.down = exports.up = exports.b = exports.a = void 0;
/**
 * Game Boy button slash commands (fallback — text input in the game channel is faster).
 * Each one submits a vote to the current democracy round. Tips are summed per button.
 */
const discord_js_1 = require("discord.js");
const balance_js_1 = require("../balance.js");
const emulator_js_1 = require("../emulator.js");
const config_js_1 = require("../config.js");
const evm_js_1 = require("../evm.js");
const format_js_1 = require("../format.js");
/** Shared handler for all button commands */
async function handlePress(interaction, button) {
    const emoji = (0, emulator_js_1.getButtonEmoji)(button);
    const minBid = config_js_1.config.gameboy.minBid;
    const amount = interaction.options.getNumber("amount") ?? minBid;
    if (amount < minBid) {
        return interaction.reply({ content: `❌ Minimum bid is ${(0, format_js_1.formatSats)(minBid)}.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    // Check balance
    const balance = await (0, balance_js_1.getBalance)(interaction.user.id);
    if (balance < amount) {
        return interaction.editReply({ content: "❌ Not enough sats." });
    }
    // Submit bid
    const result = (0, emulator_js_1.submitBid)(interaction.user.id, button, amount);
    if (!result.ok) {
        return interaction.editReply({ content: `❌ ${result.reason}` });
    }
    await (0, evm_js_1.registerDepositAddress)(interaction.user.id);
    // Vote accepted — charged only if this button wins the round
    await interaction.editReply({
        content: `${emoji} Voted **${(0, format_js_1.formatSats)(amount)}** on **${button}** — tips are pooled, highest total wins!`,
    });
}
/* ── Command definitions ──────────────────────────────────────────── */
function btn(name, button, emoji) {
    const data = new discord_js_1.SlashCommandBuilder()
        .setName(name)
        .setDescription(`${emoji} Vote to press ${button} (tips pooled per button)`)
        .addNumberOption((opt) => opt.setName("amount")
        .setDescription(`Sats to tip (min ${config_js_1.config.gameboy.minBid}, all tips pooled per button)`)
        .setRequired(false)
        .setMinValue(config_js_1.config.gameboy.minBid));
    return {
        data: data.toJSON(),
        execute: (i) => handlePress(i, button),
    };
}
exports.a = btn("a", "A", "🅰️");
exports.b = btn("b", "B", "🅱️");
exports.up = btn("up", "UP", "⬆️");
exports.down = btn("down", "DOWN", "⬇️");
exports.left = btn("left", "LEFT", "⬅️");
exports.right = btn("right", "RIGHT", "➡️");
exports.start = btn("start", "START", "▶️");
exports.select = btn("select", "SELECT", "⏸️");
/** All GB button commands as an array for easy registration */
exports.gameboyCommands = [exports.a, exports.b, exports.up, exports.down, exports.left, exports.right, exports.start, exports.select];
