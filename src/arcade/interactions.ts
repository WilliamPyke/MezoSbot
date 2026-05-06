import {
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import {
  fundEscrowFromBalance,
  getMatch,
  joinMatch,
  recordSubmission,
  refundAllEscrow,
  trySettleMatch,
  type ArcadeMatchRow,
} from "./db.js";
import {
  applyMoveForPlayer,
  clearRuntime,
  ensureRuntime,
  getRuntime,
  rebuildState,
  type MatchRuntime,
} from "./runtime.js";
import {
  CUSTOM_ID_PREFIX,
  buildMatchFeedComponents,
  buildMatchFeedEmbed,
  buildPlayfieldComponents,
  buildPlayfieldEmbed,
  parseCid,
} from "./ui.js";
import {
  clearSelection,
  getSelection,
  resetSelection,
  setSelection,
} from "./selection.js";
import { formatSats } from "../format.js";
import { supabase } from "../db.js";
import type { Move } from "./types.js";

type ArcadeInteraction = ButtonInteraction | StringSelectMenuInteraction;

export function isArcadeInteraction(interaction: Interaction): boolean {
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    return interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
  }
  return false;
}

export async function handleArcadeInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  const parsed = parseCid(interaction.customId);
  if (!parsed) return;

  const { action, parts } = parsed;

  // Ack within Discord's 3s window before doing any DB work. "play" creates a
  // new ephemeral playfield reply; every other action mutates the existing
  // message. Deferring here gives us 15 minutes to finish.
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
        return await handleAccept(interaction as ButtonInteraction, +parts[0]);
      case "cancel":
        return await handleCancel(interaction as ButtonInteraction, +parts[0]);
      case "play":
        return await handlePlay(interaction as ButtonInteraction, +parts[0]);
      case "p":
        return await handlePickPiece(interaction as ButtonInteraction, +parts[0], +parts[1]);
      case "rot":
        return await handleRotate(interaction as ButtonInteraction, +parts[0]);
      case "row":
        return await handleSelectRow(interaction as StringSelectMenuInteraction, +parts[0]);
      case "col":
        return await handleSelectCol(interaction as StringSelectMenuInteraction, +parts[0]);
      case "place":
        return await handlePlace(interaction as ButtonInteraction, +parts[0]);
      case "reset":
        return await handleReset(interaction as ButtonInteraction, +parts[0]);
      case "end":
      case "submit":
        return await handleSubmit(interaction as ButtonInteraction, +parts[0]);
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

  // For staked matches, debit before locking the slot so we don't reserve without paying.
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
    embeds: [buildMatchFeedEmbed(updated)],
    components: buildMatchFeedComponents(updated),
  });
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

  const playerIds = [match.player_a_id, match.player_b_id!].filter(Boolean) as string[];
  let runtime = getRuntime(matchId);
  if (!runtime) {
    runtime = ensureRuntime(matchId, match.seed, playerIds);
    const { data: subs } = await supabase
      .from("arcade_submissions")
      .select("user_id, move_log")
      .eq("match_id", matchId);
    for (const sub of subs ?? []) {
      try {
        const restored = rebuildState(match.seed, (sub.move_log as Move[]) ?? []);
        runtime.players.set(sub.user_id, restored);
      } catch {
        // If replay fails (corrupted log), skip — player will see fresh state.
      }
    }
  }

  const state = runtime.players.get(interaction.user.id)!;
  const selection = getSelection(matchId, interaction.user.id);
  await interaction.editReply({
    embeds: [buildPlayfieldEmbed(match, state, runtime, selection)],
    components: buildPlayfieldComponents(matchId, state, runtime, selection),
  });
}

/* ─────────── Selection ─────────── */

async function handlePickPiece(
  interaction: ButtonInteraction,
  matchId: number,
  pieceIndex: number
) {
  const ctx = await ensureContext(interaction, matchId);
  if (!ctx) return;
  setSelection(matchId, interaction.user.id, { pieceIndex, rotation: 0 });
  await renderPlayfield(interaction, ctx.match, ctx.runtime);
}

async function handleRotate(interaction: ButtonInteraction, matchId: number) {
  const ctx = await ensureContext(interaction, matchId);
  if (!ctx) return;
  const sel = getSelection(matchId, interaction.user.id);
  const next = ((sel.rotation + 1) % 4) as 0 | 1 | 2 | 3;
  setSelection(matchId, interaction.user.id, { rotation: next });
  await renderPlayfield(interaction, ctx.match, ctx.runtime);
}

async function handleSelectRow(
  interaction: StringSelectMenuInteraction,
  matchId: number
) {
  const ctx = await ensureContext(interaction, matchId);
  if (!ctx) return;
  const row = +interaction.values[0];
  setSelection(matchId, interaction.user.id, { row });
  await renderPlayfield(interaction, ctx.match, ctx.runtime);
}

async function handleSelectCol(
  interaction: StringSelectMenuInteraction,
  matchId: number
) {
  const ctx = await ensureContext(interaction, matchId);
  if (!ctx) return;
  const col = +interaction.values[0];
  setSelection(matchId, interaction.user.id, { col });
  await renderPlayfield(interaction, ctx.match, ctx.runtime);
}

async function handleReset(interaction: ButtonInteraction, matchId: number) {
  const ctx = await ensureContext(interaction, matchId);
  if (!ctx) return;
  resetSelection(matchId, interaction.user.id);
  await renderPlayfield(interaction, ctx.match, ctx.runtime);
}

/* ─────────── Place ─────────── */

async function handlePlace(interaction: ButtonInteraction, matchId: number) {
  const ctx = await ensureContext(interaction, matchId);
  if (!ctx) return;
  const { match, runtime } = ctx;
  const sel = getSelection(matchId, interaction.user.id);
  if (sel.pieceIndex == null || sel.row == null || sel.col == null) {
    return reply(interaction, "Pick a piece, row, and column first.");
  }

  const state = runtime.players.get(interaction.user.id)!;
  const move: Move = {
    level: state.level,
    pieceIndex: sel.pieceIndex,
    rotation: sel.rotation,
    row: sel.row,
    col: sel.col,
  };
  const result = applyMoveForPlayer(matchId, interaction.user.id, move);
  if (!result.ok) return reply(interaction, result.error);

  resetSelection(matchId, interaction.user.id);

  // Render first so the user sees the move land immediately; persist the
  // draft afterwards so a slow Supabase write can't delay the editReply.
  await renderPlayfield(interaction, match, runtime);
  persistDraft(match, interaction.user.id, runtime.players.get(interaction.user.id)!).catch(
    (err) => console.error("[Arcade] persistDraft failed:", (err as Error)?.message ?? err)
  );
}

/* ─────────── Submit / End ─────────── */

async function handleSubmit(interaction: ButtonInteraction, matchId: number) {
  const ctx = await ensureContext(interaction, matchId);
  if (!ctx) return;
  const { match, runtime } = ctx;
  const state = runtime.players.get(interaction.user.id)!;

  await recordSubmission({
    matchId,
    userId: interaction.user.id,
    moveLog: state.moves,
    claimedScore: state.score,
    validatedScore: state.score,
    valid: true,
  });
  clearSelection(matchId, interaction.user.id);

  const settlement = await trySettleMatch(matchId);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x00cc6a)
        .setTitle("Submission recorded")
        .setDescription(
          `Final score: **${state.score.toLocaleString()}**\n` +
            (settlement.status === "waiting"
              ? "Waiting for the other player…"
              : settlement.status === "tie"
                ? "🤝 Tie — stakes refunded."
                : settlement.winnerId === interaction.user.id
                  ? `🏆 You won!${settlement.payoutSats ? ` Payout: **${formatSats(settlement.payoutSats)}**` : ""}`
                  : "You finished — opponent's score was higher.")
        ),
    ],
    components: [],
  });

  // Public match feed update can't block the player's submit ack.
  updateMatchFeed(interaction.client, settlement.match).catch(() => {});

  if (settlement.status !== "waiting") clearRuntime(matchId);
}

/* ─────────── Helpers ─────────── */

async function ensureContext(
  interaction: ArcadeInteraction,
  matchId: number
): Promise<{ match: ArcadeMatchRow; runtime: MatchRuntime } | null> {
  const match = await getMatch(matchId);
  if (!match) {
    await reply(interaction, "Match not found.");
    return null;
  }
  if (![match.player_a_id, match.player_b_id].includes(interaction.user.id)) {
    await reply(interaction, "You're not a player in this match.");
    return null;
  }
  const playerIds = [match.player_a_id, match.player_b_id].filter(Boolean) as string[];
  const runtime = ensureRuntime(matchId, match.seed, playerIds);
  return { match, runtime };
}

async function renderPlayfield(
  interaction: ArcadeInteraction,
  match: ArcadeMatchRow,
  runtime: MatchRuntime
) {
  const state = runtime.players.get(interaction.user.id)!;
  const selection = getSelection(match.id, interaction.user.id);
  await interaction.editReply({
    embeds: [buildPlayfieldEmbed(match, state, runtime, selection)],
    components: buildPlayfieldComponents(match.id, state, runtime, selection),
  });
}

async function persistDraft(
  match: ArcadeMatchRow,
  userId: string,
  state: { moves: Move[]; score: number },
) {
  await supabase.from("arcade_submissions").upsert(
    {
      match_id: match.id,
      user_id: userId,
      move_log: state.moves,
      claimed_score: state.score,
      validated_score: state.score,
      valid: null,
      validation_error: null,
    },
    { onConflict: "match_id,user_id" }
  );
}

async function updateMatchFeed(client: Client, match: ArcadeMatchRow) {
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

async function reply(interaction: ArcadeInteraction, content: string) {
  // We always defer at the top of handleArcadeInteraction, so an error reply
  // is always a followUp. Ephemeral so it only shows to the clicker.
  await interaction
    .followUp({ content: `❌ ${content}`, flags: MessageFlags.Ephemeral })
    .catch(() => {});
}
