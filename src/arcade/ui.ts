import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";

type ActionRowJSON = ReturnType<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>["toJSON"]>;
import { BOARD_SIZE, PIECES_PER_LEVEL, MAX_LEVELS, type PlayerState } from "./types.js";
import { rotateCells } from "./pieces.js";
import {
  renderBoard,
  renderPiecePreview,
  pieceShortLabel,
  coordLabel,
} from "./render.js";
import type { MatchRuntime } from "./runtime.js";
import type { Selection } from "./selection.js";
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

/* ─────────── Playfield (ephemeral, per-player) ─────────── */

export function buildPlayfieldEmbed(
  match: ArcadeMatchRow,
  state: PlayerState,
  runtime: MatchRuntime,
  selection: Selection
): EmbedBuilder {
  const pieces = runtime.sequence[Math.min(state.level, MAX_LEVELS - 1)];
  const selectedPiece = selection.pieceIndex != null ? pieces[selection.pieceIndex] : null;
  const rotatedCells = selectedPiece
    ? rotateCells(selectedPiece.cells, selection.rotation)
    : null;

  const ghost =
    rotatedCells && selection.row != null && selection.col != null
      ? { cells: rotatedCells, row: selection.row, col: selection.col }
      : undefined;

  const board = renderBoard(state.board, { ghost, showLabels: true });

  const piecesField = pieces
    .map((p, i) => {
      const used = state.placedThisLevel[i] ? " ❌" : "";
      const sel = selection.pieceIndex === i ? " ◀" : "";
      return `**${i + 1}.** ${pieceShortLabel(p.cells)}${used}${sel}\n${renderPiecePreview(
        p.cells
      )}`;
    })
    .join("\n\n");

  const modeLabel = match.mode === "practice"
    ? "Practice"
    : match.mode === "free_pvp"
      ? "Free PvP"
      : `Stake ${formatSats(match.stake_amount_sats ?? 0)}`;

  const embed = new EmbedBuilder()
    .setColor(state.phase === "finished" ? 0xff9900 : 0x00cc6a)
    .setTitle(`Slice Arcade — ${modeLabel} #${match.id}`)
    .setDescription(board)
    .addFields(
      { name: "Score", value: `**${state.score.toLocaleString()}**`, inline: true },
      { name: "Multiplier", value: `${state.multiplier}×`, inline: true },
      { name: "Level", value: `${Math.min(state.level + 1, MAX_LEVELS)}/${MAX_LEVELS}`, inline: true },
      { name: "Pieces", value: piecesField, inline: false }
    );

  if (selection.pieceIndex != null) {
    const target =
      selection.row != null && selection.col != null
        ? coordLabel(selection.row, selection.col)
        : "(pick row + col)";
    embed.addFields({
      name: "Selection",
      value: `Piece ${selection.pieceIndex + 1} • rotation ${selection.rotation * 90}° • target ${target}`,
    });
  }

  if (state.phase === "finished") {
    const reason = state.endReason === "no_moves" ? "no legal moves" : "all 12 levels complete";
    embed.addFields({
      name: "Match over",
      value: `Final score: **${state.score.toLocaleString()}** — ${reason}`,
    });
  }

  return embed;
}

export function buildPlayfieldComponents(
  matchId: number,
  state: PlayerState,
  runtime: MatchRuntime,
  selection: Selection
): ActionRowJSON[] {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (state.phase === "finished") {
    const submit = new ButtonBuilder()
      .setCustomId(cid("submit", matchId))
      .setLabel("Submit final score")
      .setStyle(ButtonStyle.Success);
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(submit));
    return rows.map((r) => r.toJSON() as ActionRowJSON);
  }

  // Row 1: piece buttons + rotate
  const pieces = runtime.sequence[Math.min(state.level, MAX_LEVELS - 1)];
  const pieceRow = new ActionRowBuilder<ButtonBuilder>();
  for (let i = 0; i < PIECES_PER_LEVEL; i++) {
    const used = state.placedThisLevel[i];
    const selected = selection.pieceIndex === i;
    pieceRow.addComponents(
      new ButtonBuilder()
        .setCustomId(cid("p", matchId, i))
        .setLabel(`Piece ${i + 1}`)
        .setStyle(used ? ButtonStyle.Secondary : selected ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(used)
    );
  }

  const rotateAllowed =
    selection.pieceIndex != null
      ? // Look up the piece's allowRotation flag indirectly via cells — we let any piece rotate.
        true
      : false;
  pieceRow.addComponents(
    new ButtonBuilder()
      .setCustomId(cid("rot", matchId))
      .setLabel("Rotate")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!rotateAllowed)
  );
  rows.push(pieceRow);

  // Row 2: row select
  const rowMenu = new StringSelectMenuBuilder()
    .setCustomId(cid("row", matchId))
    .setPlaceholder(selection.row != null ? `Row: ${"ABCDEFGHI"[selection.row]}` : "Pick row…");
  for (let r = 0; r < BOARD_SIZE; r++) {
    rowMenu.addOptions({
      label: `Row ${"ABCDEFGHI"[r]}`,
      value: String(r),
      default: selection.row === r,
    });
  }
  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(rowMenu));

  // Row 3: col select
  const colMenu = new StringSelectMenuBuilder()
    .setCustomId(cid("col", matchId))
    .setPlaceholder(selection.col != null ? `Col: ${selection.col + 1}` : "Pick column…");
  for (let c = 0; c < BOARD_SIZE; c++) {
    colMenu.addOptions({
      label: `Col ${c + 1}`,
      value: String(c),
      default: selection.col === c,
    });
  }
  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(colMenu));

  // Row 4: place + reset + end-now
  const placeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid("place", matchId))
      .setLabel("Place")
      .setStyle(ButtonStyle.Success)
      .setDisabled(
        selection.pieceIndex == null || selection.row == null || selection.col == null
      ),
    new ButtonBuilder()
      .setCustomId(cid("reset", matchId))
      .setLabel("Clear selection")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid("end", matchId))
      .setLabel("End match now")
      .setStyle(ButtonStyle.Danger)
  );
  rows.push(placeRow);

  return rows.map((r) => r.toJSON() as ActionRowJSON);
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
      { name: "Status", value: humanStatus(match), inline: true }
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
          .setLabel("Play / view your board")
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
