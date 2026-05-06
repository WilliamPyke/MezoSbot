import {
  PIECES_PER_LEVEL,
  MAX_LEVELS,
  type PlayerState,
  type GeneratedPiece,
  type Move,
  type Board,
  type ScoreBreakdown,
} from "./types.js";
import { createEmptyBoard } from "./board.js";
import { applyPlacement, applyClears, anyPiecePlaceable, isValidPlacement } from "./board.js";
import { rotateCells } from "./pieces.js";
import { scorePlacement } from "./scoring.js";

export function createPlayerState(): PlayerState {
  return {
    board: createEmptyBoard(),
    level: 0,
    pieceCursor: 0,
    placedThisLevel: new Array(PIECES_PER_LEVEL).fill(false),
    multiplier: 1,
    score: 0,
    moves: [],
    phase: "playing",
  };
}

export type ApplyMoveResult =
  | {
      ok: true;
      state: PlayerState;
      placementScore: number;
      multiplierBefore: number;
      multiplierAfter: number;
      cleared: { rows: number; cols: number; squares: number; multiplierBlocks: number };
      finished: boolean;
      endReason?: "completed_levels" | "no_moves";
    }
  | { ok: false; error: string };

/**
 * Apply a single move to a player state.
 *
 * Validates: piece index is for the current level + cursor and not already used,
 * placement is in-bounds and non-overlapping. Mutates a fresh copy and returns it.
 */
export function applyMove(
  state: PlayerState,
  sequence: GeneratedPiece[][],
  move: Move
): ApplyMoveResult {
  if (state.phase !== "playing") {
    return { ok: false, error: "Match is not in playing phase" };
  }
  if (move.level !== state.level) {
    return { ok: false, error: `Wrong level (expected ${state.level}, got ${move.level})` };
  }
  if (move.pieceIndex < 0 || move.pieceIndex >= PIECES_PER_LEVEL) {
    return { ok: false, error: "Piece index out of range" };
  }
  if (state.placedThisLevel[move.pieceIndex]) {
    return { ok: false, error: "Piece already placed this level" };
  }

  const generated = sequence[state.level][move.pieceIndex];
  const rotation = (move.rotation ?? 0) as 0 | 1 | 2 | 3;
  const cells = rotateCells(generated.cells, rotation);

  if (!isValidPlacement(state.board, cells, move.row, move.col)) {
    return { ok: false, error: "Invalid placement" };
  }

  const afterPlacement = applyPlacement(state.board, cells, move.row, move.col);
  const clearResult = applyClears(afterPlacement);

  const score = scorePlacement({
    placementCellCount: cells.length,
    clearedRows: clearResult.clearedRows.length,
    clearedCols: clearResult.clearedCols.length,
    clearedSquares: clearResult.clearedSquares.length,
    multiplierClearedCount: clearResult.multiplierClearedCount,
    currentMultiplier: state.multiplier,
  });

  const placedThisLevel = state.placedThisLevel.slice();
  placedThisLevel[move.pieceIndex] = true;

  let level = state.level;
  let pieceCursor = state.pieceCursor + 1;
  let placedThisLevelOut = placedThisLevel;
  let phase: PlayerState["phase"] = "playing";
  let endReason: PlayerState["endReason"];

  // Advance to next level if all 3 placed
  if (placedThisLevel.every((p) => p)) {
    level += 1;
    pieceCursor = 0;
    placedThisLevelOut = new Array(PIECES_PER_LEVEL).fill(false);
    if (level >= MAX_LEVELS) {
      phase = "finished";
      endReason = "completed_levels";
    }
  }

  // Check if remaining pieces this level (or next level start) have any legal move
  if (phase === "playing") {
    const remainingPieces: typeof cells[] = [];
    if (placedThisLevelOut.every((p) => !p)) {
      // Just advanced to a new level
      for (let i = 0; i < PIECES_PER_LEVEL; i++) {
        remainingPieces.push(sequence[level][i].cells);
      }
    } else {
      for (let i = 0; i < PIECES_PER_LEVEL; i++) {
        if (!placedThisLevelOut[i]) {
          remainingPieces.push(sequence[level][i].cells);
        }
      }
    }
    if (!anyPiecePlaceable(clearResult.board, remainingPieces)) {
      phase = "finished";
      endReason = "no_moves";
    }
  }

  const newState: PlayerState = {
    board: clearResult.board,
    level,
    pieceCursor,
    placedThisLevel: placedThisLevelOut,
    multiplier: score.multiplierAfter,
    score: state.score + score.pointsGained,
    moves: [...state.moves, move],
    phase,
    endReason,
  };

  return {
    ok: true,
    state: newState,
    placementScore: score.pointsGained,
    multiplierBefore: score.multiplierBefore,
    multiplierAfter: score.multiplierAfter,
    cleared: {
      rows: clearResult.clearedRows.length,
      cols: clearResult.clearedCols.length,
      squares: clearResult.clearedSquares.length,
      multiplierBlocks: clearResult.multiplierClearedCount,
    },
    finished: phase === "finished",
    endReason,
  };
}

/**
 * Replay a complete move log from scratch and return final state + breakdown.
 * Used by the server to validate honesty when both players submit.
 */
export function replayMoves(
  sequence: GeneratedPiece[][],
  moves: Move[]
): { state: PlayerState; valid: true } | { valid: false; error: string } {
  let state = createPlayerState();
  for (let i = 0; i < moves.length; i++) {
    const result = applyMove(state, sequence, moves[i]);
    if (!result.ok) return { valid: false, error: `Move ${i}: ${result.error}` };
    state = result.state;
  }
  return { state, valid: true };
}

export function nextUnplacedPieceIndex(state: PlayerState): number {
  for (let i = 0; i < PIECES_PER_LEVEL; i++) {
    if (!state.placedThisLevel[i]) return i;
  }
  return -1;
}

export type { Board, ScoreBreakdown };
