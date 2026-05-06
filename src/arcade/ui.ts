import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

type ActionRowJSON = ReturnType<ActionRowBuilder<ButtonBuilder>["toJSON"]>;
import type { ArcadeMatchRow } from "./db.js";
import { formatSats } from "../format.js";

export const CUSTOM_ID_PREFIX = "arcade";

/* ─────────── Custom-ID helpers ─────────── */

export function cid(action: string, ...parts: (string | number)[]): string {
  return [CUSTOM_ID_PREFIX, action, ...parts].join(":");
}

export function parseCid(customId: string): { action: string; parts: string[] } | null {
  const [prefix, action, ...parts] = customId.split(":");
  if (prefix !== CUSTOM_ID_PREFIX) return null;
  return { action, parts };
}

/* ─────────── Public match feed (channel announcement) ─────────── */

export function buildMatchFeedEmbed(match: ArcadeMatchRow): EmbedBuilder {
  const tier =
    match.mode === "practice"
      ? "Practice (solo)"
      : match.mode === "free_pvp"
        ? "Free PvP"
        : `Stake ${formatSats(match.stake_amount_sats ?? 0)}`;

  const embed = new EmbedBuilder()
    .setColor(0x00cc6a)
    .setTitle(`Slice Arcade — Match #${match.id}`)
    .addFields(
      { name: "Mode", value: tier, inline: true },
      { name: "Status", value: humanStatus(match), inline: true },
      { name: "Where", value: "Plays in your browser", inline: true }
    );

  if (match.mode === "staked_pvp" && match.stake_amount_sats != null) {
    embed.addFields(
      { name: "Stake (each)", value: formatSats(match.stake_amount_sats), inline: true },
      { name: "Gross pot", value: formatSats(match.gross_pot_sats ?? 0), inline: true },
      { name: "Platform fee", value: `${formatSats(match.rake_amount_sats ?? 0)} (${(match.platform_rake_bps / 100).toFixed(1)}%)`, inline: true },
      { name: "Winner receives", value: formatSats(match.winner_payout_sats ?? 0), inline: true }
    );
  }

  embed.addFields({
    name: "Players",
    value: `<@${match.player_a_id}>${match.player_b_id ? `\nvs <@${match.player_b_id}>` : "\n*waiting for opponent*"}`,
  });

  if (match.status === "completed") {
    const aScore = match.player_a_score ?? 0;
    const bScore = match.player_b_score ?? 0;
    const result = match.winner_id
      ? `🏆 <@${match.winner_id}> wins`
      : "🤝 Tie";
    embed.addFields({
      name: "Result",
      value: `${result}\n<@${match.player_a_id}>: **${aScore.toLocaleString()}** vs <@${match.player_b_id}>: **${bScore.toLocaleString()}**`,
    });
  } else if (match.player_a_submitted || match.player_b_submitted) {
    embed.addFields({
      name: "Submissions",
      value: `${match.player_a_submitted ? "✅" : "⏳"} <@${match.player_a_id}>${match.player_b_id ? `\n${match.player_b_submitted ? "✅" : "⏳"} <@${match.player_b_id}>` : ""}`,
    });
  }

  return embed;
}

export function buildMatchFeedComponents(
  match: ArcadeMatchRow
): ActionRowJSON[] | undefined {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  if (match.status === "waiting") {
    const acceptStyle =
      match.mode === "staked_pvp" ? ButtonStyle.Primary : ButtonStyle.Success;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(cid("accept", match.id))
          .setLabel(
            match.mode === "staked_pvp"
              ? `Accept (stake ${formatSats(match.stake_amount_sats ?? 0)})`
              : "Accept challenge"
          )
          .setStyle(acceptStyle),
        new ButtonBuilder()
          .setCustomId(cid("cancel", match.id))
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger)
      )
    );
  } else if (match.status === "active" || match.status === "submitted") {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(cid("play", match.id))
          .setLabel("Open browser playfield")
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  if (rows.length === 0) return undefined;
  return rows.map((r) => r.toJSON() as ActionRowJSON);
}

function humanStatus(match: ArcadeMatchRow): string {
  switch (match.status) {
    case "waiting":
      return "⏳ Waiting for opponent";
    case "active":
      return "🎮 Live";
    case "submitted":
      return "📝 Awaiting last submission";
    case "completed":
      return "🏁 Complete";
    case "cancelled":
      return "❌ Cancelled";
    default:
      return match.status;
  }
}
