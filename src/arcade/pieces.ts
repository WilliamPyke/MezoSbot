import type { GeneratedPiece, PieceCell, PieceDefinition } from "./types.js";
import { PIECES_PER_LEVEL, MAX_LEVELS } from "./types.js";
import { PIECE_LIBRARY, PIECE_BY_ID } from "./pieceLibrary.js";
import { createRng, type Rng, pickWeighted } from "./rng.js";

const MULTIPLIER_INJECTION_CHANCE = 0.18;

/** Normalize a piece's cells so the bounding box starts at (0,0). */
export function normalizeCells(cells: PieceCell[]): PieceCell[] {
  const minX = Math.min(...cells.map((c) => c.x));
  const minY = Math.min(...cells.map((c) => c.y));
  return cells.map((c) => ({ x: c.x - minX, y: c.y - minY, kind: c.kind }));
}

/** Rotate cells 90° clockwise: (x, y) -> (y, -x). Then normalize. */
export function rotateCells(cells: PieceCell[], rotation: 0 | 1 | 2 | 3): PieceCell[] {
  let result = cells.map((c) => ({ ...c }));
  for (let i = 0; i < rotation; i++) {
    result = result.map((c) => ({ x: c.y, y: -c.x, kind: c.kind }));
  }
  return normalizeCells(result);
}

export function piecesEqual(a: PieceCell[], b: PieceCell[]): boolean {
  if (a.length !== b.length) return false;
  const key = (c: PieceCell) => `${c.x},${c.y},${c.kind}`;
  const aSet = new Set(a.map(key));
  return b.every((c) => aSet.has(key(c)));
}

/** Boundary box of cells (assumes already normalized). */
export function piecesBounds(cells: PieceCell[]): { width: number; height: number } {
  const maxX = Math.max(...cells.map((c) => c.x));
  const maxY = Math.max(...cells.map((c) => c.y));
  return { width: maxX + 1, height: maxY + 1 };
}

/**
 * Generate the full piece sequence for a match from a seed.
 * Returns `MAX_LEVELS` levels × `PIECES_PER_LEVEL` pieces.
 * Both players in a PvP match get identical output for the same seed.
 */
export function generatePieceSequence(seedNumber: number): GeneratedPiece[][] {
  const rng = createRng(seedNumber);
  const sequence: GeneratedPiece[][] = [];

  for (let level = 0; level < MAX_LEVELS; level++) {
    const levelPieces: GeneratedPiece[] = [];
    for (let i = 0; i < PIECES_PER_LEVEL; i++) {
      const def = pickPieceForLevel(rng, level);
      const cells = maybeInjectMultiplier(rng, def.cells, level);
      levelPieces.push({ defId: def.id, cells });
    }
    sequence.push(levelPieces);
  }

  return sequence;
}

function pickPieceForLevel(rng: Rng, level: number): PieceDefinition {
  const eligible = PIECE_LIBRARY.filter((p) => {
    if (p.minLevel != null && level < p.minLevel) return false;
    if (p.maxLevel != null && level > p.maxLevel) return false;
    return true;
  });
  return pickWeighted(
    rng,
    eligible.map((p) => ({ weight: p.weight, value: p }))
  );
}

function maybeInjectMultiplier(rng: Rng, cells: PieceCell[], level: number): PieceCell[] {
  // Multiplier injection rate scales slightly with level.
  const rate = MULTIPLIER_INJECTION_CHANCE + level * 0.01;
  if (rng() > rate) return cells.map((c) => ({ ...c }));
  if (cells.length === 0) return cells.map((c) => ({ ...c }));
  const idx = Math.floor(rng() * cells.length);
  return cells.map((c, i) => ({ ...c, kind: i === idx ? "multiplier" : "normal" }));
}

export function getPieceDef(id: string): PieceDefinition | undefined {
  return PIECE_BY_ID[id];
}
