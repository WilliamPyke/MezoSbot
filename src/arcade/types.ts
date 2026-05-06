export const BOARD_SIZE = 9;
export const PIECES_PER_LEVEL = 3;
export const MAX_LEVELS = 12;
export const MAX_MULTIPLIER = 5;

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

export type Move = {
  level: number;
  pieceIndex: number; // 0..PIECES_PER_LEVEL-1
  rotation: 0 | 1 | 2 | 3;
  row: number; // top-left of bounding box on board
  col: number;
};

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

export type PlayerState = {
  board: Board;
  level: number; // 0-indexed
  pieceCursor: number; // which of the 3 pieces in current level still available
  placedThisLevel: boolean[]; // length PIECES_PER_LEVEL
  multiplier: number;
  score: number;
  moves: Move[];
  phase: MatchPhase;
  endReason?: "completed_levels" | "no_moves";
};
