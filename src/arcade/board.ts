import {
  BOARD_SIZE,
  type Board,
  type CellState,
  type PieceCell,
} from "./types.js";

export function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => 0 as CellState)
  );
}

export function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice() as CellState[]);
}

/** Translated cell positions on the board. */
export function placedCells(
  cells: PieceCell[],
  row: number,
  col: number
): Array<{ r: number; c: number; kind: PieceCell["kind"] }> {
  return cells.map((cell) => ({
    r: row + cell.y,
    c: col + cell.x,
    kind: cell.kind,
  }));
}

export function isValidPlacement(
  board: Board,
  cells: PieceCell[],
  row: number,
  col: number
): boolean {
  for (const cell of placedCells(cells, row, col)) {
    if (cell.r < 0 || cell.r >= BOARD_SIZE) return false;
    if (cell.c < 0 || cell.c >= BOARD_SIZE) return false;
    if (board[cell.r][cell.c] !== 0) return false;
  }
  return true;
}

export function applyPlacement(
  board: Board,
  cells: PieceCell[],
  row: number,
  col: number
): Board {
  const next = cloneBoard(board);
  for (const cell of placedCells(cells, row, col)) {
    next[cell.r][cell.c] = cell.kind === "multiplier" ? 2 : 1;
  }
  return next;
}

export type ClearResult = {
  board: Board;
  clearedRows: number[];
  clearedCols: number[];
  clearedSquares: Array<{ sr: number; sc: number }>; // 3x3 sub-square top-left
  multiplierClearedCount: number;
};

/**
 * Apply row/column/3x3-square clears. Returns the new board plus a record of
 * which zones cleared and how many multiplier cells were removed during clears.
 */
export function applyClears(board: Board): ClearResult {
  const fullRows: number[] = [];
  const fullCols: number[] = [];
  const fullSquares: Array<{ sr: number; sc: number }> = [];

  for (let r = 0; r < BOARD_SIZE; r++) {
    if (board[r].every((c) => c !== 0)) fullRows.push(r);
  }
  for (let c = 0; c < BOARD_SIZE; c++) {
    let full = true;
    for (let r = 0; r < BOARD_SIZE; r++) {
      if (board[r][c] === 0) {
        full = false;
        break;
      }
    }
    if (full) fullCols.push(c);
  }
  for (let sr = 0; sr < BOARD_SIZE; sr += 3) {
    for (let sc = 0; sc < BOARD_SIZE; sc += 3) {
      let full = true;
      outer: for (let r = sr; r < sr + 3; r++) {
        for (let c = sc; c < sc + 3; c++) {
          if (board[r][c] === 0) {
            full = false;
            break outer;
          }
        }
      }
      if (full) fullSquares.push({ sr, sc });
    }
  }

  if (fullRows.length === 0 && fullCols.length === 0 && fullSquares.length === 0) {
    return {
      board,
      clearedRows: [],
      clearedCols: [],
      clearedSquares: [],
      multiplierClearedCount: 0,
    };
  }

  // Mark cells to clear
  const toClear: boolean[][] = Array.from({ length: BOARD_SIZE }, () =>
    new Array(BOARD_SIZE).fill(false)
  );
  for (const r of fullRows) {
    for (let c = 0; c < BOARD_SIZE; c++) toClear[r][c] = true;
  }
  for (const c of fullCols) {
    for (let r = 0; r < BOARD_SIZE; r++) toClear[r][c] = true;
  }
  for (const { sr, sc } of fullSquares) {
    for (let r = sr; r < sr + 3; r++) {
      for (let c = sc; c < sc + 3; c++) toClear[r][c] = true;
    }
  }

  let multiplierClearedCount = 0;
  const next = cloneBoard(board);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (toClear[r][c]) {
        if (next[r][c] === 2) multiplierClearedCount++;
        next[r][c] = 0;
      }
    }
  }

  return {
    board: next,
    clearedRows: fullRows,
    clearedCols: fullCols,
    clearedSquares: fullSquares,
    multiplierClearedCount,
  };
}

/** True if at least one of the given pieces can be placed somewhere on the board. */
export function anyPiecePlaceable(
  board: Board,
  pieces: PieceCell[][]
): boolean {
  for (const cells of pieces) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (isValidPlacement(board, cells, r, c)) return true;
      }
    }
  }
  return false;
}
