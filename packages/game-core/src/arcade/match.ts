import {
  PIECES_PER_LEVEL,
  isBankMove,
  type PlayerState,
  type GeneratedPiece,
  type Move,
  type BankMove,
  type PlaceMove,
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
    bank: null,
    slotOverrides: {},
  };
}

export type ApplyMoveResult =
  | {
      ok: true;
      kind: "place";
      state: PlayerState;
      placementScore: number;
      multiplierBefore: number;
      multiplierAfter: number;
      cleared: { rows: number; cols: number; squares: number; multiplierBlocks: number };
      finished: boolean;
      endReason?: "completed_levels" | "no_moves";
    }
  | { ok: true; kind: "bank"; state: PlayerState }
  | { ok: false; error: string };

const slotKey = (level: number, pieceIndex: number) => `${level}:${pieceIndex}`;

/**
 * Resolve which generated piece occupies the given slot for this player,
 * accounting for any prior bank swaps. Returns null when the slot is empty
 * (its piece was banked into the bank slot).
 */
export function pieceForSlot(
  state: PlayerState,
  sequence: GeneratedPiece[][],
  level: number,
  pieceIndex: number
): GeneratedPiece | null {
  const key = slotKey(level, pieceIndex);
  if (Object.prototype.hasOwnProperty.call(state.slotOverrides, key)) {
    return state.slotOverrides[key];
  }
  return sequence[level]?.[pieceIndex] ?? null;
}

/** Dispatch on Move kind. Treats moves with no `kind` as place moves. */
export function applyMove(
  state: PlayerState,
  sequence: GeneratedPiece[][],
  move: Move
): ApplyMoveResult {
  if (isBankMove(move)) return applyBank(state, sequence, move);
  return applyPlace(state, sequence, move as PlaceMove);
}

function applyPlace(
  state: PlayerState,
  sequence: GeneratedPiece[][],
  move: PlaceMove
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

  const generated = pieceForSlot(state, sequence, state.level, move.pieceIndex);
  if (!generated) {
    return { ok: false, error: "Slot is empty — bank a piece into it first" };
  }
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

  // Treat slots that have been banked-out (override === null) as "consumed"
  // for level-advance purposes — the player can't place from them again.
  const allSlotsResolved = (() => {
    for (let i = 0; i < PIECES_PER_LEVEL; i++) {
      if (placedThisLevel[i]) continue;
      const slot = pieceForSlot(state, sequence, level, i);
      if (slot != null) return false;
    }
    return true;
  })();

  if (allSlotsResolved) {
    level += 1;
    pieceCursor = 0;
    placedThisLevelOut = new Array(PIECES_PER_LEVEL).fill(false);
  }

  // Build candidate piece set for the (possibly new) current level — every
  // not-yet-placed slot whose piece is not null.
  const remainingPieces: typeof cells[] = [];
  if (placedThisLevelOut.every((p) => !p)) {
    for (let i = 0; i < PIECES_PER_LEVEL; i++) {
      const candidate = pieceForSlotForFutureLevel(level, i, sequence, state.slotOverrides);
      if (candidate) remainingPieces.push(candidate.cells);
    }
  } else {
    for (let i = 0; i < PIECES_PER_LEVEL; i++) {
      if (placedThisLevelOut[i]) continue;
      const candidate = pieceForSlotForFutureLevel(level, i, sequence, state.slotOverrides);
      if (candidate) remainingPieces.push(candidate.cells);
    }
  }
  if (state.bank) remainingPieces.push(state.bank.cells);

  if (remainingPieces.length === 0 || !anyPiecePlaceable(clearResult.board, remainingPieces)) {
    phase = "finished";
    endReason = "no_moves";
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
    bank: state.bank,
    slotOverrides: state.slotOverrides,
  };

  return {
    ok: true,
    kind: "place",
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

function pieceForSlotForFutureLevel(
  level: number,
  pieceIndex: number,
  sequence: GeneratedPiece[][],
  overrides: Record<string, GeneratedPiece | null>
): GeneratedPiece | null {
  const key = slotKey(level, pieceIndex);
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  return sequence[level]?.[pieceIndex] ?? null;
}

function applyBank(
  state: PlayerState,
  sequence: GeneratedPiece[][],
  move: BankMove
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

  const slotPiece = pieceForSlot(state, sequence, state.level, move.pieceIndex);
  if (!slotPiece) {
    return { ok: false, error: "Slot is empty" };
  }

  const overrides = { ...state.slotOverrides };
  const newBank = slotPiece;
  // If bank was empty, slot becomes empty (override = null). If bank had a
  // piece, that piece moves into the slot (override = that piece).
  overrides[slotKey(state.level, move.pieceIndex)] = state.bank ?? null;

  let level = state.level;
  let placedThisLevel = state.placedThisLevel;
  let pieceCursor = state.pieceCursor;
  let phase: PlayerState["phase"] = "playing";
  let endReason: PlayerState["endReason"];

  const allSlotsResolved = (() => {
    for (let i = 0; i < PIECES_PER_LEVEL; i++) {
      if (placedThisLevel[i]) continue;
      const slot = pieceForSlotForFutureLevel(level, i, sequence, overrides);
      if (slot != null) return false;
    }
    return true;
  })();

  if (allSlotsResolved) {
    level += 1;
    pieceCursor = 0;
    placedThisLevel = new Array(PIECES_PER_LEVEL).fill(false);
  }

  const remainingPieces: GeneratedPiece["cells"][] = [];
  for (let i = 0; i < PIECES_PER_LEVEL; i++) {
    if (placedThisLevel[i]) continue;
    const candidate = pieceForSlotForFutureLevel(level, i, sequence, overrides);
    if (candidate) remainingPieces.push(candidate.cells);
  }
  remainingPieces.push(newBank.cells);
  if (remainingPieces.length === 0 || !anyPiecePlaceable(state.board, remainingPieces)) {
    phase = "finished";
    endReason = "no_moves";
  }

  const newState: PlayerState = {
    ...state,
    level,
    pieceCursor,
    placedThisLevel,
    phase,
    endReason,
    bank: newBank,
    slotOverrides: overrides,
    moves: [...state.moves, move],
  };

  return { ok: true, kind: "bank", state: newState };
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
