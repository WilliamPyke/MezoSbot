"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const node_dns_1 = require("node:dns");
const config_js_1 = require("./config.js");
const format_js_1 = require("./format.js");
const evm_js_1 = require("./evm.js");
const index_js_1 = require("./commands/index.js");
const quest_js_1 = require("./commands/quest.js");
const emulator_js_1 = require("./emulator.js");
const stream_js_1 = require("./stream.js");
const balance_js_1 = require("./balance.js");
const drops_js_1 = require("./drops.js");
const db_js_1 = require("./db.js");
const profile_js_1 = require("./profile.js");
const notifications_js_1 = require("./notifications.js");
const interactions_js_1 = require("./arcade/interactions.js");
const eventQuests_js_1 = require("./eventQuests.js");
const runtime_js_1 = require("./quests/runtime.js");
const notify_js_1 = require("./arcade/notify.js");
const spectate_js_1 = require("./arcade/spectate.js");
const db_js_2 = require("./arcade/db.js");
const matchmaking_js_1 = require("./arcade/matchmaking.js");
process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err?.message ?? err);
});
process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err?.message ?? err);
});
(0, node_dns_1.setDefaultResultOrder)("ipv4first");
console.log("[Network] DNS result order set to ipv4first");
const intents = [
    discord_js_1.GatewayIntentBits.Guilds,
    discord_js_1.GatewayIntentBits.GuildScheduledEvents,
    discord_js_1.GatewayIntentBits.GuildVoiceStates,
];
if (config_js_1.config.discord.guildMembersIntent) {
    intents.push(discord_js_1.GatewayIntentBits.GuildMembers);
}
if (config_js_1.config.discord.messageContentIntent) {
    intents.push(discord_js_1.GatewayIntentBits.GuildMessages, discord_js_1.GatewayIntentBits.MessageContent);
}
if (config_js_1.config.gameboy.enabled &&
    config_js_1.config.gameboy.textInputEnabled &&
    config_js_1.config.gameboy.gameChannelId &&
    config_js_1.config.discord.messageContentIntent) {
    if (!intents.includes(discord_js_1.GatewayIntentBits.GuildMessages))
        intents.push(discord_js_1.GatewayIntentBits.GuildMessages);
    if (!intents.includes(discord_js_1.GatewayIntentBits.MessageContent))
        intents.push(discord_js_1.GatewayIntentBits.MessageContent);
}
console.log(`[Discord] Gateway intents: ${intents.join(", ")}`);
let discordState = "not_started";
const client = new discord_js_1.Client({
    intents,
});
(0, stream_js_1.setHealthStatusProvider)(() => ({
    status: client.isReady() ? "ok" : "starting",
    discordReady: client.isReady(),
    discordState,
}));
const commandMap = new Map(index_js_1.commands.map((c) => [c.data.name, c.execute]));
const autocompleteMap = new Map(index_js_1.commands
    .filter((c) => "autocomplete" in c && typeof c.autocomplete === "function")
    .map((c) => [c.data.name, c.autocomplete]));
const STALE_INTERACTION_SKIP_MS = 2_800;
client.on("error", (err) => {
    discordState = "client_error";
    console.error("[Discord] Client error:", err?.message ?? err);
});
client.on("warn", (message) => {
    console.warn("[Discord] Warning:", message);
});
client.on("shardError", (err, shardId) => {
    discordState = "shard_error";
    console.error(`[Discord] Shard ${shardId} error:`, err?.message ?? err);
});
client.on("shardDisconnect", (event, shardId) => {
    discordState = "disconnected";
    console.warn(`[Discord] Shard ${shardId} disconnected: code=${event.code} reason=${event.reason || "(none)"}`);
});
client.on("shardReady", (shardId) => {
    discordState = "shard_ready";
    console.log(`[Discord] Shard ${shardId} ready`);
});
client.on("invalidated", () => {
    discordState = "invalidated";
    console.error("[Discord] Session invalidated");
});
/* ── Process-level diagnostics ────────────────────────────────────── */
// Event-loop lag: fires a setImmediate every 1s and measures how late it
// runs. >100ms = the loop is starved (heavy sync work is blocking, or CPU
// is throttled). This is the smoking gun for gateway heartbeat failures.
{
    const SAMPLE_MS = 1000;
    const WARN_LAG_MS = 200;
    let lastTick = Date.now();
    setInterval(() => {
        const now = Date.now();
        const lag = now - lastTick - SAMPLE_MS;
        lastTick = now;
        if (lag > WARN_LAG_MS) {
            console.warn(`[Diag] Event loop lag ${lag}ms (sample=${SAMPLE_MS}ms) — process is CPU-starved`);
        }
    }, SAMPLE_MS);
}
// Gateway ping: log every 30s. Healthy is ~50–200ms; >500ms or "-1" means
// heartbeat acks are missing and the connection is on its way to dropping.
setInterval(() => {
    if (!client.isReady())
        return;
    const ping = client.ws.ping;
    if (ping < 0) {
        console.warn("[Diag] Gateway ping unavailable (no recent heartbeat ack) — gateway likely reconnecting");
    }
    else if (ping > 500) {
        console.warn(`[Diag] Gateway ping ${ping}ms — heartbeat is slow, interactions may time out`);
    }
    else {
        console.log(`[Diag] Gateway ping ${ping}ms (healthy)`);
    }
}, 30_000);
function timeoutAfter(ms, label) {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
async function checkDiscordRestPreflight() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const res = await fetch("https://discord.com/api/v10/gateway/bot", {
            headers: { Authorization: `Bot ${config_js_1.config.discord.token}` },
            signal: controller.signal,
        });
        const bodyText = await res.text().catch(() => "");
        if (!res.ok) {
            const retryAfterHeader = Number(res.headers.get("retry-after"));
            const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
                ? Math.ceil(retryAfterHeader * 1000)
                : 60_000;
            return { ok: false, status: res.status, retryAfterMs, bodyPreview: bodyText.slice(0, 300) };
        }
        const payload = JSON.parse(bodyText);
        const ssl = payload.session_start_limit;
        console.log(`[Discord] REST preflight ok: gateway=${payload.url ?? "?"} shards=${payload.shards ?? "?"} sessions=${ssl?.remaining ?? "?"}/${ssl?.total ?? "?"} resetIn=${ssl?.reset_after != null ? Math.round(ssl.reset_after / 1000) + "s" : "?"}`);
        return {
            ok: true,
            sessionsRemaining: ssl?.remaining ?? null,
            resetAfterMs: ssl?.reset_after ?? null,
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
async function connectDiscordWithRetry() {
    let attempt = 0;
    while (!client.isReady()) {
        attempt += 1;
        try {
            discordState = `preflight_${attempt}`;
            const preflight = await checkDiscordRestPreflight();
            if (!preflight.ok) {
                discordState = `preflight_failed_${preflight.status}`;
                console.error(`[Discord] REST preflight failed: HTTP ${preflight.status}. Body: ${preflight.bodyPreview}`);
                if (preflight.status === 401) {
                    console.error("[Discord] 401 Unauthorized — DISCORD_TOKEN is invalid or revoked. Reset the bot token in the Developer Portal (Bot tab) and update DISCORD_TOKEN on Render.");
                }
                console.log(`[Discord] Backing off ${Math.round(preflight.retryAfterMs / 1000)}s before retry`);
                await sleep(preflight.retryAfterMs);
                continue;
            }
            if (preflight.sessionsRemaining != null && preflight.sessionsRemaining < 5) {
                const waitMs = (preflight.resetAfterMs ?? 60 * 60_000) + 60_000;
                discordState = "session_limit_low";
                console.error(`[Discord] Session start limit nearly exhausted (${preflight.sessionsRemaining} left). Sleeping ${Math.round(waitMs / 1000)}s to avoid lockout.`);
                await sleep(waitMs);
                continue;
            }
            discordState = `login_attempt_${attempt}`;
            console.log(`[Discord] Logging in as application ${config_js_1.config.discord.clientId}...`);
            await Promise.race([
                client.login(config_js_1.config.discord.token),
                timeoutAfter(120_000, "Discord login"),
            ]);
            discordState = "waiting_ready";
            console.log("[Discord] Login call completed; waiting for gateway ready...");
            await waitForDiscordReady(120_000);
            discordState = "ready";
            console.log("[Discord] Gateway ready confirmed");
            return;
        }
        catch (err) {
            discordState = "retry_wait";
            const message = err?.message ?? String(err);
            const retryAfterMs = Math.min(5 * 60_000, 15_000 * attempt);
            console.error(`[Discord] Connection attempt ${attempt} failed:`, message);
            try {
                client.destroy();
            }
            catch {
                // no-op
            }
            console.log(`[Discord] Retrying connection in ${Math.round(retryAfterMs / 1000)}s`);
            await sleep(retryAfterMs);
        }
    }
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
    discordState = "ready";
    console.log(`Ready as ${c.user.tag}`);
    registerSlashCommands().catch((err) => {
        console.error("[Discord] Slash command registration failed:", err?.message ?? err);
    });
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
    // Arrival latency = how long Discord took to deliver this to us. If this is
    // consistently >500ms, the gateway connection is unhealthy (we're behind on
    // events, often due to event-loop starvation or a recent reconnect).
    const arrivalLagMs = Date.now() - interaction.createdTimestamp;
    const startMs = Date.now();
    const tag = interaction.user.tag;
    if (arrivalLagMs >= STALE_INTERACTION_SKIP_MS) {
        const name = interaction.isChatInputCommand()
            ? `/${interaction.commandName}`
            : "customId" in interaction
                ? interaction.customId
                : interaction.type.toString();
        console.warn(`[Discord] Skipping stale interaction ${name} from ${tag} (arrivalLag=${arrivalLagMs}ms) — already near Discord's 3s response deadline`);
        return;
    }
    if ((0, interactions_js_1.isArcadeInteraction)(interaction)) {
        const cid = ("customId" in interaction && interaction.customId) || "";
        console.log(`[Discord] Arcade interaction ${cid} from ${tag} (arrivalLag=${arrivalLagMs}ms)`);
        await (0, interactions_js_1.handleArcadeInteraction)(interaction);
        console.log(`[Discord] Arcade ${cid} done in ${Date.now() - startMs}ms`);
        return;
    }
    if ((0, quest_js_1.isQuestBuilderInteraction)(interaction)) {
        const cid = ("customId" in interaction && interaction.customId) || "";
        console.log(`[Discord] Quest builder interaction ${cid} from ${tag} (arrivalLag=${arrivalLagMs}ms)`);
        await (0, quest_js_1.handleQuestBuilderInteraction)(interaction);
        console.log(`[Discord] Quest builder ${cid} done in ${Date.now() - startMs}ms`);
        return;
    }
    if (interaction.isAutocomplete()) {
        const handler = autocompleteMap.get(interaction.commandName);
        if (!handler) {
            await interaction.respond([]).catch(() => { });
            return;
        }
        await handler(interaction).catch((err) => {
            console.warn(`[Discord] Autocomplete /${interaction.commandName} failed:`, err?.message ?? err);
            interaction.respond([]).catch(() => { });
        });
        return;
    }
    if (interaction.isButton()) {
        console.log(`[Discord] Button interaction ${interaction.customId} from ${tag} (arrivalLag=${arrivalLagMs}ms)`);
        const customId = interaction.customId;
        if (customId.startsWith("claim_drop_")) {
            await handleDropButton(interaction);
        }
        console.log(`[Discord] Button ${customId} done in ${Date.now() - startMs}ms`);
        return;
    }
    if (!interaction.isChatInputCommand())
        return;
    console.log(`[Discord] Command /${interaction.commandName} from ${tag} (arrivalLag=${arrivalLagMs}ms)`);
    if (arrivalLagMs > 1500) {
        console.warn(`[Discord] HIGH ARRIVAL LAG ${arrivalLagMs}ms for /${interaction.commandName} — gateway is behind, expect "did not respond"`);
    }
    const handler = commandMap.get(interaction.commandName);
    if (!handler) {
        console.warn(`[Discord] No handler registered for /${interaction.commandName}`);
        await interaction.reply({ content: "This command is not available right now.", flags: discord_js_1.MessageFlags.Ephemeral }).catch(() => { });
        return;
    }
    const { username, displayName, avatarUrl } = (0, profile_js_1.extractProfile)(interaction);
    (0, profile_js_1.updateUserProfile)(interaction.user.id, username, displayName, avatarUrl).catch(() => { });
    try {
        await handler(interaction);
        console.log(`[Discord] /${interaction.commandName} done in ${Date.now() - startMs}ms (arrivalLag=${arrivalLagMs}ms)`);
    }
    catch (err) {
        if (err?.code === 10062) {
            console.warn(`[Discord] /${interaction.commandName} token expired (arrivalLag=${arrivalLagMs}ms, totalMs=${Date.now() - startMs}) — interaction was likely stale on arrival`);
            return;
        }
        console.error(`Command /${interaction.commandName} error:`, err?.message ?? err);
        const msg = { content: "❌ Something went wrong.", flags: discord_js_1.MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(msg).catch(() => { });
        }
        else {
            await interaction.reply(msg).catch(() => { });
        }
    }
});
client.on(discord_js_1.Events.VoiceStateUpdate, async (oldState, newState) => {
    await (0, eventQuests_js_1.handleQuestVoiceStateUpdate)(client, oldState, newState).catch((err) => console.warn("[Quest] Voice state handler failed:", err?.message ?? err));
    await (0, runtime_js_1.handleMultiStepQuestVoiceStateUpdate)(client, oldState, newState).catch((err) => console.warn("[QuestEngine] Voice state handler failed:", err?.message ?? err));
});
client.on(discord_js_1.Events.GuildScheduledEventUpdate, async (_oldEvent, newEvent) => {
    await (0, eventQuests_js_1.handleEventQuestScheduledEventUpdate)(client, newEvent).catch((err) => console.warn("[Quest] Scheduled event sync failed:", err?.message ?? err));
    await (0, runtime_js_1.handleMultiStepScheduledEventUpdate)(client, newEvent).catch((err) => console.warn("[QuestEngine] Scheduled event sync failed:", err?.message ?? err));
});
/* ────────────────────────────────────────────────────────────────── */
/*  Game Boy text input listener                                      */
/* ────────────────────────────────────────────────────────────────── */
client.on(discord_js_1.Events.MessageCreate, async (message) => {
    if (message.author.bot)
        return;
    await (0, runtime_js_1.handleMultiStepQuestMessage)(client, message).catch((err) => console.warn("[QuestEngine] Message handler failed:", err?.message ?? err));
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
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
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
    // Slice Arcade browser flow needs a public HTTPS URL to put in Discord
    // Link buttons. Surface a loud warning on startup if the operator hasn't
    // set PUBLIC_BASE_URL — otherwise /arcade practice will look broken.
    try {
        const u = new URL(config_js_1.config.publicBaseUrl);
        const localish = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0";
        if (u.protocol !== "https:" || localish) {
            console.warn(`[Arcade] PUBLIC_BASE_URL is "${config_js_1.config.publicBaseUrl}" — Discord Link buttons require https:// and a public host. ` +
                `Set PUBLIC_BASE_URL on the host (e.g. https://your-bot.example.com) and redeploy.`);
        }
        else {
            console.log(`[Arcade] PUBLIC_BASE_URL = ${config_js_1.config.publicBaseUrl}`);
        }
    }
    catch {
        console.warn(`[Arcade] PUBLIC_BASE_URL is not a valid URL: "${config_js_1.config.publicBaseUrl}"`);
    }
    // When a Slice Arcade match settles via the browser flow, refresh the
    // public match card in Discord so spectators see the result.
    (0, notify_js_1.setMatchSettledHandler)(async (matchId) => {
        const match = await (0, db_js_2.getMatch)(matchId);
        if (match)
            await (0, interactions_js_1.updateMatchFeed)(client, match);
    });
    // Resolve discord display names for spectator panels.
    (0, spectate_js_1.setDisplayNameResolver)(async (userId) => {
        try {
            const user = await client.users.fetch(userId);
            return user.globalName ?? user.username ?? null;
        }
        catch {
            return null;
        }
    });
    // Sweep stale matchmaking-queue entries. Pairing happens on enqueue, so
    // this only handles expiry of waiting entries whose owners walked away.
    setInterval(() => {
        (0, matchmaking_js_1.expireStaleQueueEntries)().catch((err) => console.warn("[Arcade] queue sweeper failed:", err?.message ?? err));
    }, 60_000);
    (0, eventQuests_js_1.startEventQuestSweeper)(client);
    (0, runtime_js_1.startMultiStepQuestSweeper)(client);
    (0, evm_js_1.initEVM)();
    console.log(`Treasury: ${(0, evm_js_1.getTreasuryAddress)()}`);
    // Resolve any withdrawals left pending from a previous session
    (0, evm_js_1.recoverPendingWithdrawals)().catch((err) => console.error("[Recovery] Failed:", err?.message ?? err));
    await connectDiscordWithRetry();
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
async function registerSlashCommands() {
    const rest = new discord_js_1.REST().setToken(config_js_1.config.discord.token);
    await rest.put(discord_js_1.Routes.applicationCommands(config_js_1.config.discord.clientId), { body: index_js_1.commandsData });
    console.log(`Slash commands registered (${index_js_1.commandsData.length} commands)`);
}
