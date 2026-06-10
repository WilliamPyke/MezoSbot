import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { config } from "../config.js";
import { formatSats } from "../format.js";
import { getBalance } from "../balance.js";
import {
  createMatch,
  fundEscrowFromBalance,
  getMatch,
  openOffers,
  setMatchMessage,
  topValidatedScores,
} from "../arcade/db.js";
import {
  enqueueDiscord,
  getMyQueueEntry,
  leaveQueue,
} from "../arcade/matchmaking.js";
import { issueMatchToken } from "../arcade/tokens.js";
import {
  buildMatchFeedComponents,
  buildMatchFeedEmbed,
} from "../arcade/ui.js";
import {
  STAKE_TIERS,
  DEFAULT_PLATFORM_RAKE_BPS,
} from "../arcade/economics.js";
import { replyInsufficientBalance } from "./responses.js";

const DEFAULT_ARCADE_DURATION_MINUTES = 3;
const MAX_ARCADE_DURATION_MINUTES = 5;

export const data = {
  name: "arcade",
  description: "Slice Arcade — block puzzle PvP for sats (plays in your browser)",
  options: [
    {
      type: 1 as const,
      name: "practice",
      description: "Play a solo match in your browser (no stake)",
      options: [
        {
          type: 10 as const,
          name: "minutes",
          description: "Match length in minutes (1-5, default 3)",
          required: false,
          minValue: 1,
          maxValue: MAX_ARCADE_DURATION_MINUTES,
        },
      ],
    },
    {
      type: 1 as const,
      name: "challenge",
      description: "Challenge another user — match plays in the browser",
      options: [
        {
          type: 6 as const,
          name: "user",
          description: "Opponent to challenge",
          required: true,
        },
        {
          type: 10 as const,
          name: "stake",
          description: "Sats to stake (omit for free PvP)",
          required: false,
          minValue: 0,
        },
        {
          type: 10 as const,
          name: "minutes",
          description: "Match length in minutes (1-5, default 3)",
          required: false,
          minValue: 1,
          maxValue: MAX_ARCADE_DURATION_MINUTES,
        },
      ],
    },
    {
      type: 1 as const,
      name: "offer",
      description: "Post an open match offer anyone can accept",
      options: [
        {
          type: 10 as const,
          name: "stake",
          description: "Sats to stake (omit for a free offer)",
          required: false,
          minValue: 0,
        },
        {
          type: 10 as const,
          name: "minutes",
          description: "Match length in minutes (1-5, default 3)",
          required: false,
          minValue: 1,
          maxValue: MAX_ARCADE_DURATION_MINUTES,
        },
      ],
    },
    {
      type: 1 as const,
      name: "tipfight",
      description: "Fight for your tip — only you stake; opponent must beat your score to win it",
      options: [
        {
          type: 10 as const,
          name: "stake",
          description: "Sats you stake (refunded if opponent doesn't beat you)",
          required: true,
          minValue: 1,
        },
        {
          type: 6 as const,
          name: "user",
          description: "Optional: challenge a specific player (omit for open lobby)",
          required: false,
        },
        {
          type: 10 as const,
          name: "minutes",
          description: "Match length in minutes (1-5, default 3)",
          required: false,
          minValue: 1,
          maxValue: MAX_ARCADE_DURATION_MINUTES,
        },
      ],
    },
    {
      type: 1 as const,
      name: "watch",
      description: "Get a live spectator link for an active arcade match",
      options: [
        {
          type: 4 as const,
          name: "match-id",
          description: "ID of the match to watch",
          required: true,
          minValue: 1,
        },
      ],
    },
    {
      type: 1 as const,
      name: "offers",
      description: "Browse open Slice Arcade match offers",
    },
    {
      type: 1 as const,
      name: "matchmake",
      description: "Join the global free PvP queue and play the next available opponent",
      options: [
        {
          type: 10 as const,
          name: "minutes",
          description: "Match length in minutes (1-5, default 3)",
          required: false,
          minValue: 1,
          maxValue: MAX_ARCADE_DURATION_MINUTES,
        },
      ],
    },
    {
      type: 1 as const,
      name: "leave-queue",
      description: "Leave the matchmaking queue",
    },
    {
      type: 1 as const,
      name: "help",
      description: "Slice Arcade command manual — all /arcade subcommands, with examples",
    },
    {
      type: 1 as const,
      name: "rules",
      description: "How Slice Arcade works",
    },
    {
      type: 1 as const,
      name: "tiers",
      description: "Show common stake tiers",
    },
    {
      type: 1 as const,
      name: "leaderboard",
      description: "Top validated scores",
    },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case "practice":
      return runPractice(interaction);
    case "challenge":
      return runChallenge(interaction);
    case "offer":
      return runOffer(interaction);
    case "tipfight":
      return runTipfight(interaction);
    case "watch":
      return runWatch(interaction);
    case "offers":
      return runOffers(interaction);
    case "matchmake":
      return runMatchmake(interaction);
    case "leave-queue":
      return runLeaveQueue(interaction);
    case "help":
      return runHelp(interaction);
    case "rules":
      return runRules(interaction);
    case "tiers":
      return runTiers(interaction);
    case "leaderboard":
      return runLeaderboard(interaction);
    default:
      return interaction.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
  }
}

/* ────────────────────────────────────────────────────────────────── */

export function buildPlayUrl(matchId: number, userId: string): string {
  const token = issueMatchToken(matchId, userId);
  const base = config.publicBaseUrl;
  return `${base}/arcade/play?t=${encodeURIComponent(token)}`;
}

/**
 * Discord Link buttons require an https:// (or http://) URL that's reachable
 * from the player's device. localhost falls back values are useful for local
 * dev but would 404 for anyone but the operator. Detect that here so we can
 * print the URL as plain text instead of trying to create a button Discord
 * will reject.
 */
function isPublicHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return false;
    return true;
  } catch {
    return false;
  }
}

function playLinkRow(url: string, label = "Open Slice Arcade") {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url)
  );
}

function describeBadUrl(): string {
  return [
    "⚠️ The bot is missing a public URL config — Discord won't accept a play-link button until it's set.",
    "",
    "Set the `PUBLIC_BASE_URL` env var on the host to the bot's public HTTPS URL, e.g. `https://mezosbot.example.com`, then redeploy.",
  ].join("\n");
}

/* ────────────────────────────────────────────────────────────────── */

function durationSeconds(interaction: ChatInputCommandInteraction): number {
  const minutes = interaction.options.getNumber("minutes") ?? DEFAULT_ARCADE_DURATION_MINUTES;
  const clamped = Math.max(1, Math.min(MAX_ARCADE_DURATION_MINUTES, minutes));
  return Math.round(clamped * 60);
}

function formatDuration(seconds: number): string {
  const minutes = seconds / 60;
  return Number.isInteger(minutes)
    ? `${minutes} minute${minutes === 1 ? "" : "s"}`
    : `${seconds} seconds`;
}

async function runPractice(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let match;
  const matchDurationSeconds = durationSeconds(interaction);
  try {
    match = await createMatch({
      mode: "practice",
      createdById: interaction.user.id,
      playerAId: interaction.user.id,
      durationSeconds: matchDurationSeconds,
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error("[Arcade] /arcade practice createMatch failed:", msg);
    await interaction.editReply({ content: `❌ Could not create match: ${msg}` });
    return;
  }

  const url = buildPlayUrl(match.id, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Practice match ready")
    .setDescription(
      `Match #${match.id} — open the link to play in your browser.\n\nTime limit: **${formatDuration(matchDurationSeconds)}**. This link is for you only and expires in a few hours.`
    );

  if (isPublicHttpsUrl(url)) {
    await interaction.editReply({ embeds: [embed], components: [playLinkRow(url, "Play in browser")] });
  } else {
    // Discord rejects http:// or localhost URLs in Link buttons. Fall back to
    // a plain-text URL so the operator can still test and see what's wrong.
    await interaction.editReply({
      content: `${describeBadUrl()}\n\nLink for this match (testing only):\n<${url}>`,
      embeds: [embed],
    });
  }
}

async function runChallenge(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser("user", true);
  const stake = interaction.options.getNumber("stake") ?? 0;
  const matchDurationSeconds = durationSeconds(interaction);

  if (target.id === interaction.user.id) {
    return interaction.reply({ content: "❌ You can't challenge yourself.", flags: MessageFlags.Ephemeral });
  }
  if (target.bot) {
    return interaction.reply({ content: "❌ Bots can't play.", flags: MessageFlags.Ephemeral });
  }

  const isStaked = stake > 0;
  if (isStaked) {
    const balance = await getBalance(interaction.user.id);
    if (balance < stake) {
      return replyInsufficientBalance(
        interaction,
        `❌ Insufficient balance. You need **${formatSats(stake)}** to challenge with this stake.`,
      );
    }
  }

  await interaction.deferReply();

  const match = await createMatch({
    mode: isStaked ? "staked_pvp" : "free_pvp",
    createdById: interaction.user.id,
    targetPlayerId: target.id,
    playerAId: interaction.user.id,
    playerBId: null,
    stakeAmountSats: isStaked ? stake : undefined,
    rakeBps: isStaked ? DEFAULT_PLATFORM_RAKE_BPS : 0,
    channelId: interaction.channelId ?? undefined,
    durationSeconds: matchDurationSeconds,
  });

  if (isStaked) {
    const fund = await fundEscrowFromBalance(match.id, interaction.user.id, stake);
    if (!fund.ok) {
      return replyInsufficientBalance(interaction, `❌ ${fund.error}`);
    }
  }

  const reply = await interaction.editReply({
    content: `<@${target.id}> — you've been challenged! Click **Accept** to start; the match will open in your browser. Time limit: **${formatDuration(matchDurationSeconds)}**.`,
    embeds: [buildMatchFeedEmbed(match)],
    components: buildMatchFeedComponents(match),
    allowedMentions: { users: [target.id] },
  });

  const channelId = interaction.channelId ?? "";
  const messageId = (reply as { id?: string }).id ?? "";
  if (channelId && messageId) {
    await setMatchMessage(match.id, channelId, messageId);
  }
}

async function runOffer(interaction: ChatInputCommandInteraction) {
  const stake = interaction.options.getNumber("stake") ?? 0;
  const matchDurationSeconds = durationSeconds(interaction);

  const isStaked = stake > 0;
  if (isStaked) {
    const balance = await getBalance(interaction.user.id);
    if (balance < stake) {
      return replyInsufficientBalance(
        interaction,
        `❌ Insufficient balance. You need **${formatSats(stake)}** to post this offer.`,
      );
    }
  }

  await interaction.deferReply();

  const match = await createMatch({
    mode: isStaked ? "staked_pvp" : "free_pvp",
    createdById: interaction.user.id,
    playerAId: interaction.user.id,
    playerBId: null,
    targetPlayerId: null,
    stakeAmountSats: isStaked ? stake : undefined,
    rakeBps: isStaked ? DEFAULT_PLATFORM_RAKE_BPS : 0,
    channelId: interaction.channelId ?? undefined,
    durationSeconds: matchDurationSeconds,
  });

  if (isStaked) {
    const fund = await fundEscrowFromBalance(match.id, interaction.user.id, stake);
    if (!fund.ok) {
      return replyInsufficientBalance(interaction, `❌ ${fund.error}`);
    }
  }

  const reply = await interaction.editReply({
    content: `Open Slice Arcade offer posted. First player to accept gets matched. Time limit: **${formatDuration(matchDurationSeconds)}**.`,
    embeds: [buildMatchFeedEmbed(match)],
    components: buildMatchFeedComponents(match),
  });

  const channelId = interaction.channelId ?? "";
  const messageId = (reply as { id?: string }).id ?? "";
  if (channelId && messageId) {
    await setMatchMessage(match.id, channelId, messageId);
  }
}

async function runTipfight(interaction: ChatInputCommandInteraction) {
  const stake = interaction.options.getNumber("stake", true);
  const target = interaction.options.getUser("user");
  const matchDurationSeconds = durationSeconds(interaction);

  if (stake <= 0) {
    return interaction.reply({ content: "❌ Stake must be greater than 0.", flags: MessageFlags.Ephemeral });
  }
  if (target) {
    if (target.id === interaction.user.id) {
      return interaction.reply({ content: "❌ You can't challenge yourself.", flags: MessageFlags.Ephemeral });
    }
    if (target.bot) {
      return interaction.reply({ content: "❌ Bots can't play.", flags: MessageFlags.Ephemeral });
    }
  }

  const balance = await getBalance(interaction.user.id);
  if (balance < stake) {
    return replyInsufficientBalance(
      interaction,
      `❌ Insufficient balance. You need **${formatSats(stake)}** to post this tipfight.`,
    );
  }

  await interaction.deferReply();

  const match = await createMatch({
    mode: "tipfight",
    createdById: interaction.user.id,
    playerAId: interaction.user.id,
    playerBId: null,
    targetPlayerId: target?.id ?? null,
    stakeAmountSats: stake,
    rakeBps: DEFAULT_PLATFORM_RAKE_BPS,
    channelId: interaction.channelId ?? undefined,
    durationSeconds: matchDurationSeconds,
  });

  const fund = await fundEscrowFromBalance(match.id, interaction.user.id, stake);
  if (!fund.ok) {
    return replyInsufficientBalance(interaction, `❌ ${fund.error}`);
  }

  const content = target
    ? `<@${target.id}> — **fight for the tip!** <@${interaction.user.id}> staked **${formatSats(stake)}**. Beat their score to win it; they get refunded if you don't. Time limit: **${formatDuration(matchDurationSeconds)}**.`
    : `**Fight for the tip posted!** <@${interaction.user.id}> staked **${formatSats(stake)}** — first player to accept and beat their score wins it. Refunded otherwise. Time limit: **${formatDuration(matchDurationSeconds)}**.`;

  const reply = await interaction.editReply({
    content,
    embeds: [buildMatchFeedEmbed(match)],
    components: buildMatchFeedComponents(match),
    allowedMentions: target ? { users: [target.id] } : undefined,
  });

  const channelId = interaction.channelId ?? "";
  const messageId = (reply as { id?: string }).id ?? "";
  if (channelId && messageId) {
    await setMatchMessage(match.id, channelId, messageId);
  }
}

export function buildWatchUrl(matchId: number): string {
  const base = config.publicBaseUrl;
  return `${base}/arcade/watch?match=${matchId}`;
}

async function runWatch(interaction: ChatInputCommandInteraction) {
  const matchId = interaction.options.getInteger("match-id", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const match = await getMatch(matchId);
  if (!match) {
    return interaction.editReply({ content: `❌ Match #${matchId} not found.` });
  }
  if (match.mode === "practice") {
    return interaction.editReply({ content: "❌ Practice matches can't be spectated." });
  }
  if (match.status === "waiting") {
    return interaction.editReply({ content: "⏳ That match hasn't started yet — wait for both players to be in." });
  }
  if (match.status === "cancelled") {
    return interaction.editReply({ content: "❌ That match was cancelled." });
  }

  const url = buildWatchUrl(matchId);
  const aId = match.player_a_id;
  const bId = match.player_b_id ?? "?";
  const aScore = match.player_a_score ?? 0;
  const bScore = match.player_b_score ?? 0;
  const summary = match.status === "completed"
    ? `Match #${matchId} (final): <@${aId}> ${aScore} vs <@${bId}> ${bScore}`
    : `Match #${matchId} live: <@${aId}> ${aScore} vs <@${bId}> ${bScore}`;

  if (isPublicHttpsUrl(url)) {
    await interaction.editReply({
      content: `${summary}\n\nWatch live in your browser:`,
      components: [playLinkRow(url, `Watch match #${matchId}`)],
    });
  } else {
    await interaction.editReply({
      content: `${describeBadUrl()}\n\n${summary}\nLink (testing only): <${url}>`,
    });
  }
}

async function runOffers(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const offers = (await openOffers(10))
    .filter((offer) => offer.player_a_id !== interaction.user.id)
    .slice(0, 5);

  if (offers.length === 0) {
    await interaction.editReply({
      content: "No open Slice Arcade offers right now. Post one with `/arcade offer stake:<amount>`.",
    });
    return;
  }

  const lines = offers.map((offer, i) => {
    const stake =
      offer.mode === "tipfight" && offer.stake_amount_sats != null
        ? `💰 Tipfight ${formatSats(offer.stake_amount_sats)}`
        : offer.mode === "staked_pvp" && offer.stake_amount_sats != null
          ? formatSats(offer.stake_amount_sats)
          : "Free";
    return `**${i + 1}. Match #${offer.id}** — ${stake} • ${formatDuration(offer.duration_seconds ?? 180)} • by <@${offer.player_a_id}>`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Open Slice Arcade Offers")
    .setDescription(lines.join("\n"));

  const components = offers.map((offer, i) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`arcade:accept:${offer.id}`)
        .setLabel(`Accept #${offer.id}`)
        .setStyle(i === 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
    )
  );

  await interaction.editReply({ embeds: [embed], components });
}

async function runHelp(interaction: ChatInputCommandInteraction) {
  const overview = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Slice Arcade — Command Manual")
    .setDescription(
      [
        "Block puzzle PvP for sats, played in your browser. Discord posts the match card; the game opens in a private link.",
        "",
        "**Quick start**",
        "• `/arcade practice` — solo, no stake. Best way to learn the controls.",
        "• `/arcade matchmake` — auto-pair with the next free PvP opponent.",
        "• `/arcade challenge user:@someone stake:100` — pick a fight (free or staked).",
        "• `/arcade tipfight stake:100` — *you* stake; opponent must beat you to win it.",
      ].join("\n")
    );

  const lobby = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Lobby & matchmaking")
    .addFields(
      {
        name: "/arcade practice [minutes]",
        value: "Solo browser match. `minutes` 1–5, default 3. No stake.",
      },
      {
        name: "/arcade challenge user:@x [stake] [minutes]",
        value: "Direct challenge. Omit `stake` for free PvP. Both players stake the same amount when staked; winner takes the pot minus rake.",
      },
      {
        name: "/arcade offer [stake] [minutes]",
        value: "Open lobby — first acceptor takes the match. Same stake rules as challenge.",
      },
      {
        name: "/arcade tipfight stake:<sats> [user] [minutes]",
        value:
          "**Fight for your tip.** Only you stake. Opponent plays free; they must **strictly beat** your score to win the stake. Tie or loss → full refund. Pass `user` to target someone, or omit for an open lobby.",
      },
      {
        name: "/arcade matchmake [minutes]",
        value: "Join the global free PvP queue. You'll be DM'd a play link as soon as a partner shows up.",
      },
      {
        name: "/arcade leave-queue",
        value: "Bail from the matchmaking queue.",
      },
      {
        name: "/arcade offers",
        value: "Browse the 5 most recent open offers and accept one.",
      }
    );

  const spectate = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Spectate, info & stats")
    .addFields(
      {
        name: "/arcade watch match-id:<id>",
        value: "Get a live spectator URL — both boards side-by-side, updating in real time. Active match cards also expose a 👁️ Watch button.",
      },
      {
        name: "/arcade rules",
        value: "How scoring, multipliers, levels, and combos work.",
      },
      {
        name: "/arcade tiers",
        value: "Common stake tiers + rake breakdown.",
      },
      {
        name: "/arcade leaderboard",
        value: "Top validated scores across all matches.",
      },
      {
        name: "/arcade help",
        value: "This page.",
      }
    );

  const supporting = new EmbedBuilder()
    .setColor(0x444c5a)
    .setTitle("Wallet & tipping (related commands)")
    .setDescription(
      [
        "Stakes and payouts settle through your MezoSBot sats balance.",
        "",
        "• `/balance` — check your sats balance.",
        "• `/deposit` — top up.",
        "• `/withdraw` — pull sats out.",
        "• `/tip @user amount` — send sats to another user.",
        "• `/history` — recent transactions.",
      ].join("\n")
    );

  await interaction.reply({
    embeds: [overview, lobby, spectate, supporting],
    flags: MessageFlags.Ephemeral,
  });
}

async function runRules(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Slice Arcade — Rules")
    .setDescription(
      [
        "**Head-to-head block puzzle, played in your browser.** Discord starts the match; both players open a private link to play.",
        "",
        "**Same shapes** — both players receive the exact same seeded piece sequence. Highest validated score wins.",
        "",
        "**Board** — 9×9 grid. Place blocks to fill rows, columns, or 3×3 squares. Filled zones clear and score points.",
        "",
        "**Levels** — 12 levels per match. Each level deals 3 pieces; place them in any order. Match ends if no remaining piece fits.",
        "",
        "**Timer** — matches default to 3 minutes. The best validated score wins when time expires. Use `/arcade practice minutes:5` or `/arcade challenge ... minutes:5` for longer games, up to 5 minutes.",
        "",
        "**Scoring** — +10 per placed cell, +25 per cleared row/column/3×3 square, +25 per extra zone in a combo.",
        "",
        "**Multiplier** — 🟧 multiplier blocks raise your multiplier when you *clear* them (not just place them). Cap is 5×.",
        "",
        "**Stakes** — for staked matches, both players put in the same sats. The winner receives the listed payout. Tie refunds both stakes.",
      ].join("\n")
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function runTiers(interaction: ChatInputCommandInteraction) {
  const lines = STAKE_TIERS.map((stake) => {
    const grossPot = stake * 2;
    return `**${formatSats(stake)}** stake → pot ${formatSats(grossPot)}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Stake tiers")
    .setDescription(
      [
        "Each player stakes the same amount. Ties refund both stakes.",
        "",
        ...lines,
        "",
        "Use `/arcade challenge @user stake:<amount>` or `/arcade offer stake:<amount>` to start a staked match. Any stake above 0 is allowed (these are convenience tiers).",
      ].join("\n")
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function runMatchmake(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const matchDurationSeconds = durationSeconds(interaction);

  const existing = await getMyQueueEntry("discord", interaction.user.id);
  if (existing && existing.status === "waiting") {
    return interaction.editReply({
      content: "You're already in the matchmaking queue. Use `/arcade leave-queue` to cancel.",
    });
  }

  let result;
  try {
    result = await enqueueDiscord({
      userId: interaction.user.id,
      durationSeconds: matchDurationSeconds,
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error("[Arcade] matchmake enqueue failed:", msg);
    return interaction.editReply({ content: `❌ Could not join queue: ${msg}` });
  }

  if (!result.ok) {
    return interaction.editReply({ content: `❌ ${result.error}` });
  }

  if (result.status === "waiting") {
    const embed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle("In matchmaking queue")
      .setDescription(
        [
          "You'll be DM'd a private play link as soon as another player joins.",
          "",
          `Match length when paired: **${formatDuration(matchDurationSeconds)}**.`,
          "Your queue entry expires after 5 minutes — re-run `/arcade matchmake` to keep waiting.",
          "",
          "Want to bail? Run `/arcade leave-queue`.",
        ].join("\n")
      );
    return interaction.editReply({ embeds: [embed] });
  }

  // status === "paired" — both players just got matched. Reply to the joiner
  // (the user) with their play link, and DM the opponent (the original
  // waiter) theirs.
  const { match, opponentId } = result;
  const url = buildPlayUrl(match.id, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Match found!")
    .setDescription(
      [
        `You vs <@${opponentId}> — match #${match.id} starts now.`,
        "",
        `Time limit: **${formatDuration(match.duration_seconds ?? matchDurationSeconds)}**.`,
        "Open the link below to play in your browser. *This link is for you only.*",
      ].join("\n")
    );

  if (isPublicHttpsUrl(url)) {
    await interaction.editReply({ embeds: [embed], components: [playLinkRow(url, "Open browser playfield")] });
  } else {
    await interaction.editReply({
      content: `${describeBadUrl()}\n\nLink for this match (testing only):\n<${url}>`,
      embeds: [embed],
    });
  }

  // Best-effort DM to the opponent. If DMs are closed they can run /arcade
  // matchmake again to re-find the match (it's already created in the DB,
  // but we only surface it via the DM right now). Worth improving later.
  void sendMatchmakeDm(interaction.client, match.id, opponentId, interaction.user.id);
}

async function runLeaveQueue(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const left = await leaveQueue("discord", interaction.user.id);
  await interaction.editReply({
    content: left
      ? "✅ Left the matchmaking queue."
      : "You weren't in the queue.",
  });
}

async function sendMatchmakeDm(
  client: ChatInputCommandInteraction["client"],
  matchId: number,
  recipientId: string,
  opponentId: string
) {
  try {
    const user = await client.users.fetch(recipientId);
    const url = buildPlayUrl(matchId, recipientId);
    const embed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle(`Slice Arcade — Match #${matchId} found!`)
      .setDescription(
        `Matched with <@${opponentId}>. Open the link to play in your browser. *This link is for you only.*`
      );
    if (isPublicHttpsUrl(url)) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("Open browser playfield").setStyle(ButtonStyle.Link).setURL(url)
      );
      await user.send({ embeds: [embed], components: [row] });
    } else {
      await user.send({ content: `Match #${matchId} is ready. Link: <${url}>`, embeds: [embed] });
    }
  } catch {
    // DMs closed — opponent can re-queue or check /arcade matchmake again.
  }
}

async function runLeaderboard(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rows = await topValidatedScores(10);
  const lines = rows.length
    ? rows.map(
        (r, i) =>
          `**${i + 1}.** <@${r.user_id}> — ${(r.validated_score ?? 0).toLocaleString()} pts (match #${r.match_id})`
      )
    : ["*No validated scores yet — be the first to play.*"];
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Slice Arcade — Top scores")
    .setDescription(lines.join("\n"));
  await interaction.editReply({ embeds: [embed] });
}
