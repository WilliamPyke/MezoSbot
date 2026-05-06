/**
 * In-memory registry of currently-active arcade matches.
 *
 * Player state (board, multiplier, score, move log) is rebuilt deterministically
 * from the seed + recorded moves, so a bot restart can recover any match by
 * replaying its persisted move_log from arcade_submissions.
 */
import { generatePieceSequence } from "./pieces.js";
import { hashSeed } from "./rng.js";
import { applyMove, createPlayerState, replayMoves } from "./match.js";
import type { GeneratedPiece, Move, PlayerState } from "./types.js";

export type MatchRuntime = {
  matchId: number;
  seed: string;
  sequence: GeneratedPiece[][];
  players: Map<string, PlayerState>;
  /** Channel + message id of the public match feed (PvP only). */
  feedChannelId?: string;
  feedMessageId?: string;
};

const runtimes = new Map<number, MatchRuntime>();

export function getRuntime(matchId: number): MatchRuntime | undefined {
  return runtimes.get(matchId);
}

export function ensureRuntime(matchId: number, seed: string, playerIds: string[]): MatchRuntime {
  let runtime = runtimes.get(matchId);
  if (!runtime) {
    const sequence = generatePieceSequence(hashSeed(seed));
    runtime = {
      matchId,
      seed,
      sequence,
      players: new Map(),
    };
    runtimes.set(matchId, runtime);
  }
  for (const pid of playerIds) {
    if (!runtime.players.has(pid)) runtime.players.set(pid, createPlayerState());
  }
  return runtime;
}

export function clearRuntime(matchId: number): void {
  runtimes.delete(matchId);
}

export function setFeedMessage(matchId: number, channelId: string, messageId: string) {
  const runtime = runtimes.get(matchId);
  if (runtime) {
    runtime.feedChannelId = channelId;
    runtime.feedMessageId = messageId;
  }
}

export function applyMoveForPlayer(
  matchId: number,
  userId: string,
  move: Move
): ReturnType<typeof applyMove> | { ok: false; error: string } {
  const runtime = runtimes.get(matchId);
  if (!runtime) return { ok: false, error: "Match runtime not found" };
  const state = runtime.players.get(userId);
  if (!state) return { ok: false, error: "Player not in match" };
  const result = applyMove(state, runtime.sequence, move);
  if (result.ok) runtime.players.set(userId, result.state);
  return result;
}

export function rebuildState(seed: string, moves: Move[]): PlayerState {
  const sequence = generatePieceSequence(hashSeed(seed));
  const result = replayMoves(sequence, moves);
  if (!result.valid) throw new Error(`Replay failed: ${result.error}`);
  return result.state;
}
