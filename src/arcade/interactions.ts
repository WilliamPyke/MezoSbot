import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type TextChannel,
} from "discord.js";
import {
  fundEscrowFromBalance,
  getMatch,
  joinMatch,
  refundAllEscrow,
  type ArcadeMatchRow,
} from "./db.js";
import { ensureRuntime } from "./runtime.js";
import {
  CUSTOM_ID_PREFIX,
  buildMatchFeedComponents,
  buildMatchFeedEmbed,
  parseCid,
} from "./ui.js";
import { issueMatchToken } from "./tokens.js";
import { config } from "../config.js";
import { supabase } from "../db.js";

type ArcadeInteraction = ButtonInteraction;

export function isArcadeInteraction(interaction: Interaction): boolean {
  if (interaction.isButton()) {
    return interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
  }
  return false;
}

export async function handleArcadeInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton()) return;
  const parsed = parseCid(interaction.customId);
  if (!parsed) return;

  const { action, parts } = parsed;

  // Ack within Discord's 3s window. "play" creates a fresh ephemeral reply
  // (the per-user browser link); accept/cancel mutate the public match feed.
  try {
    if (!interaction.deferred && !interaction.replied) {
      if (action === "play") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      } else {
        await interaction.deferUpdate();
      }
    }
  } catch (err) {
    if ((err as { code?: number })?.code === 10062) return;
    console.error(`[Arcade] Defer failed for ${action}:`, (err as Error)?.message ?? err);
    return;
  }

  try {
    switch (action) {
      case "accept":
        return await handleAccept(interaction, +parts[0]);
      case "cancel":
        return await handleCancel(interaction, +parts[0]);
      case "play":
        return await handlePlay(interaction, +parts[0]);
      default:
        // Older in-Discord game-action ids (p/rot/row/col/place/reset/end/submit)
        // are no longer supported — gameplay moved to the browser. Tell the
        // clicker to fetch a new link.
        await interaction
          .followUp({
            content:
              "ℹ️ Slice Arcade now plays in your browser. Click **Open browser playfield** on the match card to get your link.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
    }
  } catch (err) {
    if ((err as { code?: number })?.code === 10062) return;
    const message = (err as Error)?.message ?? String(err);
    console.error(`[Arcade] Interaction ${action} failed:`, message);
    await interaction
      .followUp({ content: `❌ ${message}`, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
}

/* ─────────── Lobby ─────────── */

async function handleAccept(interaction: ButtonInteraction, matchId: number) {
  const match = await getMatch(matchId);
  if (!match) return reply(interaction, "Match not found.");
  if (match.status !== "waiting") return reply(interaction, "Match is no longer waiting.");
  if (match.player_a_id === interaction.user.id)
    return reply(interaction, "You created this match — wait for someone else to accept.");

  if (match.mode === "staked_pvp" && match.stake_amount_sats != null) {
    const fund = await fundEscrowFromBalance(matchId, interaction.user.id, match.stake_amount_sats);
    if (!fund.ok) return reply(interaction, fund.error ?? "Could not fund escrow.");
  }

  const join = await joinMatch(matchId, interaction.user.id);
  if (!join.ok || !join.match) {
    if (match.mode === "staked_pvp") await refundAllEscrow(matchId);
    return reply(interaction, join.error ?? "Could not join match.");
  }

  const updated = join.match;
  ensureRuntime(updated.id, updated.seed, [updated.player_a_id, updated.player_b_id!]);

  await interaction.editReply({
    content: `<@${updated.player_a_id}> vs <@${updated.player_b_id}> — match is live. Open the browser playfield to play.`,
    embeds: [buildMatchFeedEmbed(updated)],
    components: buildMatchFeedComponents(updated),
    allowedMentions: { users: [updated.player_a_id, updated.player_b_id!] },
  });

  // DM each player a personal play link so they don't have to click the public
  // button. Best-effort — fall back to the public button if DMs are closed.
  void sendPlayLinkDm(interaction.client, updated.id, updated.player_a_id);
  void sendPlayLinkDm(interaction.client, updated.id, updated.player_b_id!);
}

async function handleCancel(interaction: ButtonInteraction, matchId: number) {
  const match = await getMatch(matchId);
  if (!match) return reply(interaction, "Match not found.");
  if (match.created_by_id !== interaction.user.id)
    return reply(interaction, "Only the challenger can cancel.");
  if (match.status !== "waiting")
    return reply(interaction, "Match cannot be cancelled — already in progress.");

  if (match.mode === "staked_pvp") await refundAllEscrow(matchId);
  else
    await supabase
      .from("arcade_matches")
      .update({ status: "cancelled" })
      .eq("id", matchId);

  const refreshed = (await getMatch(matchId))!;
  await interaction.editReply({
    embeds: [buildMatchFeedEmbed(refreshed)],
    components: buildMatchFeedComponents(refreshed),
  });
}

async function handlePlay(interaction: ButtonInteraction, matchId: number) {
  const match = await getMatch(matchId);
  if (!match) return reply(interaction, "Match not found.");
  if (![match.player_a_id, match.player_b_id].includes(interaction.user.id))
    return reply(interaction, "You're not a player in this match.");

  // Make sure runtime exists so the first /arcade/api/state is fast.
  const playerIds = [match.player_a_id, match.player_b_id!].filter(Boolean) as string[];
  ensureRuntime(matchId, match.seed, playerIds);

  const url = buildPlayUrl(matchId, interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle("Your private playfield link")
    .setDescription(
      `Open the link below to play match #${matchId} in your browser.\n\n*This link is for you only and expires in a few hours. Don't share it.*`
    );

  if (isPublicHttpsUrl(url)) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel("Open browser playfield").setStyle(ButtonStyle.Link).setURL(url)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else {
    await interaction.editReply({
      content: `⚠️ The bot is missing \`PUBLIC_BASE_URL\` — set it to the bot's public HTTPS URL on the host and redeploy.\n\nLink for this match (testing only):\n\`${url}\``,
      embeds: [embed],
    });
  }
}

/* ─────────── Helpers ─────────── */

function buildPlayUrl(matchId: number, userId: string): string {
  const token = issueMatchToken(matchId, userId);
  return `${config.publicBaseUrl}/arcade/play?t=${encodeURIComponent(token)}`;
}

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

async function sendPlayLinkDm(client: Client, matchId: number, userId: string) {
  try {
    const user = await client.users.fetch(userId);
    const url = buildPlayUrl(matchId, userId);
    const embed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle(`Slice Arcade — Match #${matchId} ready`)
      .setDescription(
        "Your match is live. Open the link to play in your browser. *This link is for you only.*"
      );
    if (isPublicHttpsUrl(url)) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("Open browser playfield").setStyle(ButtonStyle.Link).setURL(url)
      );
      await user.send({ embeds: [embed], components: [row] });
    } else {
      await user.send({ content: `Match #${matchId} is ready. Link: \`${url}\``, embeds: [embed] });
    }
  } catch {
    // DMs closed or fetch failed — ignore. The user can still click the
    // public "Open browser playfield" button.
  }
}

async function reply(interaction: ArcadeInteraction, content: string) {
  await interaction
    .followUp({ content: `❌ ${content}`, flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

/* ─────────── Match feed updater (used by web settle hook) ─────────── */

export async function updateMatchFeed(client: Client, match: ArcadeMatchRow): Promise<void> {
  if (!match.channel_id || !match.message_id) return;
  try {
    const channel = (await client.channels.fetch(match.channel_id)) as TextChannel | null;
    if (!channel || !("messages" in channel)) return;
    const msg = await channel.messages.fetch(match.message_id);
    await msg.edit({
      embeds: [buildMatchFeedEmbed(match)],
      components: buildMatchFeedComponents(match) ?? [],
    });
  } catch (err) {
    console.warn("[Arcade] Failed to update match feed:", (err as Error)?.message ?? err);
  }
}
