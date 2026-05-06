import { BOARD_SIZE, type Board, type PieceCell } from "./types.js";
import { placedCells, isValidPlacement } from "./board.js";
import { piecesBounds } from "./pieces.js";

/**
 * Visual palette. We use Unicode colored squares so the board renders
 * in any Discord client without custom emoji. Each glyph is exactly one
 * "wide" character so columns align in monospace embed text.
 */
const GLYPHS = {
  empty: "⬛",
  normal: "🟦",
  multiplier: "🟧",
  ghostValid: "🟩",
  ghostInvalid: "🟥",
  pieceNormal: "🟦",
  pieceMultiplier: "🟧",
  pieceEmpty: "▫️",
} as const;

const COL_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];

export type RenderBoardOptions = {
  ghost?: { cells: PieceCell[]; row: number; col: number };
  showLabels?: boolean;
};

/** Render the 9x9 board as a column of emoji rows. */
export function renderBoard(board: Board, opts: RenderBoardOptions = {}): string {
  const showLabels = opts.showLabels ?? true;
  const grid: string[][] = board.map((row) =>
    row.map((cell) => {
      if (cell === 1) return GLYPHS.normal;
      if (cell === 2) return GLYPHS.multiplier;
      return GLYPHS.empty;
    })
  );

  if (opts.ghost) {
    const valid = isValidPlacement(board, opts.ghost.cells, opts.ghost.row, opts.ghost.col);
    const glyph = valid ? GLYPHS.ghostValid : GLYPHS.ghostInvalid;
    for (const cell of placedCells(opts.ghost.cells, opts.ghost.row, opts.ghost.col)) {
      if (cell.r >= 0 && cell.r < BOARD_SIZE && cell.c >= 0 && cell.c < BOARD_SIZE) {
        // Only overlay if the underlying cell is empty (don't paint over placed cells).
        if (board[cell.r][cell.c] === 0) grid[cell.r][cell.c] = glyph;
      }
    }
  }

  const lines: string[] = [];
  if (showLabels) {
    // Column header — small numbers separated by zero-width space-ish padding.
    // Each square emoji is ~2 chars wide; we just put the digits with spaces.
    lines.push("` ` " + COL_LABELS.map((l) => `\` ${l}\``).join(""));
  }
  for (let r = 0; r < BOARD_SIZE; r++) {
    const prefix = showLabels ? `\`${ROW_LABELS[r]}\`` : "";
    lines.push(prefix + grid[r].join(""));
  }
  return lines.join("\n");
}

/** Compact piece preview — fits in an embed field. */
export function renderPiecePreview(cells: PieceCell[]): string {
  if (cells.length === 0) return "(empty)";
  const { width, height } = piecesBounds(cells);
  const grid: string[][] = Array.from({ length: height }, () =>
    new Array(width).fill(GLYPHS.pieceEmpty)
  );
  for (const cell of cells) {
    grid[cell.y][cell.x] =
      cell.kind === "multiplier" ? GLYPHS.pieceMultiplier : GLYPHS.pieceNormal;
  }
  return grid.map((row) => row.join("")).join("\n");
}

/** A short, human label for a piece including a multiplier marker. */
export function pieceShortLabel(cells: PieceCell[]): string {
  const hasMultiplier = cells.some((c) => c.kind === "multiplier");
  const tag = hasMultiplier ? " ✨" : "";
  return `${cells.length} cells${tag}`;
}

/** Convert a board coordinate into a human label like "C5". */
export function coordLabel(row: number, col: number): string {
  return `${ROW_LABELS[row] ?? "?"}${COL_LABELS[col] ?? "?"}`;
}

/** Parse a human coord like "c5" or "C 5" → {row, col}. */
export function parseCoord(input: string): { row: number; col: number } | null {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, "");
  const match = cleaned.match(/^([A-I])([1-9])$/);
  if (!match) return null;
  return { row: ROW_LABELS.indexOf(match[1]), col: COL_LABELS.indexOf(match[2]) };
}
