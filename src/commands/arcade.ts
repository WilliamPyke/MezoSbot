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
  setMatchMessage,
  topValidatedScores,
} from "../arcade/db.js";
import { issueMatchToken } from "../arcade/tokens.js";
import {
  buildMatchFeedComponents,
  buildMatchFeedEmbed,
} from "../arcade/ui.js";
import {
  STAKE_TIERS,
  describeRakeTier,
  DEFAULT_PLATFORM_RAKE_BPS,
} from "../arcade/economics.js";

export const data = {
  name: "arcade",
  description: "Slice Arcade — block puzzle PvP for sats (plays in your browser)",
  options: [
    {
      type: 1 as const,
      name: "practice",
      description: "Play a solo match in your browser (no stake)",
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
      ],
    },
    {
      type: 1 as const,
      name: "rules",
      description: "How Slice Arcade works",
    },
    {
      type: 1 as const,
      name: "tiers",
      description: "Show stake tiers and rake math",
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

function playLinkRow(url: string, label = "Open Slice Arcade") {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url)
  );
}

/* ────────────────────────────────────────────────────────────────── */

async function runPractice(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const match = await createMatch({
    mode: "practice",
    createdById: interaction.user.id,
    playerAId: interaction.user.id,
  });
  const url = buildPlayUrl(match.id, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Practice match ready")
    .setDescription(
      `Match #${match.id} — open the link to play in your browser.\n\nThis link is for you only and expires in a few hours.`
    );
  await interaction.editReply({ embeds: [embed], components: [playLinkRow(url, "Play in browser")] });
}

async function runChallenge(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser("user", true);
  const stake = interaction.options.getNumber("stake") ?? 0;

  if (target.id === interaction.user.id) {
    return interaction.reply({ content: "❌ You can't challenge yourself.", flags: MessageFlags.Ephemeral });
  }
  if (target.bot) {
    return interaction.reply({ content: "❌ Bots can't play.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const isStaked = stake > 0;
  if (isStaked) {
    const balance = await getBalance(interaction.user.id);
    if (balance < stake) {
      return interaction.editReply({
        content: `❌ Insufficient balance. You need **${formatSats(stake)}** to challenge with this stake.`,
      });
    }
  }

  const match = await createMatch({
    mode: isStaked ? "staked_pvp" : "free_pvp",
    createdById: interaction.user.id,
    playerAId: interaction.user.id,
    playerBId: null,
    stakeAmountSats: isStaked ? stake : undefined,
    rakeBps: isStaked ? DEFAULT_PLATFORM_RAKE_BPS : 0,
    channelId: interaction.channelId ?? undefined,
  });

  if (isStaked) {
    const fund = await fundEscrowFromBalance(match.id, interaction.user.id, stake);
    if (!fund.ok) {
      return interaction.editReply({ content: `❌ ${fund.error}` });
    }
  }

  const reply = await interaction.editReply({
    content: `<@${target.id}> — you've been challenged! Click **Accept** to start; the match will open in your browser.`,
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
        "**Scoring** — +10 per placed cell, +25 per cleared row/column/3×3 square, +25 per extra zone in a combo.",
        "",
        "**Multiplier** — 🟧 multiplier blocks raise your multiplier when you *clear* them (not just place them). Cap is 5×.",
        "",
        "**Stakes** — for staked matches, both players put in the same sats. Winner receives gross pot minus 10% platform fee. Tie refunds both stakes.",
      ].join("\n")
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function runTiers(interaction: ChatInputCommandInteraction) {
  const lines = STAKE_TIERS.map((stake) => {
    const t = describeRakeTier(stake);
    return `**${formatSats(t.stakeSats)}** stake → pot ${formatSats(t.grossPot)} • fee ${formatSats(t.rake)} • winner ${formatSats(t.winnerPayout)}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Stake tiers")
    .setDescription(
      [
        "Each player stakes the same amount. The winner receives the full pot minus a 10% platform fee. Ties refund both stakes.",
        "",
        ...lines,
        "",
        "Use `/arcade challenge @user stake:<amount>` to start a staked match. Any stake above 0 is allowed (these are convenience tiers).",
      ].join("\n")
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
