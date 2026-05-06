import { supabase } from "../db.js";
import { addBalance, subtractBalance } from "../balance.js";
import { roundSats } from "../format.js";
import {
  DEFAULT_PLATFORM_RAKE_BPS,
  calculateGrossPot,
  calculateRake,
  calculateWinnerPayout,
} from "./economics.js";
import type { Move } from "./types.js";

export type MatchMode = "practice" | "free_pvp" | "staked_pvp";
export type MatchStatus =
  | "waiting"
  | "active"
  | "submitted"
  | "completed"
  | "cancelled";
export type EscrowStatus = "none" | "pending" | "funded" | "released" | "refunded";

export type ArcadeMatchRow = {
  id: number;
  seed: string;
  mode: MatchMode;
  status: MatchStatus;
  channel_id: string | null;
  message_id: string | null;
  stake_amount_sats: number | null;
  gross_pot_sats: number | null;
  platform_rake_bps: number;
  rake_amount_sats: number | null;
  winner_payout_sats: number | null;
  created_by_id: string;
  target_player_id: string | null;
  player_a_id: string;
  player_b_id: string | null;
  player_a_score: number | null;
  player_b_score: number | null;
  player_a_submitted: boolean;
  player_b_submitted: boolean;
  winner_id: string | null;
  escrow_status: EscrowStatus;
  duration_seconds: number;
  started_at: string | null;
  created_at: string;
  completed_at: string | null;
};

export type CreateMatchInput = {
  mode: MatchMode;
  createdById: string;
  playerAId: string;
  playerBId?: string | null;
  targetPlayerId?: string | null;
  stakeAmountSats?: number;
  channelId?: string;
  rakeBps?: number;
  durationSeconds?: number;
};

export async function createMatch(input: CreateMatchInput): Promise<ArcadeMatchRow> {
  const seed = randomSeed();
  const stake = input.stakeAmountSats ?? null;
  const rakeBps = input.rakeBps ?? DEFAULT_PLATFORM_RAKE_BPS;
  const grossPot =
    input.mode === "staked_pvp" && stake != null ? calculateGrossPot(stake, 2) : null;
  const rake =
    input.mode === "staked_pvp" && grossPot != null ? calculateRake(grossPot, rakeBps) : null;
  const winnerPayout =
    input.mode === "staked_pvp" && grossPot != null && rake != null
      ? calculateWinnerPayout(grossPot, rake)
      : null;

  const initialStatus: MatchStatus =
    input.mode === "practice" ? "active" : input.playerBId ? "active" : "waiting";
  const durationSeconds = input.durationSeconds ?? 180;
  const startedAt = initialStatus === "active" ? new Date().toISOString() : null;

  const { data, error } = await supabase
    .from("arcade_matches")
    .insert({
      seed,
      mode: input.mode,
      status: initialStatus,
      channel_id: input.channelId ?? null,
      stake_amount_sats: stake,
      gross_pot_sats: grossPot,
      platform_rake_bps: rakeBps,
      rake_amount_sats: rake,
      winner_payout_sats: winnerPayout,
      created_by_id: input.createdById,
      target_player_id: input.targetPlayerId ?? null,
      player_a_id: input.playerAId,
      player_b_id: input.playerBId ?? null,
      escrow_status: input.mode === "staked_pvp" ? "pending" : "none",
      duration_seconds: durationSeconds,
      started_at: startedAt,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(`createMatch failed: ${error?.message}`);
  return data as ArcadeMatchRow;
}

export async function getMatch(id: number): Promise<ArcadeMatchRow | null> {
  const { data } = await supabase
    .from("arcade_matches")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data as ArcadeMatchRow | null) ?? null;
}

export async function joinMatch(matchId: number, userId: string): Promise<{ ok: boolean; error?: string; match?: ArcadeMatchRow }> {
  const match = await getMatch(matchId);
  if (!match) return { ok: false, error: "Match not found" };
  if (match.status !== "waiting") return { ok: false, error: "Match is not waiting for opponents" };
  if (match.player_a_id === userId) return { ok: false, error: "You created this match — wait for an opponent" };
  if (match.target_player_id && match.target_player_id !== userId) {
    return { ok: false, error: "This challenge is for another player" };
  }
  if (match.player_b_id) return { ok: false, error: "Match already full" };

  const { data, error } = await supabase
    .from("arcade_matches")
    .update({ player_b_id: userId, status: "active", started_at: new Date().toISOString() })
    .eq("id", matchId)
    .eq("status", "waiting")
    .is("player_b_id", null)
    .select("*")
    .single();

  if (error || !data) return { ok: false, error: "Failed to join (someone may have beaten you to it)" };
  return { ok: true, match: data as ArcadeMatchRow };
}

export async function setMatchMessage(matchId: number, channelId: string, messageId: string) {
  await supabase
    .from("arcade_matches")
    .update({ channel_id: channelId, message_id: messageId })
    .eq("id", matchId);
}

/* ─────────── Escrow ─────────── */

/**
 * Atomically debit a player's wallet balance and create their escrow row.
 * If the user is already escrowed for this match, returns ok without re-charging.
 */
export async function fundEscrowFromBalance(
  matchId: number,
  userId: string,
  amountSats: number
): Promise<{ ok: boolean; error?: string }> {
  const rounded = roundSats(amountSats);
  if (rounded <= 0) return { ok: false, error: "Stake must be positive" };

  const { data: existing } = await supabase
    .from("arcade_escrow")
    .select("*")
    .eq("match_id", matchId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing && existing.status === "funded") return { ok: true };

  const debited = await subtractBalance(userId, rounded);
  if (!debited) return { ok: false, error: "Insufficient balance" };

  const { error } = await supabase
    .from("arcade_escrow")
    .upsert(
      {
        match_id: matchId,
        user_id: userId,
        amount_sats: rounded,
        status: "funded",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "match_id,user_id" }
    );

  if (error) {
    // Refund on insert failure
    await addBalance(userId, rounded);
    return { ok: false, error: error.message };
  }

  // If both sides funded, mark match escrow_status=funded
  const { data: rows } = await supabase
    .from("arcade_escrow")
    .select("status")
    .eq("match_id", matchId);
  const fundedCount = (rows ?? []).filter((r) => r.status === "funded").length;
  if (fundedCount >= 2) {
    await supabase
      .from("arcade_matches")
      .update({ escrow_status: "funded" })
      .eq("id", matchId);
  }

  return { ok: true };
}

export async function refundAllEscrow(matchId: number): Promise<void> {
  const { data: rows } = await supabase
    .from("arcade_escrow")
    .select("*")
    .eq("match_id", matchId)
    .eq("status", "funded");
  for (const row of rows ?? []) {
    await addBalance(row.user_id, row.amount_sats);
    await supabase
      .from("arcade_escrow")
      .update({ status: "refunded", updated_at: new Date().toISOString() })
      .eq("id", row.id);
  }
  await supabase
    .from("arcade_matches")
    .update({ status: "cancelled", escrow_status: "refunded" })
    .eq("id", matchId);
}

/* ─────────── Submissions ─────────── */

export async function recordSubmission(input: {
  matchId: number;
  userId: string;
  moveLog: Move[];
  claimedScore: number;
  validatedScore: number;
  valid: boolean;
  validationError?: string;
}) {
  await supabase.from("arcade_submissions").upsert(
    {
      match_id: input.matchId,
      user_id: input.userId,
      move_log: input.moveLog,
      claimed_score: input.claimedScore,
      validated_score: input.validatedScore,
      valid: input.valid,
      validation_error: input.validationError ?? null,
    },
    { onConflict: "match_id,user_id" }
  );

  const isA = await (async () => {
    const m = await getMatch(input.matchId);
    return m?.player_a_id === input.userId;
  })();

  await supabase
    .from("arcade_matches")
    .update(
      isA
        ? { player_a_score: input.validatedScore, player_a_submitted: true }
        : { player_b_score: input.validatedScore, player_b_submitted: true }
    )
    .eq("id", input.matchId);
}

/* ─────────── Settlement ─────────── */

export type SettlementResult = {
  status: "completed" | "tie" | "waiting";
  match: ArcadeMatchRow;
  winnerId?: string | null;
  payoutSats?: number;
  rakeSats?: number;
};

/**
 * Called after a submission. If both players have submitted, decide the winner,
 * release escrow, and credit balances. For practice mode, just marks completed.
 */
export async function trySettleMatch(matchId: number): Promise<SettlementResult> {
  const match = await getMatch(matchId);
  if (!match) throw new Error("Match not found");

  if (match.mode === "practice") {
    if (match.player_a_submitted) {
      const updated = await completeMatch(matchId, match.player_a_id);
      return { status: "completed", match: updated, winnerId: match.player_a_id };
    }
    return { status: "waiting", match };
  }

  if (!match.player_a_submitted || !match.player_b_submitted) {
    return { status: "waiting", match };
  }

  const aScore = match.player_a_score ?? 0;
  const bScore = match.player_b_score ?? 0;

  if (aScore === bScore) {
    // Tie — refund staked matches; mark free_pvp completed with no winner.
    if (match.mode === "staked_pvp") {
      await refundAllEscrow(matchId);
    }
    const updated = await completeMatch(matchId, null, "tie");
    return { status: "tie", match: updated };
  }

  const winnerId = aScore > bScore ? match.player_a_id : match.player_b_id!;

  if (match.mode === "staked_pvp") {
    const grossPot = match.gross_pot_sats ?? 0;
    const rake = match.rake_amount_sats ?? 0;
    const payout = match.winner_payout_sats ?? 0;
    if (payout > 0) await addBalance(winnerId, payout);

    await supabase
      .from("arcade_escrow")
      .update({ status: "released", updated_at: new Date().toISOString() })
      .eq("match_id", matchId);

    await supabase.from("arcade_fees").insert({
      match_id: matchId,
      rake_amount_sats: rake,
      platform_rake_bps: match.platform_rake_bps,
      status: "collected",
    });

    await supabase
      .from("arcade_matches")
      .update({ escrow_status: "released" })
      .eq("id", matchId);

    const updated = await completeMatch(matchId, winnerId);
    return { status: "completed", match: updated, winnerId, payoutSats: payout, rakeSats: rake };
  }

  const updated = await completeMatch(matchId, winnerId);
  return { status: "completed", match: updated, winnerId };
}

async function completeMatch(
  matchId: number,
  winnerId: string | null,
  forceStatus?: "tie"
): Promise<ArcadeMatchRow> {
  const { data } = await supabase
    .from("arcade_matches")
    .update({
      status: forceStatus === "tie" ? "completed" : "completed",
      winner_id: winnerId,
      completed_at: new Date().toISOString(),
    })
    .eq("id", matchId)
    .select("*")
    .single();
  return data as ArcadeMatchRow;
}

/* ─────────── Leaderboard ─────────── */

export async function topValidatedScores(limit = 10) {
  const { data } = await supabase
    .from("arcade_submissions")
    .select("user_id, validated_score, match_id, created_at")
    .eq("valid", true)
    .order("validated_score", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function openOffers(limit = 5): Promise<ArcadeMatchRow[]> {
  const { data } = await supabase
    .from("arcade_matches")
    .select("*")
    .eq("status", "waiting")
    .is("target_player_id", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as ArcadeMatchRow[] | null) ?? [];
}

/* ─────────── Helpers ─────────── */

function randomSeed(): string {
  return [...Array(16)].map(() => Math.floor(Math.random() * 36).toString(36)).join("");
}
