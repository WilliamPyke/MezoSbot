"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const config_js_1 = require("./config.js");
const format_js_1 = require("./format.js");
const evm_js_1 = require("./evm.js");
const index_js_1 = require("./commands/index.js");
const emulator_js_1 = require("./emulator.js");
const stream_js_1 = require("./stream.js");
const balance_js_1 = require("./balance.js");
const drops_js_1 = require("./drops.js");
const db_js_1 = require("./db.js");
const profile_js_1 = require("./profile.js");
const notifications_js_1 = require("./notifications.js");
process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err?.message ?? err);
});
process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err?.message ?? err);
});
const intents = [
    discord_js_1.GatewayIntentBits.Guilds,
    discord_js_1.GatewayIntentBits.DirectMessages,
];
if (config_js_1.config.discord.guildMembersIntent) {
    intents.push(discord_js_1.GatewayIntentBits.GuildMembers);
}
if (config_js_1.config.gameboy.enabled &&
    config_js_1.config.gameboy.textInputEnabled &&
    config_js_1.config.gameboy.gameChannelId &&
    config_js_1.config.discord.messageContentIntent) {
    intents.push(discord_js_1.GatewayIntentBits.GuildMessages, discord_js_1.GatewayIntentBits.MessageContent);
}
console.log(`[Discord] Gateway intents: ${intents.join(", ")}`);
const client = new discord_js_1.Client({
    intents,
});
const commandMap = new Map(index_js_1.commands.map((c) => [c.data.name, c.execute]));
client.on("error", (err) => {
    console.error("[Discord] Client error:", err?.message ?? err);
});
client.on("warn", (message) => {
    console.warn("[Discord] Warning:", message);
});
client.on("shardError", (err, shardId) => {
    console.error(`[Discord] Shard ${shardId} error:`, err?.message ?? err);
});
client.on("shardDisconnect", (event, shardId) => {
    console.warn(`[Discord] Shard ${shardId} disconnected: code=${event.code} reason=${event.reason || "(none)"}`);
});
client.on("shardReady", (shardId) => {
    console.log(`[Discord] Shard ${shardId} ready`);
});
client.on("invalidated", () => {
    console.error("[Discord] Session invalidated");
});
function timeoutAfter(ms, label) {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
}
async function waitForDiscordReady(timeoutMs) {
    if (client.isReady())
        return;
    await Promise.race([
        new Promise((resolve) => {
            client.once(discord_js_1.Events.ClientReady, () => resolve());
        }),
        timeoutAfter(timeoutMs, "Discord ready"),
    ]);
}
/* ── Valid text inputs for the game channel ─────────────────────── */
const TEXT_INPUT_MAP = new Map();
for (const btn of emulator_js_1.BUTTONS) {
    TEXT_INPUT_MAP.set(btn.toLowerCase(), btn);
}
TEXT_INPUT_MAP.set("u", "UP");
TEXT_INPUT_MAP.set("d", "DOWN");
TEXT_INPUT_MAP.set("l", "LEFT");
TEXT_INPUT_MAP.set("r", "RIGHT");
/* ── Events ─────────────────────────────────────────────────────── */
client.once(discord_js_1.Events.ClientReady, async (c) => {
    console.log(`Ready as ${c.user.tag}`);
    const rest = new discord_js_1.REST().setToken(config_js_1.config.discord.token);
    await rest.put(discord_js_1.Routes.applicationCommands(config_js_1.config.discord.clientId), { body: index_js_1.commandsData });
    console.log(`Slash commands registered (${index_js_1.commandsData.length} commands)`);
    if (!config_js_1.config.gameboy.enabled) {
        console.log("[Pokemon] Disabled by POKEMON_ENABLED=false");
        return;
    }
    if (!config_js_1.config.gameboy.textInputEnabled) {
        console.log("[Pokemon] Text input disabled by POKEMON_TEXT_INPUT_ENABLED=false");
        return;
    }
    if (!config_js_1.config.discord.messageContentIntent) {
        console.log("[Pokemon] Text input disabled by DISCORD_MESSAGE_CONTENT_INTENT=false");
        return;
    }
    // Log game channel config for diagnostics
    const configuredChannelId = config_js_1.config.gameboy.gameChannelId;
    console.log(`[GB] Game channel ID configured: "${configuredChannelId || "(not set)"}"${!configuredChannelId ? " — text input will be DISABLED" : ""}`);
    // Pre-cache the game channel so we never fetch it during gameplay
    const gcId = config_js_1.config.gameboy.gameChannelId;
    if (gcId) {
        try {
            const ch = await client.channels.fetch(gcId);
            if (ch && "send" in ch)
                cachedGameChannel = ch;
        }
        catch { /* channel not found */ }
    }
});
client.on(discord_js_1.Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
        console.log(`[Discord] Button interaction ${interaction.customId} from ${interaction.user.tag}`);
        const customId = interaction.customId;
        if (customId.startsWith("claim_drop_")) {
            await handleDropButton(interaction);
        }
        return;
    }
    if (!interaction.isChatInputCommand())
        return;
    console.log(`[Discord] Command /${interaction.commandName} from ${interaction.user.tag}`);
    const handler = commandMap.get(interaction.commandName);
    if (!handler) {
        console.warn(`[Discord] No handler registered for /${interaction.commandName}`);
        await interaction.reply({ content: "This command is not available right now.", ephemeral: true }).catch(() => { });
        return;
    }
    const { username, displayName, avatarUrl } = (0, profile_js_1.extractProfile)(interaction);
    (0, profile_js_1.updateUserProfile)(interaction.user.id, username, displayName, avatarUrl).catch(() => { });
    try {
        await handler(interaction);
    }
    catch (err) {
        // 10062 = Unknown Interaction: interaction token expired, typically from
        // pre-restart interactions re-delivered to the new instance. Not a real error.
        if (err?.code === 10062)
            return;
        console.error(`Command /${interaction.commandName} error:`, err?.message ?? err);
        const msg = { content: "❌ Something went wrong.", ephemeral: true };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(msg).catch(() => { });
        }
        else {
            await interaction.reply(msg).catch(() => { });
        }
    }
});
/* ────────────────────────────────────────────────────────────────── */
/*  Game Boy text input listener                                      */
/* ────────────────────────────────────────────────────────────────── */
client.on(discord_js_1.Events.MessageCreate, async (message) => {
    if (message.author.bot)
        return;
    if (!config_js_1.config.gameboy.enabled)
        return;
    if (!config_js_1.config.gameboy.textInputEnabled)
        return;
    if (!config_js_1.config.discord.messageContentIntent)
        return;
    const gameChannelId = config_js_1.config.gameboy.gameChannelId;
    if (!gameChannelId || message.channelId !== gameChannelId)
        return;
    console.log(`[GB] Message in game channel: "${message.content}" from ${message.author.tag} (channel=${message.channelId})`);
    if (!message.content) {
        console.warn("[GB] message.content is empty — is the MESSAGE_CONTENT privileged intent enabled in the Discord Developer Portal?");
        return;
    }
    const parts = message.content.trim().toLowerCase().split(/\s+/);
    const button = TEXT_INPUT_MAP.get(parts[0]);
    if (!button)
        return; // not a valid input — ignore
    // Parse optional tip amount
    const minBid = config_js_1.config.gameboy.minBid;
    let amount = minBid;
    if (parts[1]) {
        const p = parseFloat(parts[1]);
        if (!isNaN(p) && p > 0)
            amount = Math.max(p, minBid);
    }
    // Check balance before accepting bid
    const balance = await (0, balance_js_1.getBalance)(message.author.id);
    if (balance < amount) {
        return; // silent rejection — don't spam the channel
    }
    // Submit bid
    const result = (0, emulator_js_1.submitBid)(message.author.id, button, amount);
    if (!result.ok)
        return;
    // Ensure user has a deposit address (fire-and-forget, first time only)
    (0, evm_js_1.registerDepositAddress)(message.author.id).catch(() => { });
});
/* ────────────────────────────────────────────────────────────────── */
/*  Democracy round resolution                                        */
/*  Charges are fire-and-forget. Feed updates throttled to 1/sec.     */
/*  NOTHING here blocks the emulator or event loop.                   */
/* ────────────────────────────────────────────────────────────────── */
let cachedGameChannel = null;
let feedMsg = null;
let feedBusy = false;
let lastFeedTime = 0;
const FEED_THROTTLE_MS = 1000; // max 1 Discord message edit per second
function setupGameBoyCallbacks() {
    if (!config_js_1.config.gameboy.enabled)
        return;
    if (!config_js_1.config.gameboy.textInputEnabled)
        return;
    if (!config_js_1.config.discord.messageContentIntent)
        return;
    if (!config_js_1.config.gameboy.gameChannelId)
        return;
    (0, emulator_js_1.onRound)((result) => {
        const { winningButton, winners, winningSats, tally, totalBids } = result;
        // ── Charge all winning voters — fire and forget ──
        (0, balance_js_1.subtractBalances)(winners.map((bid) => ({ discordId: bid.userId, amountSats: bid.amount }))).catch(() => { });
        // ── Update feed message — throttled, non-blocking ──
        const now = Date.now();
        if (feedBusy || now - lastFeedTime < FEED_THROTTLE_MS)
            return;
        feedBusy = true;
        lastFeedTime = now;
        updateFeed(winningButton, winningSats, tally, totalBids)
            .catch(() => { })
            .finally(() => { feedBusy = false; });
    });
}
async function updateFeed(button, sats, tally, totalBids) {
    if (!cachedGameChannel)
        return;
    const emoji = (0, emulator_js_1.getButtonEmoji)(button);
    let content = `${emoji} **${button}** — **${(0, format_js_1.formatSats)(sats)}** from ${totalBids} vote${totalBids !== 1 ? "s" : ""}`;
    if (tally.length > 1) {
        const breakdown = tally
            .map((v) => `${(0, emulator_js_1.getButtonEmoji)(v.button)} ${(0, format_js_1.formatSats)(v.totalSats)} (${v.voters.length})`)
            .join("  ");
        content += `\n${breakdown}`;
    }
    try {
        if (feedMsg) {
            await feedMsg.edit({ content, allowedMentions: { parse: [] } });
        }
        else {
            feedMsg = await cachedGameChannel.send({ content, allowedMentions: { parse: [] } });
        }
    }
    catch {
        // Message was deleted or errored — will create a new one next update
        feedMsg = null;
    }
}
/* ── Drop claim button handler ────────────────────────────────── */
async function handleDropButton(interaction) {
    const dropId = parseInt(interaction.customId.replace("claim_drop_", ""), 10);
    if (isNaN(dropId))
        return;
    await interaction.deferReply({ ephemeral: true });
    const member = interaction.guild
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
    const claimantRoleIds = member ? [...member.roles.cache.keys()] : [];
    const result = await (0, drops_js_1.processClaim)(dropId, interaction.user.id, claimantRoleIds);
    if (!result.ok) {
        await interaction.editReply({ content: `❌ ${result.error}` });
        return;
    }
    if (result.creatorId && typeof result.amountSats === "number") {
        await (0, notifications_js_1.sendTransferReceivedDm)({
            client: interaction.client,
            recipientId: interaction.user.id,
            senderId: result.creatorId,
            amountSats: result.amountSats,
            kind: "drop",
        });
    }
    const { data: drop } = await db_js_1.supabase
        .from("drops")
        .select("*")
        .eq("id", dropId)
        .single();
    if (drop) {
        const claimEmbed = new discord_js_1.EmbedBuilder()
            .setColor(0x00cc6a)
            .setTitle("🎉 Claimed!")
            .addFields({ name: "Amount", value: `**${(0, format_js_1.formatSats)(drop.per_claim_sats)}**`, inline: true }, { name: "Remaining", value: `**${result.remaining}**`, inline: true });
        await interaction.editReply({ embeds: [claimEmbed] });
        try {
            const claimedBy = await (0, drops_js_1.getClaimants)(dropId);
            const embed = (0, drops_js_1.buildDropEmbed)(drop, claimedBy);
            const row = (0, drops_js_1.buildClaimButton)(dropId, result.completed);
            await interaction.message.edit({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
        }
        catch (err) {
            console.error("Failed to update drop message:", err?.message ?? err);
        }
    }
    else {
        const fallbackEmbed = new discord_js_1.EmbedBuilder()
            .setColor(0x00cc6a)
            .setTitle("🎉 Claimed!")
            .setDescription(`${result.remaining} claim${result.remaining === 1 ? "" : "s"} left`);
        await interaction.editReply({ embeds: [fallbackEmbed] });
    }
}
/* ── Main ─────────────────────────────────────────────────────── */
async function main() {
    // ── Web canvas server (start first — Render needs an open port quickly) ──
    await (0, stream_js_1.startStream)();
    (0, evm_js_1.initEVM)();
    console.log(`Treasury: ${(0, evm_js_1.getTreasuryAddress)()}`);
    // Resolve any withdrawals left pending from a previous session
    (0, evm_js_1.recoverPendingWithdrawals)().catch((err) => console.error("[Recovery] Failed:", err?.message ?? err));
    (0, evm_js_1.startDepositPoller)((discordId, amountSats, gasSats) => {
        console.log(`Auto-deposit: ${(0, format_js_1.formatSats)(amountSats)} (gas: ~${(0, format_js_1.formatSats)(gasSats)}) for ${discordId}`);
        client.users.fetch(discordId).then((u) => {
            const embed = new discord_js_1.EmbedBuilder()
                .setColor(0x00cc6a)
                .setTitle("✅ Deposit Received!")
                .addFields({ name: "Credited", value: `**${(0, format_js_1.formatSats)(amountSats)}**`, inline: true });
            if (gasSats > 0) {
                embed.addFields({ name: "Gas Deducted", value: `~${(0, format_js_1.formatSats)(gasSats)}`, inline: true });
            }
            embed.setFooter({ text: "Use /balance to check your total" });
            embed.setTimestamp();
            u.send({ embeds: [embed] }).catch(() => { });
        }).catch(() => { });
    });
    console.log(`[Discord] Logging in as application ${config_js_1.config.discord.clientId}...`);
    await Promise.race([
        client.login(config_js_1.config.discord.token),
        timeoutAfter(120_000, "Discord login"),
    ]);
    console.log("[Discord] Login call completed; waiting for gateway ready...");
    await waitForDiscordReady(120_000);
    console.log("[Discord] Gateway ready confirmed");
    if (!config_js_1.config.gameboy.enabled) {
        console.log("[Pokemon] POKEMON_ENABLED=false - emulator and controls disabled");
        return;
    }
    // ── Game Boy emulator ──
    const { romPath } = config_js_1.config.gameboy;
    if (romPath) {
        try {
            await (0, emulator_js_1.startEmulator)(romPath);
            setupGameBoyCallbacks();
        }
        catch (err) {
            console.error("[GameBoy] Failed to start:", err?.message ?? err);
        }
    }
    else {
        console.log("[GameBoy] ROM_PATH not set — emulator disabled");
    }
}
// Graceful shutdown: save game state before exit
process.on("SIGINT", async () => {
    console.log("\n[Shutdown] Received SIGINT, saving game state...");
    await (0, emulator_js_1.stopEmulator)();
    process.exit(0);
});
process.on("SIGTERM", async () => {
    console.log("\n[Shutdown] Received SIGTERM, saving game state...");
    await (0, emulator_js_1.stopEmulator)();
    process.exit(0);
});
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
