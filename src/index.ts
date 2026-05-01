import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type TextChannel,
  type Message,
} from "discord.js";
import { config } from "./config.js";
import { formatSats } from "./format.js";
import { initEVM, getTreasuryAddress, startDepositPoller, registerDepositAddress, recoverPendingWithdrawals } from "./evm.js";
import { commands, commandsData } from "./commands/index.js";
import {
  startEmulator,
  stopEmulator,
  submitBid,
  onRound,
  getButtonEmoji,
  BUTTONS,
  type GBButton,
  type RoundResult,
} from "./emulator.js";
import { startStream } from "./stream.js";
import { getBalance, subtractBalances } from "./balance.js";
import {
  processClaim,
  buildDropEmbed,
  buildClaimButton,
  getClaimants,
  type Drop,
} from "./drops.js";
import { supabase } from "./db.js";
import { extractProfile, updateUserProfile } from "./profile.js";
import { sendTransferReceivedDm } from "./notifications.js";

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", (err as Error)?.message ?? err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", (err as Error)?.message ?? err);
});

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.DirectMessages,
];

if (config.discord.guildMembersIntent) {
  intents.push(GatewayIntentBits.GuildMembers);
}

if (
  config.gameboy.enabled &&
  config.gameboy.textInputEnabled &&
  config.gameboy.gameChannelId &&
  config.discord.messageContentIntent
) {
  intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
}

console.log(`[Discord] Gateway intents: ${intents.join(", ")}`);

const client = new Client({
  intents,
});

const commandMap = new Map(commands.map((c) => [c.data.name, c.execute]));

client.on("error", (err) => {
  console.error("[Discord] Client error:", (err as Error)?.message ?? err);
});

client.on("warn", (message) => {
  console.warn("[Discord] Warning:", message);
});

client.on("shardError", (err, shardId) => {
  console.error(`[Discord] Shard ${shardId} error:`, (err as Error)?.message ?? err);
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

function timeoutAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
}

async function waitForDiscordReady(timeoutMs: number): Promise<void> {
  if (client.isReady()) return;

  await Promise.race([
    new Promise<void>((resolve) => {
      client.once(Events.ClientReady, () => resolve());
    }),
    timeoutAfter(timeoutMs, "Discord ready"),
  ]);
}

/* ── Valid text inputs for the game channel ─────────────────────── */

const TEXT_INPUT_MAP = new Map<string, GBButton>();
for (const btn of BUTTONS) {
  TEXT_INPUT_MAP.set(btn.toLowerCase(), btn);
}
TEXT_INPUT_MAP.set("u", "UP");
TEXT_INPUT_MAP.set("d", "DOWN");
TEXT_INPUT_MAP.set("l", "LEFT");
TEXT_INPUT_MAP.set("r", "RIGHT");

/* ── Events ─────────────────────────────────────────────────────── */

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready as ${c.user.tag}`);

  const rest = new REST().setToken(config.discord.token);
  await rest.put(
    Routes.applicationCommands(config.discord.clientId),
    { body: commandsData },
  );
  console.log(`Slash commands registered (${commandsData.length} commands)`);

  if (!config.gameboy.enabled) {
    console.log("[Pokemon] Disabled by POKEMON_ENABLED=false");
    return;
  }
  if (!config.gameboy.textInputEnabled) {
    console.log("[Pokemon] Text input disabled by POKEMON_TEXT_INPUT_ENABLED=false");
    return;
  }
  if (!config.discord.messageContentIntent) {
    console.log("[Pokemon] Text input disabled by DISCORD_MESSAGE_CONTENT_INTENT=false");
    return;
  }

  // Log game channel config for diagnostics
  const configuredChannelId = config.gameboy.gameChannelId;
  console.log(`[GB] Game channel ID configured: "${configuredChannelId || "(not set)"}"${!configuredChannelId ? " — text input will be DISABLED" : ""}`);

  // Pre-cache the game channel so we never fetch it during gameplay
  const gcId = config.gameboy.gameChannelId;
  if (gcId) {
    try {
      const ch = await client.channels.fetch(gcId);
      if (ch && "send" in ch) cachedGameChannel = ch as TextChannel;
    } catch { /* channel not found */ }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    console.log(`[Discord] Button interaction ${interaction.customId} from ${interaction.user.tag}`);
    const customId = interaction.customId;
    if (customId.startsWith("claim_drop_")) {
      await handleDropButton(interaction as ButtonInteraction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  console.log(`[Discord] Command /${interaction.commandName} from ${interaction.user.tag}`);
  const handler = commandMap.get(interaction.commandName);
  if (!handler) {
    console.warn(`[Discord] No handler registered for /${interaction.commandName}`);
    await interaction.reply({ content: "This command is not available right now.", ephemeral: true }).catch(() => {});
    return;
  }
  const { username, displayName, avatarUrl } = extractProfile(interaction as ChatInputCommandInteraction);
  updateUserProfile(interaction.user.id, username, displayName, avatarUrl).catch(() => {});
  try {
    await handler(interaction as ChatInputCommandInteraction);
  } catch (err) {
    // 10062 = Unknown Interaction: interaction token expired, typically from
    // pre-restart interactions re-delivered to the new instance. Not a real error.
    if ((err as { code?: number })?.code === 10062) return;
    console.error(`Command /${interaction.commandName} error:`, (err as Error)?.message ?? err);
    const msg = { content: "❌ Something went wrong.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

/* ────────────────────────────────────────────────────────────────── */
/*  Game Boy text input listener                                      */
/* ────────────────────────────────────────────────────────────────── */

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!config.gameboy.enabled) return;
  if (!config.gameboy.textInputEnabled) return;
  if (!config.discord.messageContentIntent) return;

  const gameChannelId = config.gameboy.gameChannelId;
  if (!gameChannelId || message.channelId !== gameChannelId) return;

  console.log(`[GB] Message in game channel: "${message.content}" from ${message.author.tag} (channel=${message.channelId})`);

  if (!message.content) {
    console.warn("[GB] message.content is empty — is the MESSAGE_CONTENT privileged intent enabled in the Discord Developer Portal?");
    return;
  }

  const parts = message.content.trim().toLowerCase().split(/\s+/);
  const button = TEXT_INPUT_MAP.get(parts[0]);
  if (!button) return; // not a valid input — ignore

  // Parse optional tip amount
  const minBid = config.gameboy.minBid;
  let amount = minBid;
  if (parts[1]) {
    const p = parseFloat(parts[1]);
    if (!isNaN(p) && p > 0) amount = Math.max(p, minBid);
  }

  // Check balance before accepting bid
  const balance = await getBalance(message.author.id);
  if (balance < amount) {
    return; // silent rejection — don't spam the channel
  }

  // Submit bid
  const result = submitBid(message.author.id, button, amount);
  if (!result.ok) return;

  // Ensure user has a deposit address (fire-and-forget, first time only)
  registerDepositAddress(message.author.id).catch(() => {});
});

/* ────────────────────────────────────────────────────────────────── */
/*  Democracy round resolution                                        */
/*  Charges are fire-and-forget. Feed updates throttled to 1/sec.     */
/*  NOTHING here blocks the emulator or event loop.                   */
/* ────────────────────────────────────────────────────────────────── */

let cachedGameChannel: TextChannel | null = null;
let feedMsg: Message | null = null;
let feedBusy = false;
let lastFeedTime = 0;
const FEED_THROTTLE_MS = 1000; // max 1 Discord message edit per second

function setupGameBoyCallbacks() {
  if (!config.gameboy.enabled) return;
  if (!config.gameboy.textInputEnabled) return;
  if (!config.discord.messageContentIntent) return;
  if (!config.gameboy.gameChannelId) return;

  onRound((result: RoundResult) => {
    const { winningButton, winners, winningSats, tally, totalBids } = result;

    // ── Charge all winning voters — fire and forget ──
    subtractBalances(
      winners.map((bid) => ({ discordId: bid.userId, amountSats: bid.amount }))
    ).catch(() => {});

    // ── Update feed message — throttled, non-blocking ──
    const now = Date.now();
    if (feedBusy || now - lastFeedTime < FEED_THROTTLE_MS) return;
    feedBusy = true;
    lastFeedTime = now;

    updateFeed(winningButton, winningSats, tally, totalBids)
      .catch(() => {})
      .finally(() => { feedBusy = false; });
  });
}

async function updateFeed(
  button: GBButton,
  sats: number,
  tally: RoundResult["tally"],
  totalBids: number,
) {
  if (!cachedGameChannel) return;

  const emoji = getButtonEmoji(button);
  let content = `${emoji} **${button}** — **${formatSats(sats)}** from ${totalBids} vote${totalBids !== 1 ? "s" : ""}`;

  if (tally.length > 1) {
    const breakdown = tally
      .map((v) => `${getButtonEmoji(v.button)} ${formatSats(v.totalSats)} (${v.voters.length})`)
      .join("  ");
    content += `\n${breakdown}`;
  }

  try {
    if (feedMsg) {
      await feedMsg.edit({ content, allowedMentions: { parse: [] } });
    } else {
      feedMsg = await cachedGameChannel.send({ content, allowedMentions: { parse: [] } });
    }
  } catch {
    // Message was deleted or errored — will create a new one next update
    feedMsg = null;
  }
}

/* ── Drop claim button handler ────────────────────────────────── */

async function handleDropButton(interaction: ButtonInteraction) {
  const dropId = parseInt(interaction.customId.replace("claim_drop_", ""), 10);
  if (isNaN(dropId)) return;

  await interaction.deferReply({ ephemeral: true });

  const member = interaction.guild
    ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
    : null;
  const claimantRoleIds = member ? [...member.roles.cache.keys()] : [];

  const result = await processClaim(dropId, interaction.user.id, claimantRoleIds);

  if (!result.ok) {
    await interaction.editReply({ content: `❌ ${result.error}` });
    return;
  }

  if (result.creatorId && typeof result.amountSats === "number") {
    await sendTransferReceivedDm({
      client: interaction.client,
      recipientId: interaction.user.id,
      senderId: result.creatorId,
      amountSats: result.amountSats,
      kind: "drop",
    });
  }

  const { data: drop } = await supabase
    .from("drops")
    .select("*")
    .eq("id", dropId)
    .single();

  if (drop) {
    const claimEmbed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle("🎉 Claimed!")
      .addFields(
        { name: "Amount", value: `**${formatSats(drop.per_claim_sats)}**`, inline: true },
        { name: "Remaining", value: `**${result.remaining}**`, inline: true },
      );

    await interaction.editReply({ embeds: [claimEmbed] });

    try {
      const claimedBy = await getClaimants(dropId);
      const embed = buildDropEmbed(drop as Drop, claimedBy);
      const row = buildClaimButton(dropId, result.completed);
      await interaction.message.edit({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error("Failed to update drop message:", (err as Error)?.message ?? err);
    }
  } else {
    const fallbackEmbed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle("🎉 Claimed!")
      .setDescription(`${result.remaining} claim${result.remaining === 1 ? "" : "s"} left`);

    await interaction.editReply({ embeds: [fallbackEmbed] });
  }
}

/* ── Main ─────────────────────────────────────────────────────── */

async function main() {
  // ── Web canvas server (start first — Render needs an open port quickly) ──
  await startStream();

  initEVM();
  console.log(`Treasury: ${getTreasuryAddress()}`);

  // Resolve any withdrawals left pending from a previous session
  recoverPendingWithdrawals().catch((err) =>
    console.error("[Recovery] Failed:", (err as Error)?.message ?? err)
  );

  startDepositPoller((discordId, amountSats, gasSats) => {
    console.log(`Auto-deposit: ${formatSats(amountSats)} (gas: ~${formatSats(gasSats)}) for ${discordId}`);
    client.users.fetch(discordId).then((u) => {
      const embed = new EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("✅ Deposit Received!")
        .addFields(
          { name: "Credited", value: `**${formatSats(amountSats)}**`, inline: true },
        );

      if (gasSats > 0) {
        embed.addFields(
          { name: "Gas Deducted", value: `~${formatSats(gasSats)}`, inline: true },
        );
      }

      embed.setFooter({ text: "Use /balance to check your total" });
      embed.setTimestamp();

      u.send({ embeds: [embed] }).catch(() => {});
    }).catch(() => {});
  });

  console.log(`[Discord] Logging in as application ${config.discord.clientId}...`);
  await Promise.race([
    client.login(config.discord.token),
    timeoutAfter(120_000, "Discord login"),
  ]);
  console.log("[Discord] Login call completed; waiting for gateway ready...");
  await waitForDiscordReady(120_000);
  console.log("[Discord] Gateway ready confirmed");

  if (!config.gameboy.enabled) {
    console.log("[Pokemon] POKEMON_ENABLED=false - emulator and controls disabled");
    return;
  }

  // ── Game Boy emulator ──
  const { romPath } = config.gameboy;
  if (romPath) {
    try {
      await startEmulator(romPath);
      setupGameBoyCallbacks();
    } catch (err) {
      console.error("[GameBoy] Failed to start:", (err as Error)?.message ?? err);
    }
  } else {
    console.log("[GameBoy] ROM_PATH not set — emulator disabled");
  }
}

// Graceful shutdown: save game state before exit
process.on("SIGINT", async () => {
  console.log("\n[Shutdown] Received SIGINT, saving game state...");
  await stopEmulator();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[Shutdown] Received SIGTERM, saving game state...");
  await stopEmulator();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
