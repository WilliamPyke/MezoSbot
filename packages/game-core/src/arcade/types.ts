export const BOARD_SIZE = 9;
export const PIECES_PER_LEVEL = 3;
/**
 * Pre-generated levels per match. Levels are no longer a hard cap on play —
 * matches end on the timer or when no legal placement remains. We generate a
 * generous pool so even a fast-clearing match can never run out.
 */
export const LEVEL_POOL_SIZE = 240;
/** Below this multiplier we add 1.0 per multiplier-block clear; at/above we add 0.1. */
export const MULT_DECIMAL_THRESHOLD = 5;

export type CellState = 0 | 1 | 2; // 0 empty, 1 normal, 2 multiplier
export type Board = CellState[][]; // [row][col]

export type PieceCellKind = "normal" | "multiplier";

export type PieceCell = {
  x: number; // column offset
  y: number; // row offset
  kind: PieceCellKind;
};

export type PieceDefinition = {
  id: string;
  label: string;
  cells: PieceCell[];
  allowRotation: boolean;
  weight: number;
  minLevel?: number;
  maxLevel?: number;
};

export type GeneratedPiece = {
  defId: string;
  cells: PieceCell[]; // post-multiplier-injection (still origin-relative)
};

/**
 * Place: drop the piece at `pieceIndex` (in the current level's slot, possibly
 * overridden by a previous swap) onto the board.
 *
 * Bank: swap the piece at `pieceIndex` with the player's bank slot. If bank
 * is empty, the piece moves into the bank and the slot becomes empty (no
 * piece can be placed from that slot until refilled by another swap). If the
 * bank holds something, the banked piece replaces the slot for placement.
 *
 * `kind` is optional on PlaceMove for backward compatibility with historical
 * move logs persisted in arcade_submissions.move_log (which lack `kind`).
 */
export type PlaceMove = {
  kind?: "place";
  level: number;
  pieceIndex: number; // 0..PIECES_PER_LEVEL-1
  rotation: 0 | 1 | 2 | 3;
  row: number;
  col: number;
};

export type BankMove = {
  kind: "bank";
  level: number;
  pieceIndex: number;
};

export type Move = PlaceMove | BankMove;

export function isBankMove(m: Move): m is BankMove {
  return (m as BankMove).kind === "bank";
}

export type ScoreBreakdown = {
  total: number;
  perPlacement: Array<{
    placementCells: number;
    clearedRows: number;
    clearedCols: number;
    clearedSquares: number;
    comboBonus: number;
    multiplierBefore: number;
    multiplierAfter: number;
    pointsGained: number;
  }>;
};

export type MatchPhase = "playing" | "finished";

/**
 * Per-player runtime state. `slotOverrides` lets the player carry a banked
 * piece into a future slot without mutating the deterministic global piece
 * sequence. Keys are encoded as `${level}:${pieceIndex}`; missing keys mean
 * "use the global sequence's piece".
 *
 * Bank semantics: when bank is `null`, slots remain authoritative (their
 * piece is whatever the override or global sequence says). When a slot has
 * been "emptied" by a swap-into-bank, its override is `null` and `placedThisLevel[i]`
 * stays false but the client renders the slot as empty/locked.
 */
export type PlayerState = {
  board: Board;
  level: number; // 0-indexed
  pieceCursor: number;
  placedThisLevel: boolean[]; // length PIECES_PER_LEVEL
  multiplier: number;
  score: number;
  moves: Move[];
  phase: MatchPhase;
  endReason?: "completed_levels" | "no_moves";
  bank: GeneratedPiece | null;
  slotOverrides: Record<string, GeneratedPiece | null>;
};
